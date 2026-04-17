import { spawnSync } from 'node:child_process';
import { getMirrorConfig } from '../lib/mirror-config.js';
import { getReviewPending } from '../lib/mirror-state.js';

/**
 * Show the source commit's content that didn't land cleanly in HEAD during
 * a partial pause. Runs `git diff HEAD <sourceSha>` filtered to the sync
 * domain so private-only paths (privpkgs/, CLAUDE.md, etc.) don't clutter
 * the output.
 *
 * The "sync domain" filter is the union of:
 *   - `syncPaths`   (auto-applied allowlist)
 *   - `reviewPaths` (worktree-overlay allowlist)
 *   - `regeneratePaths` (locally-derived allowlist)
 *   - PLUS the `outside` bucket from the SPECIFIC source commit's
 *     classification (paths the source touched that matched none of the
 *     above). Adding source-specific `outside` keeps the tool-surfaced
 *     "what was dropped" signal visible while still excluding noise from
 *     purely-private paths the source commit didn't touch.
 *
 * Minus `excludePaths` (applied as `:(exclude)...` magic pathspecs).
 *
 * Flags:
 *   --include-excluded: drop the `:(exclude)` filters (show excluded files too).
 *                       Useful for debugging what an excludePaths rule is hiding.
 *   --raw:              skip the sync-domain positive filter AND the exclude
 *                       filter; just run plain `git diff HEAD <sourceSha>`.
 *
 * Any trailing args after the flags are passed through to `git diff` so you
 * can append `--stat`, `--name-only`, etc.
 */
export function mirrorDiff(remoteArg: string | undefined, extraArgs: string[] = []): number {
  const review = getReviewPending();
  if (!review) {
    console.error(`[git-auto-remote] No partial pause active - nothing to diff.`);
    console.error(`  'mirror diff' only works during a partial pause (after 'mirror pull' paused for review).`);
    return 1;
  }
  const remote = remoteArg ?? review.remote;
  if (remote !== review.remote) {
    console.error(`[git-auto-remote] Pending review is for '${review.remote}', not '${remote}'.`);
    return 1;
  }

  // Parse the mirror-diff-specific flags from extraArgs; forward the rest.
  let includeExcluded = false;
  let raw = false;
  const passthrough: string[] = [];
  for (const arg of extraArgs) {
    if (arg === '--include-excluded') includeExcluded = true;
    else if (arg === '--raw') raw = true;
    else passthrough.push(arg);
  }

  const mirror = getMirrorConfig(remote);
  if (!mirror && !raw) {
    console.error(`[git-auto-remote] Mirror '${remote}' config not found; cannot build sync-domain filter.`);
    console.error(`  Use --raw to bypass the filter and see the full diff.`);
    return 1;
  }

  const pathspec: string[] = [];
  if (!raw && mirror) {
    // Positive filter: syncPaths ∪ reviewPaths ∪ regeneratePaths ∪ source-specific outside.
    const positive = new Set<string>();
    for (const p of mirror.syncPaths) positive.add(p);
    for (const p of mirror.reviewPaths) positive.add(p);
    for (const p of mirror.regeneratePaths) positive.add(p);
    for (const p of review.outside) positive.add(p);
    pathspec.push(...positive);

    // Negative filter (unless --include-excluded).
    if (!includeExcluded) {
      for (const e of mirror.excludePaths) pathspec.push(`:(exclude)${e}`);
    }
  }

  // Build the git diff invocation. Passing `--` separates refs from pathspec;
  // required when pathspec is non-empty.
  const diffArgs = ['diff', 'HEAD', review.sourceSha, ...passthrough];
  if (pathspec.length > 0) diffArgs.push('--', ...pathspec);

  const r = spawnSync('git', diffArgs, { stdio: 'inherit' });
  return r.status ?? 1;
}

// Re-export for test ergonomics - lets tests check what positive/negative
// paths were computed without running git.
export function computeDiffPathspec(
  review: NonNullable<ReturnType<typeof getReviewPending>>,
  mirrorSyncPaths: readonly string[],
  mirrorExcludePaths: readonly string[],
  mirrorReviewPaths: readonly string[],
  mirrorRegeneratePaths: readonly string[],
  includeExcluded = false,
): string[] {
  const positive = new Set<string>();
  for (const p of mirrorSyncPaths) positive.add(p);
  for (const p of mirrorReviewPaths) positive.add(p);
  for (const p of mirrorRegeneratePaths) positive.add(p);
  for (const p of review.outside) positive.add(p);
  const result: string[] = [...positive];
  if (!includeExcluded) {
    for (const e of mirrorExcludePaths) result.push(`:(exclude)${e}`);
  }
  return result;
}
