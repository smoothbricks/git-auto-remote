import { applyPartial, applyRange, printApplyingLines, printSegmentSummary } from '../lib/apply.js';
import { type ClassifiedCommit, classify, segment } from '../lib/classify.js';
import {
  amInProgress,
  changedPaths,
  commitSubject,
  configAdd,
  configGetAll,
  currentBranch,
  fetchRemote,
  git,
  gitTry,
  isAncestorOf,
  listCommitsInRange,
  revParse,
  workingTreeDirty,
} from '../lib/git.js';
import { runPartialHandler } from '../lib/handler.js';
import { getMirrorConfig, listMirrorConfigs, type MirrorConfig } from '../lib/mirror-config.js';
import {
  clearMirrorInProgress,
  getReviewPending,
  readTrackingRef,
  setMirrorInProgress,
  setReviewPending,
  trackingRefName,
  updateTrackingRef,
} from '../lib/mirror-state.js';

export type MirrorPullOptions = {
  /** Target remote; if omitted, run for every configured mirror in turn. */
  remote?: string;
  /** When true, stop (exit 2) at partials instead of pausing for human review. */
  nonInteractive?: boolean;
  /** Override `fork-remote.<name>.partialHandler` for this invocation. */
  onPartial?: string | null;
};

/**
 * Exit codes:
 *   0 = success (up-to-date, or clean commits applied, or partial paused for review)
 *   1 = error (bad config, dirty tree, network failure, etc.)
 *   2 = stopped (non-interactive hit a partial/conflict that needs human)
 */
export async function mirrorPull(options: MirrorPullOptions): Promise<number> {
  const mirrors = options.remote
    ? [getMirrorConfig(options.remote)].filter((c): c is MirrorConfig => c !== null)
    : listMirrorConfigs();

  if (options.remote && mirrors.length === 0) {
    console.error(`[git-auto-remote] No mirror configured for remote '${options.remote}'.`);
    console.error(`  Configure with: git config fork-remote.${options.remote}.syncPaths "<paths>"`);
    return 1;
  }

  if (mirrors.length === 0) return 0; // nothing to do

  for (const mirror of mirrors) {
    const code = await runOne(mirror, options);
    if (code !== 0) return code;
  }
  return 0;
}

