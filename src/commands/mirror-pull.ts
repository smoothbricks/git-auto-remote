import { spawnSync } from 'node:child_process';
import {
  applyPartial,
  applyRange,
  applyReviewToWorktree,
  printApplyingLines,
  printSegmentSummary,
} from '../lib/apply.js';
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
  hasStagedChanges,
  isAncestorOf,
  listCommitsInRange,
  readCommitMeta,
  revParse,
  workingTreeDirty,
} from '../lib/git.js';
import { runPartialHandler } from '../lib/handler.js';
import { getMirrorConfig, listMirrorConfigs, type MirrorConfig } from '../lib/mirror-config.js';
import {
  clearMirrorInProgress,
  clearPendingCommit,
  clearReviewPending,
  getReviewPending,
  readTrackingRef,
  setMirrorInProgress,
  setPendingCommit,
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
      `[mirror ${mirror.remote}] 'git am' is in progress; resolve with 'mirror continue' or 'mirror skip' first.`,
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
      const result = applyRange(
        seg.commits,
        mirror.syncPaths,
        mirror.excludePaths,
        mirror.reviewPaths,
      );
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
          `[mirror ${mirror.remote}] Conflict during apply. Resolve the conflicts, git add, then one of:`,
        );
        console.error(`    git-auto-remote mirror continue ${mirror.remote}`);
        console.error(`    git-auto-remote mirror skip     ${mirror.remote}   # drop this commit`);
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

/**
 * A partial commit is classified into one of three sub-cases at runtime:
 *
 *   A. included non-empty, `git am` conflicts           -> phase = am-in-progress
 *   B. included non-empty, `git am` applies cleanly,    -> phase = review-pause
 *      review non-empty OR outside non-empty
 *   C. included EMPTY, review non-empty                 -> phase = pure-review-pause
 *
 * Sub-cases B and C are surfaced identically to the user (worktree has review
 * content unstaged, outside paths listed); they differ only in whether
 * `mirror continue` amends an existing HEAD (B) or creates a new commit (C).
 * Sub-case A resolves via the user's `git am --continue`/`git am --skip`
 * equivalents (`mirror continue`/`mirror skip`), which then fall through into
 * sub-case B if the source had review content.
 */
