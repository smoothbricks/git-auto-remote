import { amInProgress, workingTreeDirty } from '../lib/git.js';
import { clearReviewPending, getReviewPending } from '../lib/mirror-state.js';
import { mirrorPull } from './mirror-pull.js';

/**
 * Resume a sync after a partial-commit review pause. Preconditions:
 *   - There is a review-pending state
 *   - Working tree is clean (user finished any `--amend` etc.)
 *   - `git am` is not currently stuck
 */
export async function mirrorContinue(remoteArg?: string): Promise<number> {
  const review = getReviewPending();
  if (!review) {
    console.error(`[git-auto-remote] No pending partial-commit review.`);
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
      `[git-auto-remote] 'git am' is still in progress; run 'git am --continue' or 'git am --abort' first.`,
    );
    return 1;
  }
  if (workingTreeDirty()) {
    console.error(
      `[git-auto-remote] Working tree has uncommitted changes; commit or stash before continuing.`,
    );
    return 1;
  }

  clearReviewPending();
  return mirrorPull({ remote });
}
