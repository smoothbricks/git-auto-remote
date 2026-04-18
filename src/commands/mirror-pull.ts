import { spawnSync } from 'node:child_process';
import {
  applyPartial,
  applyRange,
  applyReviewToWorktree,
  printApplyingLines,
  printSegmentSummary,
} from '../lib/apply.js';
import { anyHasRegenerate, type ClassifiedCommit, classify, segment } from '../lib/classify.js';
import {
  amInProgress,
  changedPaths,
  commitSubject,
  currentBranch,
  fetchRemote,
  git,
  gitTry,
  hasStagedChanges,
  hasUnresolvedMergeConflicts,
  isAncestorOf,
  listCommitsInRange,
  readCommitMeta,
  readCurrentPatchSha,
  revParse,
  workingTreeDirty,
} from '../lib/git.js';
import { runPartialHandler } from '../lib/handler.js';
import { getMirrorConfig, listMirrorConfigs, type MirrorConfig } from '../lib/mirror-config.js';
import { runRegenerate } from '../lib/regen.js';
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
  /** Override `auto-remote.<name>.partialHandler` for this invocation. */
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
    console.error(`  Configure with: git config auto-remote.${options.remote}.syncPaths "<paths>"`);
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
    console.error(`[mirror ${mirror.remote}] Review pending on ${review.sourceSha.slice(0, 8)} (${review.subject}).`);
    console.error(`  Continue:  git-auto-remote mirror continue ${mirror.remote}`);
    console.error(`  Skip:      git-auto-remote mirror skip ${mirror.remote}`);
    return 1;
  }
  if (workingTreeDirty()) {
    console.error(`[mirror ${mirror.remote}] Working tree is dirty; commit or stash first.`);
    return 1;
  }

  // Fetch latest mirror state.
  //
  // Pre-v0.6.1 we also called ensureMirrorRefspec(remote) here to add
  // `+refs/git-auto-remote/mirror/*:refs/git-auto-remote/mirror/*` to the
  // remote's fetch refspec, with the intent of "replicating tracking ref
  // state server-side so fresh CI clones can see it". The implementation
  // was actively wrong: with the leading `+`, every `git fetch` FORCE-
  // overwrote the local tracking ref with the remote's value. The local
  // clone is the AUTHORITY for its own mirror tracking state - if a
  // different clone (e.g. CI) had pushed an updated ref to the remote,
  // our local rolled-back / behind state was silently clobbered, and
  // the pull then computed `last == head` and exited 0 with zero output,
  // skipping all in-range commits. The "replication" intent is correctly
  // expressed via PUSH refspec (callers configure
  // `remote.<X>.push = refs/git-auto-remote/mirror/*:...`), not fetch.
  // See test/mirror-pull.integration.test.ts -> 'v0.6.1 regression'.
  //
  // v0.6.3: pass an EXPLICIT narrow refspec to `git fetch`. Even after
  // v0.6.1 stopped auto-adding the bad mirror refspec, leftover config
  // from pre-v0.6.1 clones OR CI scripts that re-add it can still clobber
  // our tracking ref on every fetch. Passing an explicit refspec causes
  // git to ignore ALL configured `remote.<X>.fetch` entries for this
  // invocation, so mirror pull is immune to whatever the user has
  // configured. We only need the syncBranch for our own range computation;
  // updating other refs/remotes/<remote>/* is the user's concern (they can
  // still run a plain `git fetch <remote>` for that).
  // See test/mirror-pull.integration.test.ts -> 'v0.6.3 regression'.
  try {
    fetchRemote(mirror.remote, `+refs/heads/${mirror.syncBranch}:refs/remotes/${mirror.remote}/${mirror.syncBranch}`);
  } catch (e) {
    console.error(`[mirror ${mirror.remote}] fetch failed: ${(e as Error).message}`);
    return 1;
  }

  const last = readTrackingRef(mirror.remote);
  const head = revParse(`refs/remotes/${mirror.remote}/${mirror.syncBranch}`);
  if (!head) {
    console.error(`[mirror ${mirror.remote}] Cannot resolve refs/remotes/${mirror.remote}/${mirror.syncBranch}.`);
    return 1;
  }
  if (last === head) {
    // Up to date; nothing to say.
    return 0;
  }
  if (last && !isAncestorOf(last, head)) {
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
    regeneratePaths: mirror.regeneratePaths,
  };
  const shas = listCommitsInRange(last, head);
  if (!last && shas.length > 0) {
    // No tracking ref = full-history replay. Let the user know what they're
    // in for (as opposed to "up to date" ambiguity if this is silent).
    console.error(
      `[mirror ${mirror.remote}] No tracking ref set; starting full-history replay from the mirror's root (${shas.length} commits).`,
    );
  }
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
        mirror.regeneratePaths,
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
        printAmStopMessage(mirror.remote);
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
      // Run regenerate if any commit in this range touched regeneratePaths.
      // The trigger is "upstream bumped the derived file" - we drop their
      // version from the patch and produce ours locally. Commits that don't
      // touch regeneratePaths don't need regen (their inputs either didn't
      // change the derived output or will be handled the next time the user
      // runs their normal install/build workflow).
      //
      // v0.5.9: propagate command-failed as hard error. Silent skip used to
      // cause stale derived state to compound across commits.
      if (mirror.regenerateCommand && mirror.regeneratePaths.length > 0 && anyHasRegenerate(seg.commits)) {
        const regenResult = runRegenerate(mirror.regenerateCommand, mirror.regeneratePaths, mirror.remote, 'amend');
        if (regenResult.outcome === 'command-failed') {
          console.error(`[mirror ${mirror.remote}] regenerate command failed after applying range; halting.`);
          console.error(`[mirror ${mirror.remote}]   HEAD is at the last applied commit (un-amended for regen).`);
          console.error(
            `[mirror ${mirror.remote}]   Fix the command, then manually run it + 'git commit --amend --no-edit'`,
          );
          console.error(`[mirror ${mirror.remote}]   and re-run 'mirror pull' to continue.`);
          return 1;
        }
      }
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
  const { included, review, regenerate, outside } = commit.classification;
  const subject = commitSubject(commit.sha);
  const handler = options.onPartial ?? mirror.partialHandler;

  // In --non-interactive mode without a handler, do NOT apply - leaving both
  // HEAD and the tracking ref untouched means CI will surface the same
  // partial until a human handles it.
  //
  // EXCEPTION (v0.5.8): when review bucket is empty, a "partial" commit has
  // nothing for a human to decide - included can land via `git am`,
  // regenerate can amend, outside is dropped. Stopping here would force a
  // human round-trip for no reason. Fall through to auto-apply (the
  // review=[] short-circuit after the `git am` step handles the actual
  // auto-apply and emits the one-line note).
  if (options.nonInteractive && !handler && review.length > 0) {
    printPartialHeader(mirror.remote, subject, commit.sha, review, regenerate, outside);
    return { kind: 'stopped' };
  }

  // Record where tracking started so handler-punt can rewind precisely.
  const trackingBefore = readTrackingRef(mirror.remote);

  // ----- Sub-case C: pure-review-only commit (included is empty) -----
  if (included.length === 0) {
    return handlePureReview(commit.sha, subject, review, regenerate, outside, mirror, options, trackingBefore);
  }

  // ----- Sub-case A/B: included non-empty. Apply included subset via `git am`. -----
  // Header is printed AFTER we know whether we'll pause. If the commit will
  // auto-apply (empty review - see below), we emit the concise one-line
  // auto-apply note instead of the full multi-line Partial: header+footer.
  // Printing the full header eagerly here would produce confusing dual
  // messaging for the auto-apply case.
  const willPause = review.length > 0;
  if (willPause) {
    printPartialHeader(mirror.remote, subject, commit.sha, review, regenerate, outside);
  }

  setMirrorInProgress(mirror.remote);
  const applyResult = applyPartial(
    commit.sha,
    mirror.syncPaths,
    mirror.excludePaths,
    mirror.reviewPaths,
    mirror.regeneratePaths,
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
      regenerate,
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
    printAmStopMessage(mirror.remote);
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

  // Run regenerate BEFORE the review overlay (if the source commit touched
  // any regeneratePaths) so HEAD reflects included + regen, and the worktree
  // shows only the review content as unstaged.
  //
  // v0.5.9: propagate command-failed as hard error (see runRegenerate docs).
  if (mirror.regenerateCommand && mirror.regeneratePaths.length > 0 && regenerate.length > 0) {
    const regenResult = runRegenerate(mirror.regenerateCommand, mirror.regeneratePaths, mirror.remote, 'amend');
    if (regenResult.outcome === 'command-failed') {
      console.error(
        `[mirror ${mirror.remote}] regenerate command failed on partial ${commit.sha.slice(0, 8)}; halting.`,
      );
      console.error(`[mirror ${mirror.remote}]   HEAD has the included subset un-amended. Fix the command, manually`);
      console.error(`[mirror ${mirror.remote}]   run it + 'git commit --amend --no-edit', then re-run 'mirror pull'.`);
      return { kind: 'error' };
    }
  }

  // v0.5.8: empty review bucket = nothing for a human (or handler) to decide.
  //   - `included` already landed in HEAD via `git am` with preserved metadata.
  //   - `regenerate` already amended into HEAD (if any regeneratePaths matched).
  //   - `outside` was dropped from the patch by construction.
  // Pausing here would force the user to `mirror continue` with zero staging
  // work. Handler invocation is equally pointless: its outcomes (resolved,
  // skipped, punted, dirty-tree) all presuppose review content to adjudicate.
  // Users who want a "partial was auto-applied" hook regardless should use
  // post-applypatch.
  //
  // Emit a concise one-line note (matches `printPartialHeader` format) so the
  // user has visibility into what was dropped / regenerated without the full
  // multi-line pause framing.
  if (review.length === 0) {
    console.error(`[mirror ${mirror.remote}] Partial auto-applied: ${commit.sha.slice(0, 8)}  ${subject}`);
    if (regenerate.length > 0) {
      console.error(`  Regenerated: ${regenerate.join(', ')}`);
    }
    if (outside.length > 0) {
      console.error(`  Outside (dropped): ${outside.join(', ')}`);
    }
    return { kind: 'applied' };
  }

  // If a handler is configured: worktree gets review overlay first, then handler runs.
  if (handler) {
    if (review.length > 0) {
      const overlay = applyReviewToWorktree(commit.sha, review, mirror.excludePaths);
      if (overlay === 'error') {
        console.error(`[mirror ${mirror.remote}] Failed to apply review overlay to worktree.`);
        return { kind: 'error' };
      }
      // 'conflict' leaves conflict markers; handler is free to resolve.
      // 'fallback' wrote source-verbatim; handler sees full delta, its own concern.
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
      console.error(`[mirror ${mirror.remote}]   handler left working tree dirty; aborting for safety.`);
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
    if (overlay === 'error') {
      console.error(
        `[mirror ${mirror.remote}]   (failed to overlay review paths; inspect with: git show ${commit.sha.slice(0, 8)})`,
      );
    } else {
      printOverlayNote(mirror.remote, overlay);
    }
  }

  setReviewPending({
    remote: mirror.remote,
    sourceSha: commit.sha,
    subject,
    included,
    review,
    regenerate,
    outside,
    phase: 'review-pause',
  });
  printPartialFooter(mirror.remote, review.length > 0, commit.sha, subject);
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
  regenerate: readonly string[],
  outside: readonly string[],
  mirror: MirrorConfig,
  options: MirrorPullOptions,
  _trackingBefore: string | null,
): PartialResult {
  const handler = options.onPartial ?? mirror.partialHandler;

  // v0.5.9 INVARIANT: if source commit touches regenerate paths, regen MUST
  // run - regardless of sub-case. Run it FIRST (before any pause / commit
  // synthesis decisions) in stage-only mode: the inside-scope content is
  // staged but not committed; the caller (this function) decides whether
  // to commit it with source metadata (empty-review) or leave it staged
  // for `mirror continue` to pick up alongside user-staged review hunks
  // (pure-review-pause).
  let regenStaged = false;
  if (regenerate.length > 0 && mirror.regenerateCommand) {
    const regenResult = runRegenerate(mirror.regenerateCommand, mirror.regeneratePaths, mirror.remote, 'stage-only');
    if (regenResult.outcome === 'command-failed') {
      console.error(`[mirror ${mirror.remote}] regenerate command failed on ${sha.slice(0, 8)}; halting.`);
      console.error(`[mirror ${mirror.remote}]   No HEAD commit was created. State is clean - fix the regenerate`);
      console.error(`[mirror ${mirror.remote}]   command and re-run 'mirror pull'.`);
      return { kind: 'error' };
    }
    regenStaged = regenResult.staged;
  }

  // Sub-case C.1: empty review bucket (Conloca 0c18e179 shape). Everything is
  // mechanical now - no human decision. Synthesize a commit with source
  // metadata if regen produced content, else just advance tracking. Handler
  // is skipped (consistent with the sub-case B empty-review invariant).
  if (review.length === 0) {
    if (regenStaged) {
      const meta = readCommitMeta(sha);
      // v0.6.0: committer = author across all commits this tool creates.
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: meta.authorName,
        GIT_AUTHOR_EMAIL: meta.authorEmail,
        GIT_AUTHOR_DATE: meta.authorDate,
        GIT_COMMITTER_NAME: meta.authorName,
        GIT_COMMITTER_EMAIL: meta.authorEmail,
        GIT_COMMITTER_DATE: meta.authorDate,
      };
      const commitResult = spawnSync('git', ['commit', '-q', '-m', meta.message], {
        env,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      if ((commitResult.status ?? 0) !== 0) {
        console.error(
          `[mirror ${mirror.remote}] failed to synthesize regenerate-only commit for ${sha.slice(0, 8)}; halting.`,
        );
        return { kind: 'error' };
      }
      updateTrackingRef(mirror.remote, sha);
      console.error(
        `[mirror ${mirror.remote}] Partial auto-applied: ${sha.slice(0, 8)}  ${subject}  (regenerate only)`,
      );
      if (regenerate.length > 0) {
        console.error(`  Regenerated: ${regenerate.join(', ')}`);
      }
      if (outside.length > 0) {
        console.error(`  Outside (dropped): ${outside.join(', ')}`);
      }
      return { kind: 'applied' };
    }
    // No regen staged: either no regenerate paths, or regen was a no-op.
    updateTrackingRef(mirror.remote, sha);
    const qualifier = regenerate.length > 0 ? '(non-sync only, no regen delta)' : '(non-sync only, no regenerate)';
    console.error(`[mirror ${mirror.remote}] Partial auto-applied: ${sha.slice(0, 8)}  ${subject}  ${qualifier}`);
    if (outside.length > 0) {
      console.error(`  Outside (dropped): ${outside.join(', ')}`);
    }
    return { kind: 'skipped' };
  }

  // Sub-case C.2: review bucket non-empty. Regen (if any) is already staged.
  // Overlay review content UNSTAGED on top. `mirror continue` will call
  // `continuePureReviewPause` which commits the full index (regen + user-staged
  // review hunks) as ONE commit with source metadata.
  printPartialHeader(mirror.remote, subject, sha, review, regenerate, outside);

  // Apply review overlay now so handler / user can see and manipulate.
  const overlay = applyReviewToWorktree(sha, review, mirror.excludePaths);
  if (overlay === 'error') {
    console.error(`[mirror ${mirror.remote}] Failed to apply review overlay to worktree.`);
    return { kind: 'error' };
  }
  printOverlayNote(mirror.remote, overlay);

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
      console.error(`[mirror ${mirror.remote}]   handler left working tree dirty; aborting for safety.`);
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
    regenerate,
    outside,
    phase: 'pure-review-pause',
  });
  printPartialFooter(mirror.remote, review.length > 0, sha, subject);
  return { kind: 'paused' };
}