async function handlePartial(
  commit: ClassifiedCommit,
  mirror: MirrorConfig,
  options: MirrorPullOptions,
): Promise<PartialResult> {
  if (commit.classification.kind !== 'partial') return { kind: 'error' };
  const { included, review, outside } = commit.classification;
  const subject = commitSubject(commit.sha);
  const handler = options.onPartial ?? mirror.partialHandler;

  // In --non-interactive mode without a handler, do NOT apply. Advancing the
  // ref here would silently lose the commit on the next run; leaving both HEAD
  // and the tracking ref untouched means CI will surface the same partial until
  // a human handles it.
  if (options.nonInteractive && !handler) {
    printPartialHeader(mirror.remote, subject, commit.sha, review, outside);
    return { kind: 'stopped' };
  }

  // Record where tracking started so handler-punt can rewind precisely.
  const trackingBefore = readTrackingRef(mirror.remote);

  // ----- Sub-case C: pure-review-only commit (included is empty) -----
  if (included.length === 0) {
    return handlePureReview(commit.sha, subject, review, outside, mirror, options, trackingBefore);
  }

  // ----- Sub-case A/B: included non-empty. Apply included subset via `git am`. -----
  printPartialHeader(mirror.remote, subject, commit.sha, review, outside);

  setMirrorInProgress(mirror.remote);
  const applyResult = applyPartial(
    commit.sha,
    mirror.syncPaths,
    mirror.excludePaths,
    mirror.reviewPaths,
  );

  if (applyResult === 'conflict') {
    // Sub-case A. Record state so `mirror continue` knows to transition to
    // phase `review-pause` (and overlay review content) after `git am --continue`.
    // Leave sentinel set: post-applypatch will advance the tracking ref when
    // the user resolves and continues.
    setReviewPending({
      remote: mirror.remote,
      sourceSha: commit.sha,
      subject,
      included,
      review,
      outside,
      phase: 'am-in-progress',
    });
    if (options.nonInteractive) {
      git('am', '--abort');
      clearMirrorInProgress();
      // Remove the marker we just set: nothing to continue to in CI (a human
      // would have to `mirror continue` to transition it anyway).
      clearReviewPending();
      return { kind: 'stopped' };
    }
    console.error(
      `[mirror ${mirror.remote}] Conflict applying partial. Resolve the conflicts, git add, then one of:`,
    );
    console.error(`    git-auto-remote mirror continue ${mirror.remote}`);
    console.error(`    git-auto-remote mirror skip     ${mirror.remote}   # drop this commit`);
    return { kind: 'error' };
  }
  if (applyResult === 'error') {
    clearMirrorInProgress();
    return { kind: 'error' };
  }
  // applyResult === 'applied' - included subset landed in HEAD with preserved
  // author + author-date. Post-applypatch advanced the tracking ref. Clear
  // sentinel (handler and user will see a clean "am not in progress" state).
  clearMirrorInProgress();
  // Belt + suspenders: advance tracking ref explicitly in case the hook isn't
  // installed (e.g. tests, offline bunx).
  updateTrackingRef(mirror.remote, commit.sha);

  // If a handler is configured: worktree gets review overlay first, then handler runs.
  if (handler) {
    if (review.length > 0) {
      const overlay = applyReviewToWorktree(commit.sha, review, mirror.excludePaths);
      if (overlay === 'error') {
        console.error(`[mirror ${mirror.remote}] Failed to apply review overlay to worktree.`);
        return { kind: 'error' };
      }
      // 'conflict' leaves conflict markers; handler is free to resolve.
    }
    console.error(`[mirror ${mirror.remote}]   invoking handler: ${handler}`);
    const outcome = runPartialHandler(handler, {
      remote: mirror.remote,
      sourceSha: commit.sha,
      sourceSubject: subject,
      includedPaths: included,
      reviewPaths: review,
      outsidePaths: outside,
    });
    if (outcome === 'resolved') {
      console.error(`[mirror ${mirror.remote}]   handler exit=0 (resolved)`);
      return { kind: 'applied' };
    }
    if (outcome === 'skipped') {
      console.error(`[mirror ${mirror.remote}]   handler exit=2 (skip)`);
      // Discard review overlay + drop the HEAD commit the applyPartial created.
      if (review.length > 0) {
        gitTry('checkout', '--', ...review);
      }
      git('reset', '--hard', 'HEAD~1');
      return { kind: 'skipped' };
    }
    if (outcome === 'dirty-tree') {
      console.error(
        `[mirror ${mirror.remote}]   handler left working tree dirty; aborting for safety.`,
      );
      return { kind: 'error' };
    }
    // punted: rewind HEAD + tracking, surface next run.
    console.error(`[mirror ${mirror.remote}]   handler punted`);
    if (options.nonInteractive) {
      if (review.length > 0) gitTry('checkout', '--', ...review);
      git('reset', '--hard', 'HEAD~1');
      if (trackingBefore) updateTrackingRef(mirror.remote, trackingBefore);
      return { kind: 'stopped' };
    }
    // fall through: interactive review (HEAD stays at partial; tracking at source)
  }

  // Sub-case B: pause for human review. Overlay review content to worktree
  // (if handler didn't already do it).
  if (!handler && review.length > 0) {
    const overlay = applyReviewToWorktree(commit.sha, review, mirror.excludePaths);
    if (overlay === 'conflict') {
      console.error(
        `[mirror ${mirror.remote}]   (some review-path hunks left conflict markers; resolve before continuing)`,
      );
    } else if (overlay === 'error') {
      console.error(
        `[mirror ${mirror.remote}]   (failed to overlay review paths; inspect with: git show ${commit.sha.slice(0, 8)})`,
      );
    }
  }

  setReviewPending({
    remote: mirror.remote,
    sourceSha: commit.sha,
    subject,
    included,
    review,
    outside,
    phase: 'review-pause',
  });
  printPartialFooter(mirror.remote, review.length > 0);
  return { kind: 'paused' };
}

/**
 * Sub-case C: the source commit touched ONLY review paths (included is empty
 * after filtering out excludePaths too). No `git am` happens; the commit's
 * metadata is captured for `mirror continue` to use when the user stages
 * review content and proceeds (or discarded entirely on `mirror skip`).
 *
 * Tracking ref advances to `sha` at pause time: a subsequent `mirror continue`
 * that results in no commit still lands at "past this source", equivalent to
 * a discard. `mirror skip` leaves the ref advanced too (nothing to rewind).
 */
