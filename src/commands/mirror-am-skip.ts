import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { amInProgress, commitSubject, gitDir } from '../lib/git.js';
import {
  clearMirrorInProgress,
  getMirrorInProgress,
  updateTrackingRef,
} from '../lib/mirror-state.js';
import { mirrorPull } from './mirror-pull.js';

/**
 * Wrap `git am --skip` with the bookkeeping the post-applypatch hook would
 * normally do (but can't, because `--skip` drops the patch without firing
 * the hook):
 *
 *   1. Read the source SHA of the currently-stuck patch from rebase-apply.
 *   2. Run `git am --skip`.
 *   3. Advance the mirror tracking ref past that SHA so the next pull does
 *      not re-encounter this commit.
 *   4. If am is now fully done, clear the sentinel and auto-resume `mirror pull`.
 *      If more patches remain and also conflict, stop here and let the user
 *      decide what to do with the next one.
 */
export async function mirrorAmSkip(remoteArg?: string): Promise<number> {
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
    console.error(`Usage: git-auto-remote mirror am-skip <remote>`);
    return 1;
  }
  if (remoteArg && sentinelRemote && sentinelRemote !== remoteArg) {
    console.error(
      `[git-auto-remote] sentinel says am is for '${sentinelRemote}', not '${remoteArg}'.`,
    );
    return 1;
  }

  const applyDir = join(gitDir(), 'rebase-apply');
  const skipSha = readCurrentPatchSha(applyDir);
  if (!skipSha) {
    console.error(
      `[git-auto-remote] Could not determine the source SHA of the current patch in ${applyDir}.`,
    );
    return 1;
  }

  const subject = commitSubject(skipSha);

  // Run git am --skip with inherited stdio so the user sees git's output.
  const r = spawnSync('git', ['am', '--skip'], { stdio: 'inherit' });
  if ((r.status ?? 0) !== 0 && amInProgress()) {
    // --skip itself failed - leave state alone.
    return r.status ?? 1;
  }

  updateTrackingRef(remote, skipSha);
  console.error(
    `[mirror ${remote}] skipped ${skipSha.slice(0, 8)}${subject ? ` (${subject})` : ''}`,
  );

  // More patches remaining? `git am --skip` may have auto-advanced into them
  // and stopped at the next conflict. Leave the sentinel set and let the user
  // decide what to do with the new conflict.
  if (amInProgress()) {
    console.error(
      `[mirror ${remote}] am still in progress on another patch; resolve + 'mirror am-continue', or 'mirror am-skip' again.`,
    );
    return 0;
  }

  // am fully complete: clear sentinel (if post-applypatch didn't already) and
  // auto-resume the sync from where the tracking ref now points.
  clearMirrorInProgress();
  return mirrorPull({ remote });
}

function readCurrentPatchSha(applyDir: string): string | null {
  const nextPath = join(applyDir, 'next');
  if (!existsSync(nextPath)) return null;
  const next = Number.parseInt(readFileSync(nextPath, 'utf8').trim(), 10);
  if (!Number.isFinite(next) || next < 1) return null;
  const patchFile = join(applyDir, String(next).padStart(4, '0'));
  if (!existsSync(patchFile)) return null;
  const firstLine = readFileSync(patchFile, 'utf8').split('\n', 1)[0];
  const match = firstLine.match(/^From\s+([0-9a-f]{40})\s+/);
  return match ? match[1] : null;
}
