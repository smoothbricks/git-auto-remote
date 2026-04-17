import { spawnSync } from 'node:child_process';
import { amInProgress } from '../lib/git.js';
import { clearMirrorInProgress, getMirrorInProgress } from '../lib/mirror-state.js';
import { mirrorPull } from './mirror-pull.js';

/**
 * Wrap `git am --continue` with the "auto-resume sync on success" behavior
 * users expect. The post-applypatch hook still does the heavy lifting of
 * advancing the tracking ref during --continue; this command just takes
 * care of kicking off the next `mirror pull` when the am run finishes.
 */
export async function mirrorAmContinue(remoteArg?: string): Promise<number> {
  if (!amInProgress()) {
    console.error(`[git-auto-remote] No 'git am' in progress.`);
    return 1;
  }

  const sentinelRemote = getMirrorInProgress();
  const remote = sentinelRemote ?? remoteArg;
  if (!remote) {
    console.error(
      `[git-auto-remote] am is in progress but no mirror sentinel set and no remote given.`,
    );
    console.error(`Usage: git-auto-remote mirror am-continue <remote>`);
    return 1;
  }
  if (remoteArg && sentinelRemote && sentinelRemote !== remoteArg) {
    console.error(
      `[git-auto-remote] sentinel says am is for '${sentinelRemote}', not '${remoteArg}'.`,
    );
    return 1;
  }

  // git am --continue fires post-applypatch which advances the tracking ref
  // for us. We just need to chain into mirror pull afterwards.
  const r = spawnSync('git', ['am', '--continue'], { stdio: 'inherit' });
  if ((r.status ?? 0) !== 0) {
    // Continue failed (likely unresolved merge markers). Leave state alone;
    // user will re-try after resolving.
    return r.status ?? 1;
  }

  // Still in conflict on a later patch? Leave it for the user.
  if (amInProgress()) {
    console.error(
      `[mirror ${remote}] am still in progress on another patch; resolve + 'mirror am-continue', or 'mirror am-skip'.`,
    );
    return 0;
  }

  // am fully done. Clear sentinel defensively and auto-resume.
  clearMirrorInProgress();
  return mirrorPull({ remote });
}