function handlePureReview(
  sha: string,
  subject: string,
  review: readonly string[],
  outside: readonly string[],
  mirror: MirrorConfig,
  options: MirrorPullOptions,
  _trackingBefore: string | null,
): PartialResult {
  const handler = options.onPartial ?? mirror.partialHandler;
  printPartialHeader(mirror.remote, subject, sha, review, outside);

  // Apply review overlay now so handler / user can see and manipulate.
  const overlay = applyReviewToWorktree(sha, review, mirror.excludePaths);
  if (overlay === 'error') {
    console.error(`[mirror ${mirror.remote}] Failed to apply review overlay to worktree.`);
    return { kind: 'error' };
  }

  // Capture source metadata for a potential re-commit on continue.
  const meta = readCommitMeta(sha);
  setPendingCommit({
    remote: mirror.remote,
    sourceSha: sha,
    authorName: meta.authorName,
    authorEmail: meta.authorEmail,
    authorDate: meta.authorDate,
    message: meta.message,
  });

  if (handler) {
    console.error(`[mirror ${mirror.remote}]   invoking handler: ${handler}`);
    const outcome = runPartialHandler(handler, {
      remote: mirror.remote,
      sourceSha: sha,
      sourceSubject: subject,
      includedPaths: [],
      reviewPaths: review,
      outsidePaths: outside,
    });
    if (outcome === 'resolved') {
      // Handler indicated success. If the index has staged content, create a
      // commit with preserved author+date; otherwise just advance tracking.
      return finalizePureReviewAsResolved(sha, meta, mirror.remote);
    }
    if (outcome === 'skipped') {
      // Discard worktree + advance tracking past source.
      if (review.length > 0) gitTry('checkout', '--', ...review);
      clearPendingCommit();
      updateTrackingRef(mirror.remote, sha);
      console.error(`[mirror ${mirror.remote}]   handler exit=2 (skip)`);
      return { kind: 'skipped' };
    }
    if (outcome === 'dirty-tree') {
      // Handler didn't cleanly commit but left staged/worktree changes. Abort.
      console.error(
        `[mirror ${mirror.remote}]   handler left working tree dirty; aborting for safety.`,
      );
      return { kind: 'error' };
    }
    // punted
    console.error(`[mirror ${mirror.remote}]   handler punted`);
    if (options.nonInteractive) {
      if (review.length > 0) gitTry('checkout', '--', ...review);
      clearPendingCommit();
      return { kind: 'stopped' };
    }
    // fall through to interactive pause
  }

  // Interactive pause: tracking advances to this SHA eagerly (same logic as
  // sub-case B). `mirror continue`/`mirror skip` don't need to rewind - either
  // creates a commit past source or just moves on.
  updateTrackingRef(mirror.remote, sha);
  setReviewPending({
    remote: mirror.remote,
    sourceSha: sha,
    subject,
    included: [],
    review,
    outside,
    phase: 'pure-review-pause',
  });
  printPartialFooter(mirror.remote, review.length > 0);
  return { kind: 'paused' };
}

function finalizePureReviewAsResolved(
  sha: string,
  meta: { authorName: string; authorEmail: string; authorDate: string; message: string },
  remote: string,
): PartialResult {
  // If the handler created a commit itself, HEAD moved and we just advance tracking.
  // If index has staged content, make the commit with preserved metadata.
  // If neither, advance tracking (treat as "no-op, move on").
  if (hasStagedChanges()) {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: meta.authorName,
      GIT_AUTHOR_EMAIL: meta.authorEmail,
      GIT_AUTHOR_DATE: meta.authorDate,
    };
    const r = spawnSync('git', ['commit', '-q', '-m', meta.message], {
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (r.status !== 0) {
      console.error(`[mirror ${remote}]   failed to create preserved-metadata commit`);
      return { kind: 'error' };
    }
  }
  clearPendingCommit();
  updateTrackingRef(remote, sha);
  console.error(`[mirror ${remote}]   handler exit=0 (resolved)`);
  return { kind: 'applied' };
}

function printPartialHeader(
  remote: string,
  subject: string,
  sha: string,
  review: readonly string[],
  outside: readonly string[],
): void {
  console.error(`[mirror ${remote}] Partial: ${subject} (${sha.slice(0, 8)})`);
  if (review.length > 0) {
    console.error(`  Review (in worktree, unstaged): ${review.join(', ')}`);
  }
  if (outside.length > 0) {
    console.error(`  Outside sync scope (dropped):   ${outside.join(', ')}`);
  }
}

function printPartialFooter(remote: string, hasReview: boolean): void {
  console.error(``);
  if (hasReview) {
    console.error(`  Review:    git diff                       # see unstaged review content`);
    console.error(`  Stage:     git add -p                     # pick hunks into the commit`);
    console.error(`  Discard:   git restore <paths>            # drop review hunks`);
  } else {
    console.error(`  Review:    git show HEAD`);
  }
  console.error(`  Continue:  git-auto-remote mirror continue ${remote}`);
  console.error(`  Skip:      git-auto-remote mirror skip ${remote}`);
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
