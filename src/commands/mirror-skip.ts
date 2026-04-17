import { spawnSync } from 'node:child_process';
import { amInProgress, commitSubject, git, gitTry, readCurrentPatchSha } from '../lib/git.js';
import {
  clearMirrorInProgress,
  clearPendingCommit,
  clearReviewPending,
  getMirrorInProgress,
  getReviewPending,
  updateTrackingRef,
} from '../lib/mirror-state.js';
import { mirrorPull } from './mirror-pull.js';

/**
 * Unified skip command across all pause sub-cases:
 *
 *   - `git am` in progress (plain range or phase 'am-in-progress'):
 *       reads the source SHA of the stuck patch, runs `git am --skip`,
 *       advances the tracking ref past that SHA, and auto-resumes `mirror pull`.
 *
 *   - phase 'review-pause' (sub-case B):
 *       discards unstaged review content and runs `git reset --hard HEAD~1` to
 *       undo the partial commit `applyPartial` made. Tracking ref already
 *       points past the source SHA, so the next pull resumes past it.
 *
 *   - phase 'pure-review-pause' (sub-case C):
 *       discards unstaged review content. There is no HEAD commit to reset.
 *       Tracking ref was already advanced to source at pause time, so nothing
 *       else to do.
 */
export async function mirrorSkip(remoteArg?: string): Promise<number> {
  if (amInProgress()) {
    return skipAm(remoteArg);
  }

  const review = getReviewPending();
  if (!review) {
    console.error(`[git-auto-remote] Nothing to skip (no active sync pause).`);
    return 1;
  }
  const remote = remoteArg ?? review.remote;
  if (remote !== review.remote) {
    console.error(`[git-auto-remote] Pending review is for '${review.remote}', not '${remote}'.`);
    return 1;
  }

  if (review.phase === 'review-pause') {
    // Discard any review worktree content then drop the partial commit.
    // `git reset --hard HEAD~1` also wipes staged/unstaged, but untracked
    // files (new files added by `git apply`) survive - clean them explicitly.
    gitTry('clean', '-fd', '--', ...review.review);
    git('reset', '--hard', 'HEAD~1');
    clearReviewPending();
    console.error(`[mirror ${remote}] Skipped:  ${review.sourceSha.slice(0, 8)}  ${review.subject}`);
    return mirrorPull({ remote });
  }
  if (review.phase === 'pure-review-pause') {
    discardReviewPaths(review.review);
    clearPendingCommit();
    clearReviewPending();
    console.error(`[mirror ${remote}] Skipped:  ${review.sourceSha.slice(0, 8)}  ${review.subject}`);
    return mirrorPull({ remote });
  }
  // phase === 'am-in-progress' but am is not in progress anymore. Treat as if
  // the user is trying to skip the review transition: behave like review-pause
  // skip (reset HEAD~1 to undo the included-subset commit if any was made).
  // This is a weird state; log and do the safest thing.
  console.error(`[git-auto-remote] Pause says 'am-in-progress' but no git am is running; skipping by reset HEAD~1.`);
  gitTry('clean', '-fd', '--', ...review.review);
  git('reset', '--hard', 'HEAD~1');
  clearReviewPending();
  return mirrorPull({ remote });
}

/**
 * Wrap `git am --skip` with the bookkeeping the post-applypatch hook would
 * normally do (but can't, because `--skip` drops the patch without firing
 * the hook):
 *
 *   1. Read the source SHA of the currently-stuck patch from rebase-apply.
 *   2. Run `git am --skip`.
 *   3. Advance the mirror tracking ref past that SHA so the next pull does
 *      not re-encounter this commit.
 *   4. If am is now fully done, clear the sentinel, clear any dangling
 *      am-in-progress review-pending marker, and auto-resume `mirror pull`.
 *      If more patches remain and also conflict, stop here.
 */
async function skipAm(remoteArg?: string): Promise<number> {
  const sentinelRemote = getMirrorInProgress();
  const remote = sentinelRemote ?? remoteArg;
  if (!remote) {
    console.error(`[git-auto-remote] 'git am' is in progress but no mirror sentinel set and no remote given.`);
    console.error(`Usage: git-auto-remote mirror skip <remote>`);
    return 1;
  }
  if (remoteArg && sentinelRemote && sentinelRemote !== remoteArg) {
    console.error(`[git-auto-remote] sentinel says am is for '${sentinelRemote}', not '${remoteArg}'.`);
    return 1;
  }

  const skipSha = readCurrentPatchSha();
  if (!skipSha) {
    console.error(`[git-auto-remote] Could not determine the source SHA of the current patch in .git/rebase-apply/.`);
    return 1;
  }

  const subject = commitSubject(skipSha);

  const r = spawnSync('git', ['am', '--skip'], { stdio: 'inherit' });
  if ((r.status ?? 0) !== 0 && amInProgress()) {
    return r.status ?? 1;
  }

  updateTrackingRef(remote, skipSha);
  console.error(`[mirror ${remote}] Skipped:  ${skipSha.slice(0, 8)}${subject ? `  ${subject}` : ''}`);

  if (amInProgress()) {
    console.error(
      `[mirror ${remote}] am still in progress on another patch; resolve + 'mirror continue', or 'mirror skip' again.`,
    );
    return 0;
  }

  // am fully complete. If a review-pending marker was recorded at phase
  // 'am-in-progress' for this same source, clear it: the user chose to drop
  // the commit entirely rather than resolve + review.
  const review = getReviewPending();
  if (review && review.phase === 'am-in-progress' && review.sourceSha === skipSha) {
    clearReviewPending();
  }
  clearMirrorInProgress();
  return mirrorPull({ remote });
}

/**
 * Same cleanup as mirror-continue's: revert staged + unstaged review content
 * to HEAD, and remove any untracked files `git apply` created.
 */
function discardReviewPaths(paths: readonly string[]): void {
  if (paths.length === 0) return;
  gitTry('restore', '--staged', '--worktree', '--source=HEAD', '--', ...paths);
  gitTry('clean', '-fd', '--', ...paths);
}
