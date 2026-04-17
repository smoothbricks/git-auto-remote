import { amInProgress, git } from '../lib/git.js';
import { clearReviewPending, getReviewPending } from '../lib/mirror-state.js';
import { mirrorPull } from './mirror-pull.js';

/**
 * Discard the currently-applied partial subset and advance past it.
 *
 * The partial was applied (HEAD is the subset commit) and the tracking ref
 * already points at the partial's source SHA (advanced by post-applypatch).
 * To skip, we just reset HEAD~1: next `mirror pull` sees tracking = source-SHA
 * and resumes from the next commit in the mirror.
 */
export async function mirrorSkip(remoteArg?: string): Promise<number> {
  const review = getReviewPending();
  if (!review) {
    console.error(`[git-auto-remote] No pending partial-commit review to skip.`);
    return 1;
  }
  const remote = remoteArg ?? review.remote;
  if (remote !== review.remote) {
    console.error(
      `[git-auto-remote] Pending review is for '${review.remote}', not '${remote}'.`,
    );
    return 1;
  }
  if (amInProgress()) {
    console.error(
      `[git-auto-remote] 'git am' is in progress; resolve with --continue or --abort first.`,
    );
    return 1;
  }

  git('reset', '--hard', 'HEAD~1');
  clearReviewPending();
  console.error(
    `[git-auto-remote] Skipped ${review.sourceSha.slice(0, 8)} (${review.subject}); resuming.`,
  );
  return mirrorPull({ remote });
}