async function runOne(mirror: MirrorConfig, options: MirrorPullOptions): Promise<number> {
  // Skip if we're not on this mirror's target branch.
  const branch = currentBranch();
  if (!branch) {
    console.error(`[mirror ${mirror.remote}] detached HEAD; skip`);
    return 0;
  }
  if (branch !== mirror.syncTargetBranch) {
    // Silent skip: different mirrors have different target branches; not an error.
    return 0;
  }

  // Hard preconditions: no in-progress `git am`, no unresolved review, clean tree.
  if (amInProgress()) {
    console.error(
      `[mirror ${mirror.remote}] 'git am' is in progress; resolve with --continue or --abort first.`,
    );
    return 1;
  }
  const review = getReviewPending();
  if (review && review.remote === mirror.remote) {
    console.error(
      `[mirror ${mirror.remote}] Review pending on ${review.sourceSha.slice(0, 8)} (${review.subject}).`,
    );
    console.error(`  Continue:  git-auto-remote mirror continue ${mirror.remote}`);
    console.error(`  Skip:      git-auto-remote mirror skip ${mirror.remote}`);
    return 1;
  }
  if (workingTreeDirty()) {
    console.error(`[mirror ${mirror.remote}] Working tree is dirty; commit or stash first.`);
    return 1;
  }

  // Ensure the tracking-ref refspec is configured so CI clones receive the state.
  ensureMirrorRefspec(mirror.remote);

  // Fetch latest mirror state.
  try {
    fetchRemote(mirror.remote);
  } catch (e) {
    console.error(`[mirror ${mirror.remote}] fetch failed: ${(e as Error).message}`);
    return 1;
  }

  const last = readTrackingRef(mirror.remote);
  if (!last) {
    console.error(`[mirror ${mirror.remote}] Not bootstrapped. Run:`);
    console.error(`  git-auto-remote mirror bootstrap ${mirror.remote} <sha>`);
    return 1;
  }
  const head = revParse(`refs/remotes/${mirror.remote}/${mirror.syncBranch}`);
  if (!head) {
    console.error(
      `[mirror ${mirror.remote}] Cannot resolve refs/remotes/${mirror.remote}/${mirror.syncBranch}.`,
    );
    return 1;
  }
  if (last === head) {
    // Up to date; nothing to say.
    return 0;
  }
  if (!isAncestorOf(last, head)) {
    // Distinguish "force-push" from "intentional cross-history bootstrap":
    //   - If the two commits share any merge-base, they were once on the same
    //     history line and `last` has fallen off -> force-push, refuse.
    //   - If they have no merge-base, `last` is on a disjoint history (e.g. a
    //     commit from the local side bootstrapped into the mirror's tracking
    //     ref) -> cross-history bootstrap, proceed and replay everything.
    const mergeBase = gitTry('merge-base', last, head);
    if (mergeBase) {
      console.error(
        `[mirror ${mirror.remote}] Tracking ref ${last.slice(0, 8)} is not an ancestor of ${head.slice(0, 8)}.`,
      );
      console.error(`  The mirror was likely force-pushed. Re-bootstrap with:`);
      console.error(`    git-auto-remote mirror bootstrap ${mirror.remote} <sha>`);
      return 1;
    }
    // No common ancestor: tracking ref is on a disjoint history (typical for
    // first-time bootstrap across a fork boundary). Everything on the mirror
    // is "new" relative to tracking - that's exactly what we want to replay.
  }

  // Enumerate + classify commits.
  const pathSpec = {
    syncPaths: mirror.syncPaths,
    excludePaths: mirror.excludePaths,
    reviewPaths: mirror.reviewPaths,
  };
  const shas = listCommitsInRange(last, head);
  const classified: ClassifiedCommit[] = shas.map((sha) => ({
    sha,
    classification: classify(changedPaths(sha), pathSpec),
  }));
  const segments = segment(classified);

  let applied = 0;
  let skipped = 0;

  for (const seg of segments) {
    if (seg.kind === 'range') {
      printApplyingLines(seg.commits, mirror.remote);
      setMirrorInProgress(mirror.remote);
      const result = applyRange(seg.commits, mirror.syncPaths, mirror.excludePaths);
      // IMPORTANT: on 'conflict' we leave the sentinel set so that when the user
      // resolves + `git am --continue`, our post-applypatch hook still recognizes
      // the in-progress am as ours and advances the tracking ref per patch.
      // post-applypatch clears the sentinel after the last patch of the run.
      if (result === 'applied') clearMirrorInProgress();
      if (result === 'conflict') {
        // `git am` stopped; leave it for the user (or abort in CI mode).
        if (options.nonInteractive) {
          git('am', '--abort');
          printSegmentSummary(mirror.remote, applied, skipped, 'conflict');
          return 2;
        }
        console.error(
          `[mirror ${mirror.remote}] Conflict during apply. Resolve with 'git am --continue' or 'git am --abort', then re-run 'mirror pull'.`,
        );
        return 1;
      }
      if (result === 'error') {
        console.error(`[mirror ${mirror.remote}] Unexpected apply error.`);
        return 1;
      }
      // Advance tracking ref to the last commit in this range. This is the
      // authoritative update; the post-applypatch hook advances per-patch but
      // may not be running (e.g. in tests or offline bunx). Safe to set idempotently.
      updateTrackingRef(mirror.remote, seg.commits[seg.commits.length - 1].sha);
      // Count what we applied vs skipped.
      for (const c of seg.commits) {
        if (c.classification.kind === 'out-of-scope') skipped += 1;
        else applied += 1;
      }
    } else {
      // partial
      const partialResult = await handlePartial(seg.commit, mirror, options);
      if (partialResult.kind === 'applied') {
        applied += 1;
      } else if (partialResult.kind === 'skipped') {
        skipped += 1;
      } else if (partialResult.kind === 'paused') {
        printSegmentSummary(mirror.remote, applied + 1, skipped, 'partial');
        return 0; // pause cleanly
      } else if (partialResult.kind === 'stopped') {
        printSegmentSummary(mirror.remote, applied, skipped, 'partial');
        return 2;
      } else {
        return 1;
      }
    }
  }

  // All segments applied cleanly.
  if (mirror.pushSyncRef) {
    try {
      git('push', '--quiet', mirror.remote, `${trackingRefName(mirror.remote)}:${trackingRefName(mirror.remote)}`);
    } catch {
      console.error(
        `[mirror ${mirror.remote}] Warning: failed to push tracking ref; state not durable across fresh clones.`,
      );
    }
  }

  if (applied > 0 || skipped > 0) {
    printSegmentSummary(mirror.remote, applied, skipped, 'done');
  }
  return 0;
}

type PartialResult =
  | { kind: 'applied' }
  | { kind: 'skipped' }
  | { kind: 'paused' }
  | { kind: 'stopped' }
  | { kind: 'error' };

