import { spawnSync } from 'node:child_process';
import { getReviewPending } from '../lib/mirror-state.js';

/**
 * Exec `git show <sourceSha>` for the commit that triggered the current
 * partial pause. Pure convenience wrapper so the user doesn't need to copy
 * the sha out of the pause header by hand.
 *
 * Any extra args are passed through to `git show` (e.g. `--stat`, `--name-only`).
 */
export function mirrorSource(remoteArg: string | undefined, extraArgs: string[] = []): number {
  const review = getReviewPending();
  if (!review) {
    console.error(`[git-auto-remote] No partial pause active - no source commit to show.`);
    console.error(`  'mirror source' only works during a partial pause (after 'mirror pull' paused for review).`);
    return 1;
  }
  const remote = remoteArg ?? review.remote;
  if (remote !== review.remote) {
    console.error(`[git-auto-remote] Pending review is for '${review.remote}', not '${remote}'.`);
    return 1;
  }

  // v0.7.0 MEDIUM-1 (see 2026-04-18-audit.md): Detect garbage sourceSha
  // (post-GC or upstream force-push dropped the commit) before invoking git show.
  // This prevents raw "fatal: bad object" errors and gives users actionable guidance.
  const verify = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${review.sourceSha}^{commit}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (verify.status !== 0) {
    const sha8 = review.sourceSha.slice(0, 8);
    console.error(`[git-auto-remote] Source commit ${sha8} not in object DB (post-GC or upstream force-push). Re-fetch ${review.remote} or run 'mirror skip' to drop this pause.`);
    return 1;
  }

  const r = spawnSync('git', ['show', review.sourceSha, ...extraArgs], {
    stdio: 'inherit',
  });
  return r.status ?? 1;
}
