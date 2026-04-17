import { spawnSync } from 'node:child_process';
import { getReviewPending, type ReviewPendingState } from '../lib/mirror-state.js';

/**
 * Show what the SOURCE COMMIT of the current partial pause changed in the
 * REVIEW bucket - i.e. the drift the user needs to audit and decide about.
 * Runs `git diff HEAD <sourceSha>` scoped to exactly the review paths
 * recorded on this commit's pause marker.
 *
 * Why review-only (v0.5.7):
 *
 *   - `included`:   already applied via `git am`; diff against source is
 *                   empty modulo committer-date noise - no signal.
 *   - `review`:     overlay content (in worktree unstaged if --3way
 *                   succeeded, or as fallback-written source verbatim);
 *                   this IS the drift the user must decide on. ONLY this
 *                   bucket produces meaningful `mirror diff` output.
 *   - `regenerate`: by construction always drifts - we regenerate these
 *                   locally from our own inputs (e.g. bun.lock via
 *                   `bun install` against OUR package.json). Showing the
 *                   delta against source is pure noise: it doesn't
 *                   represent a decision the user has to make.
 *   - `outside`:    outside the sync scope. We do not synchronise these
 *                   from source at all. Their diff has no meaning in the
 *                   mirror workflow - surfacing them was actively
 *                   misleading (e.g. narrow syncPaths repos would see
 *                   `package.json`, `privpkgs/*.json`, etc. in diff
 *                   output and reasonably wonder what the tool will do
 *                   with them - nothing).
 *   - excluded:     filtered out at classify-time, never in any bucket.
 *
 * History:
 *   v0.5.5: used `syncPaths ∪ reviewPaths ∪ regeneratePaths` from
 *           MIRROR CONFIG as positive filter - surfaced every path in
 *           those lists that differed between HEAD and source for ANY
 *           reason (including unrelated drift from prior commits),
 *           producing 2000+ line diffs.
 *   v0.5.6: narrowed to THIS commit's `review ∪ regenerate ∪ outside`.
 *           Fixed the drift leak but still surfaced regenerate + outside
 *           noise.
 *   v0.5.7: narrowed to THIS commit's `review` bucket only. When review
 *           is empty, prints "No review drift for this commit." instead
 *           of running `git diff` with empty pathspec (which would diff
 *           everything).
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

  if (raw) {
    const r = spawnSync('git', ['diff', 'HEAD', review.sourceSha, ...passthrough], { stdio: 'inherit' });
    return r.status ?? 1;
  }

  const pathspec = computeDiffPathspec(review);

  // Empty review bucket = no drift the user needs to audit. Do NOT fall
  // through to `git diff HEAD <sha>` with empty pathspec - that would
  // show the full tree diff (including regenerate + outside noise that
  // is precisely what we're trying to hide). Print a clear signal.
  if (pathspec.length === 0) {
    console.log('No review drift for this commit.');
    return 0;
  }

  const r = spawnSync('git', ['diff', 'HEAD', review.sourceSha, ...passthrough, '--', ...pathspec], {
    stdio: 'inherit',
  });
  return r.status ?? 1;
}

/**
 * Source-commit-specific paths whose HEAD/source diff is informative for
 * human review: the `review` bucket from this commit's classification.
 * Exported for test ergonomics.
 *
 * Returns an empty array when this commit has no review paths - callers
 * MUST treat [] as a distinct signal (no review drift) and NOT fall
 * through to an unfiltered `git diff`.
 */
export function computeDiffPathspec(review: ReviewPendingState): string[] {
  return [...review.review];
}
