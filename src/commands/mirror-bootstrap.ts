import { revParse } from '../lib/git.js';
import { getMirrorConfig } from '../lib/mirror-config.js';
import { readTrackingRef, updateTrackingRef } from '../lib/mirror-state.js';

/**
 * Initialize the tracking ref for a mirror. Run once per clone, pointing at a
 * commit on the mirror whose content is already reflected in our working tree.
 * Refuses to overwrite an existing tracking ref (use `--force` to re-bootstrap).
 */
export function mirrorBootstrap(remote: string, shaArg: string, force: boolean): number {
  const mirror = getMirrorConfig(remote);
  if (!mirror) {
    console.error(`[git-auto-remote] No mirror configured for '${remote}'.`);
    console.error(`  Configure first:  git config auto-remote.${remote}.syncPaths "<paths>"`);
    return 1;
  }

  const existing = readTrackingRef(remote);
  if (existing && !force) {
    console.error(
      `[git-auto-remote] Mirror '${remote}' already bootstrapped at ${existing.slice(0, 12)}.`,
    );
    console.error(`  Re-bootstrap with:  git-auto-remote mirror bootstrap ${remote} <sha> --force`);
    return 1;
  }

  const sha = revParse(shaArg);
  if (!sha) {
    console.error(`[git-auto-remote] Cannot resolve '${shaArg}' to a commit.`);
    return 1;
  }

  updateTrackingRef(remote, sha);
  console.error(`[git-auto-remote] Mirror '${remote}' bootstrapped at ${sha.slice(0, 12)}.`);
  return 0;
}