async function handlePartial(
  commit: ClassifiedCommit,
  mirror: MirrorConfig,
  options: MirrorPullOptions,
): Promise<PartialResult> {
  if (commit.classification.kind !== 'partial') return { kind: 'error' };
  const { included, excluded, reviewRequired } = commit.classification;
  const subject = commitSubject(commit.sha);
  const handler = options.onPartial ?? mirror.partialHandler;

  console.error(`[mirror ${mirror.remote}] Partial: ${subject} (${commit.sha.slice(0, 8)})`);
  if (excluded.length > 0) {
    console.error(`  Excluded paths: ${excluded.join(', ')}`);
  }
  if (reviewRequired.length > 0) {
    console.error(`  Review-required paths: ${reviewRequired.join(', ')}`);
  }

  // In --non-interactive mode without a handler, do NOT apply. Advancing the
  // ref here would silently lose the commit on the next run; leaving both HEAD
  // and the tracking ref untouched means CI will surface the same partial until
  // a human handles it.
  if (options.nonInteractive && !handler) {
    return { kind: 'stopped' };
  }

  // Record where we started so we can rewind precisely on handler-punt.
  const trackingBefore = readTrackingRef(mirror.remote);

  // Apply the in-scope subset.
  setMirrorInProgress(mirror.remote);
  const applyResult = applyPartial(commit.sha, mirror.syncPaths, mirror.excludePaths);
  // Same rule as applyRange: keep the sentinel set on conflict so post-applypatch
  // on the user's `git am --continue` updates the tracking ref.
  if (applyResult === 'applied') clearMirrorInProgress();
  if (applyResult !== 'applied') {
    if (applyResult === 'conflict') {
      if (options.nonInteractive) {
        git('am', '--abort');
        return { kind: 'stopped' };
      }
      console.error(
        `[mirror ${mirror.remote}] Conflict applying partial. Resolve with git am, then re-run mirror pull.`,
      );
      return { kind: 'error' };
    }
    return { kind: 'error' };
  }

  // Advance tracking ref to this partial's source SHA. Skip/punt paths below
  // may rewind it again.
  updateTrackingRef(mirror.remote, commit.sha);

  if (handler) {
    console.error(`[mirror ${mirror.remote}]   invoking handler: ${handler}`);
    const outcome = runPartialHandler(handler, {
      remote: mirror.remote,
      sourceSha: commit.sha,
      sourceSubject: subject,
      includedPaths: included,
      excludedPaths: excluded,
    });
    if (outcome === 'resolved') {
      console.error(`[mirror ${mirror.remote}]   handler exit=0 (resolved)`);
      return { kind: 'applied' };
    }
    if (outcome === 'skipped') {
      console.error(`[mirror ${mirror.remote}]   handler exit=2 (skip)`);
      // Drop the applied subset; tracking ref already points at this commit's
      // SHA so next run resumes past it.
      git('reset', '--hard', 'HEAD~1');
      return { kind: 'skipped' };
    }
    if (outcome === 'dirty-tree') {
      console.error(
        `[mirror ${mirror.remote}]   handler left working tree dirty; aborting for safety.`,
      );
      return { kind: 'error' };
    }
    // punted: rewind the ref so the partial is surfaced again next run.
    console.error(`[mirror ${mirror.remote}]   handler punted`);
    if (options.nonInteractive) {
      git('reset', '--hard', 'HEAD~1');
      if (trackingBefore) updateTrackingRef(mirror.remote, trackingBefore);
      return { kind: 'stopped' };
    }
    // fall through: interactive review
  }

  // Interactive, no handler (or handler punted): pause for human review. The
  // partial stays committed in HEAD, tracking ref stays advanced, marker
  // records state for `mirror continue` / `mirror skip`.
  setReviewPending({
    remote: mirror.remote,
    sourceSha: commit.sha,
    subject,
    included,
    excluded,
    reviewRequired,
  });
  console.error(``);
  console.error(`  Review:    git show HEAD`);
  console.error(`  Amend:     git commit --amend    (optionally include excluded content)`);
  console.error(`  Continue:  git-auto-remote mirror continue ${mirror.remote}`);
  console.error(`  Skip:      git-auto-remote mirror skip ${mirror.remote}`);
  return { kind: 'paused' };
}

/**
 * Ensure `refs/git-auto-remote/mirror/*` is fetched from the given remote,
 * so the tracking ref is replicated server-side and fresh CI clones can see it.
 * Idempotent.
 */
function ensureMirrorRefspec(remote: string): void {
  const key = `remote.${remote}.fetch`;
  const wanted = '+refs/git-auto-remote/mirror/*:refs/git-auto-remote/mirror/*';
  const existing = configGetAll(key);
  if (!existing.includes(wanted)) {
    configAdd(key, wanted);
  }
}
