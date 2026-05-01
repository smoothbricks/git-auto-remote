import { spawnSync } from 'node:child_process';
import { amInProgress, git, gitTry } from '../lib/git.js';
import {
  clearMirrorInProgress,
  clearPendingCommit,
  clearReviewPending,
  deleteTrackingRef,
  getMirrorInProgress,
  getReviewPending,
  updateTrackingRef,
} from '../lib/mirror-state.js';

/**
 * Abort an in-progress mirror sync and clean up all transient state.
 *
 * Unlike `mirror skip` (which advances the tracking ref past the stuck commit
 * and auto-resumes), abort is a full stop: it rewinds the tracking ref so the
 * next `mirror pull` re-encounters the same source commit, undoes any partial
 * HEAD commits that were created, and clears all state files. The user is left
 * with a clean working tree at the pre-pause HEAD.
 *
 * State cleaned up:
 *   - `git am --abort` if an am session is in progress
 *   - HEAD reset to pre-partial state (review-pause only: HEAD~1)
 *   - Tracking ref rewound to before the paused source commit
 *   - `.git/git-auto-remote/mirror-in-progress` sentinel
 *   - `.git/git-auto-remote/review-pending` marker
 *   - `.git/git-auto-remote/pending-commit` metadata
 *   - Worktree review overlay discarded
 */
export async function mirrorAbort(remoteArg?: string): Promise<number> {
  const review = getReviewPending();
  const sentinel = getMirrorInProgress();
  const isAm = amInProgress();

  // Determine which remote we're operating on.
  const remote = remoteArg ?? review?.remote ?? sentinel ?? null;

  if (!remote && !review && !sentinel && !isAm) {
    console.error(`[git-auto-remote] Nothing to abort (no active mirror operation).`);
    return 1;
  }

  // --- 1. Abort git am if in progress ---
  if (isAm) {
    const r = spawnSync('git', ['am', '--abort'], { stdio: 'inherit' });
    if ((r.status ?? 0) !== 0) {
      console.error(`[git-auto-remote] git am --abort failed (exit ${r.status}); continuing cleanup.`);
    }
  }

  // --- 2. Undo partial commits and discard review overlay ---
  if (review) {
    if (review.phase === 'review-pause') {
      // applyPartial created a HEAD commit; undo it. Review overlay is
      // discarded by the hard reset.
      discardReviewPaths(review.review);
      git('reset', '--hard', 'HEAD~1');
    } else if (review.phase === 'pure-review-pause') {
      // No HEAD commit was made; just discard the review overlay.
      discardReviewPaths(review.review);
    }
    // phase 'am-in-progress': git am --abort (above) already unwound HEAD.

    // --- 3. Rewind tracking ref to before the paused source commit ---
    // The tracking ref was advanced to review.sourceSha during the pause
    // setup. Rewind it to the parent so the next `mirror pull` re-encounters
    // this commit (giving the user a chance to retry, configure differently,
    // etc.). For root commits (no parent), delete the tracking ref entirely.
    const parent = gitTry('rev-parse', '--verify', '--quiet', `${review.sourceSha}^`);
    if (parent) {
      updateTrackingRef(review.remote, parent);
    } else {
      deleteTrackingRef(review.remote);
    }

    console.error(
      `[mirror ${review.remote}] Aborted:  ${review.sourceSha.slice(0, 8)}  ${review.subject}`,
    );
  } else if (sentinel) {
    // No review-pending but sentinel exists (e.g. range-segment error that
    // left a stale sentinel, or am --abort already cleaned up). Just clear
    // the sentinel. Tracking ref was not advanced for range errors (that
    // happens after the success check), so no rewind needed.
    console.error(`[git-auto-remote] Cleared stale mirror-in-progress sentinel for '${sentinel}'.`);
  } else if (isAm) {
    // git am was in progress but no mirror state files existed. This could
    // be a mirror am or a user am; we aborted it above. Just confirm.
    console.error(`[git-auto-remote] Aborted in-progress git am.`);
  }

  // --- 4. Clear all state files ---
  clearMirrorInProgress();
  clearReviewPending();
  clearPendingCommit();

  console.error(`[git-auto-remote] Mirror sync aborted. Re-run 'mirror pull' to retry.`);
  return 0;
}

/**
 * Discard review-path content from worktree (staged + unstaged + untracked).
 */
function discardReviewPaths(paths: readonly string[]): void {
  if (paths.length === 0) return;
  gitTry('restore', '--staged', '--worktree', '--source=HEAD', '--', ...paths);
  gitTry('clean', '-fd', '--', ...paths);
}