function finalizePureReviewAsResolved(
  sha: string,
  meta: {
    authorName: string;
    authorEmail: string;
    authorDate: string;
    message: string;
  },
  remote: string,
): PartialResult {
  // If the handler created a commit itself, HEAD moved and we just advance tracking.
  // If index has staged content, make the commit with preserved metadata.
  // If neither, advance tracking (treat as "no-op, move on").
  if (hasStagedChanges()) {
    // v0.6.0: committer = author across all commits this tool creates.
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: meta.authorName,
      GIT_AUTHOR_EMAIL: meta.authorEmail,
      GIT_AUTHOR_DATE: meta.authorDate,
      GIT_COMMITTER_NAME: meta.authorName,
      GIT_COMMITTER_EMAIL: meta.authorEmail,
      GIT_COMMITTER_DATE: meta.authorDate,
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

/**
 * Emit appropriate user-facing messaging when `git am` stopped mid-apply.
 * There are two distinct stop states:
 *
 *   1. CONFLICTED: `git am --3way` left conflict markers in files (status
 *      XY codes like UU, AU, UD). User resolves by editing the files, running
 *      `git add`, then `mirror continue`. `mirror skip` drops the commit.
 *
 *   2. STRUCTURAL: `git am` failed BEFORE the 3-way merge could run - typically
 *      "could not build fake ancestor" when the patch references files (e.g.
 *      rename source, mode-change target) that do not exist on HEAD. Worktree
 *      is clean, nothing to resolve manually. Only `mirror skip` (or `git am
 *      --abort`) recovers. `mirror continue` here would fail with "no changes -
 *      did you forget to use 'git add'?" which is misleading in this context.
 *
 * The difference matters: pointing a user at `mirror continue` + `git add` when
 * there are no conflict markers is confusing and wastes time.
 */
function printAmStopMessage(remote: string): void {
  // Identify which commit is currently stuck using the consistent
  // `<sha8>  <subject>` format used elsewhere. Missing SHA/subject degrade
  // gracefully to generic wording.
  const stuckSha = readCurrentPatchSha();
  const stuckLabel = stuckSha
    ? `${stuckSha.slice(0, 8)}  ${commitSubject(stuckSha) || '(unknown subject)'}`
    : 'current patch';

  // The displayed `mirror continue`/`mirror skip` commands intentionally omit
  // the remote argument: during a pause there's only one active pause state,
  // so the tool resolves the remote from the review-pending marker. The CLI
  // still accepts an explicit positional for scripting, just not advertised
  // here.
  if (hasUnresolvedMergeConflicts()) {
    console.error(`[mirror ${remote}] Conflict applying ${stuckLabel}`);
    console.error(`[mirror ${remote}]   Resolve the conflicts, git add, then one of:`);
    console.error(`    git-auto-remote mirror continue`);
    console.error(`    git-auto-remote mirror skip       # drop this commit`);
    return;
  }
  console.error(`[mirror ${remote}] Stopped structurally on ${stuckLabel}`);
  console.error(`[mirror ${remote}]   The patch references content missing from HEAD (e.g. a rename from a path`);
  console.error(`[mirror ${remote}]   not present, or a mode change on a file that wasn't synced). Working tree`);
  console.error(`[mirror ${remote}]   is clean; there are no conflict markers to resolve.`);
  console.error(`    git-auto-remote mirror skip              # drop this commit and continue`);
  console.error(`    git am --show-current-patch=diff         # inspect the failing patch`);
  console.error(`    git am --abort                           # bail out entirely`);
}

/**
 * Emit a contextual note about what the review overlay did. Called after the
 * overlay step so the pause-message reader understands what state the
 * worktree is in.
 *
 *   'applied'  - primary `git apply --3way` succeeded; worktree has clean
 *                unstaged delta. No extra note needed (default pause message
 *                explains "Review (in worktree, unstaged)").
 *
 *   'conflict' - `--3way` left conflict markers. User resolves + git add.
 *
 *   'fallback' - `--3way` refused the diff entirely (base content missing);
 *                tool wrote source's verbatim version into the worktree. The
 *                visible `git diff` shows the FULL delta from local to source
 *                (not just what the source commit changed). Stage hunks the
 *                user wants.
 */
function printOverlayNote(remote: string, mode: 'applied' | 'conflict' | 'fallback'): void {
  if (mode === 'conflict') {
    console.error(`[mirror ${remote}]   (some review-path hunks left conflict markers; resolve before continuing)`);
    return;
  }
  if (mode === 'fallback') {
    console.error(`[mirror ${remote}]   (review-path diff did not apply cleanly - worktree now has source's`);
    console.error(`[mirror ${remote}]    version verbatim. 'git diff' shows the FULL local->source delta for`);
    console.error(`[mirror ${remote}]    each review path, not just this commit's change. Stage what you want.)`);
    return;
  }
  // 'applied': nothing extra; default pause message is clear enough.
}

/**
 * Pause-message header. Format deliberately matches the Applying/Skipping
 * announcements in `printApplyingLines`: `[mirror X] Label: <sha8>  <subject>`.
 * Short SHA always leads, two-space gutter, no parens. See printPartialFooter
 * for the corresponding resume-commands footer.
 */
function printPartialHeader(
  remote: string,
  subject: string,
  sha: string,
  review: readonly string[],
  regenerate: readonly string[],
  outside: readonly string[],
): void {
  console.error(`[mirror ${remote}] Partial:  ${sha.slice(0, 8)}  ${subject}`);
  if (review.length > 0) {
    console.error(`  Review (in worktree, unstaged): ${review.join(', ')}`);
  }
  if (regenerate.length > 0) {
    console.error(`  Regenerate (auto-produced):     ${regenerate.join(', ')}`);
  }
  if (outside.length > 0) {
    console.error(`  Outside sync scope (dropped):   ${outside.join(', ')}`);
  }
}

/**
 * Pause-message footer: a source-commit recap (repeats the sha+subject from
 * the header so it stays in view even after the regenerate output has
 * scrolled the header offscreen), then the review/stage/discard hints when
 * applicable, then the `mirror diff`/`mirror source`/`mirror continue`/
 * `mirror skip` command surface.
 *
 * `mirror diff` shows only what the SOURCE COMMIT changed that didn't land
 * cleanly in HEAD - scoped to the review, regenerate, and outside buckets of
 * this specific commit's classification. Paths in the mirror's syncPaths
 * that happen to have drifted between HEAD and source for unrelated reasons
 * do NOT appear (unless `mirror diff --raw` is used to bypass the filter).
 *
 * The displayed commands intentionally omit the remote argument: during a
 * pause there's only one active pause state, so the tool resolves the remote
 * from the review-pending marker. The CLI still accepts an explicit
 * positional for scripting - it's just not advertised in this footer.
 */
function printPartialFooter(_remote: string, hasReview: boolean, sourceSha: string, sourceSubject: string): void {
  const short = sourceSha.slice(0, 8);
  console.error(``);
  console.error(`  Source:   ${short}  ${sourceSubject}`);
  console.error(``);
  if (hasReview) {
    console.error(`  Review:   git diff                              # see unstaged review content`);
    console.error(`  Stage:    git add -p                            # pick hunks into the commit`);
    console.error(`  Discard:  git restore <paths>                   # drop review hunks`);
  }
  console.error(`  Diff:     git-auto-remote mirror diff             # what source changed that didn't land in HEAD`);
  console.error(`  Show:     git-auto-remote mirror source           # full 'git show' of the source commit`);
  console.error(``);
  console.error(`  Continue: git-auto-remote mirror continue`);
  console.error(`  Skip:     git-auto-remote mirror skip`);
}
