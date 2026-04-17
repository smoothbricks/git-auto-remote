import { spawnSync } from 'node:child_process';
import { getReviewPending, type ReviewPendingState } from '../lib/mirror-state.js';

/**
 * Show what the SOURCE COMMIT of the current partial pause changed that
 * didn't land cleanly in HEAD. Runs `git diff HEAD <sourceSha>` scoped to
 * the paths this specific commit touched in the review/regenerate/outside
 * buckets.
 *
 * Why that specific scope:
 *
 *   - `included`: already applied via `git am`; diff against source is empty
 *                 modulo committer-date noise - no signal.
 *   - `review`:   overlay content (in worktree unstaged if --3way succeeded,
 *                 or as fallback-written source verbatim); NOT in HEAD.
 *   - `regenerate`: dropped from the patch; HEAD has our locally-regenerated
 *                 version. Source had upstream's. Delta is meaningful.
 *   - `outside`:  dropped entirely; HEAD lacks source's content.
 *   - excluded paths: filtered out at classify-time, never in any bucket.
 *
 * Earlier versions used `syncPaths ∪ reviewPaths ∪ regeneratePaths` from the
 * MIRROR CONFIG as the positive filter - that surfaced every path in those
 * lists that happened to differ between HEAD and source for ANY reason
 * (including unrelated drift from prior commits), producing useless 2000+
 * line diffs. This implementation uses the SOURCE-COMMIT-SPECIFIC buckets
 * stored in the review-pending marker instead.
 *
 * Flags:
 *   --raw                   Bypass the positive filter; show the raw
 *                           `git diff HEAD <sourceSha>` with no pathspec.
 *                           Useful for debugging the tool's classification.
 *
 * Any other args are forwarded to `git diff` (e.g. `--stat`, `--name-only`).
 */
export function mirrorDiff(remoteArg: string | undefined, extraArgs: string[] = []): number {
  const review = getReviewPending();
  if (!review) {
    console.error(`[git-auto-remote] No partial pause active - nothing to diff.`);
    console.error(`  'mirror diff' only works during a partial pause (after 'mirror pull' paused for review).`);
    return 1;
  }
  if (remoteArg && remoteArg !== review.remote) {
    console.error(`[git-auto-remote] Pending review is for '${review.remote}', not '${remoteArg}'.`);
    return 1;
  }

  let raw = false;
  const passthrough: string[] = [];
  for (const arg of extraArgs) {
    if (arg === '--raw') raw = true;
    else passthrough.push(arg);
  }

  const pathspec = raw ? [] : computeDiffPathspec(review);

  const diffArgs = ['diff', 'HEAD', review.sourceSha, ...passthrough];
  if (pathspec.length > 0) diffArgs.push('--', ...pathspec);

  const r = spawnSync('git', diffArgs, { stdio: 'inherit' });
  return r.status ?? 1;
}

/**
 * Source-commit-specific paths whose HEAD/source diff is informative: the
 * union of the three "didn't land cleanly in HEAD" buckets from classify.
 * Exported for test ergonomics.
 */
export function computeDiffPathspec(review: ReviewPendingState): string[] {
  return [...review.review, ...review.regenerate, ...review.outside];
}
