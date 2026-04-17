import { isRootCommit, revParse } from '../lib/git.js';
import { getMirrorConfig } from '../lib/mirror-config.js';
import { readTrackingRef, updateTrackingRef } from '../lib/mirror-state.js';

/**
 * Initialize the tracking ref for a mirror.
 *
 * OPTIONAL: `mirror pull` works fine without any bootstrap at all - the
 * absence of a tracking ref is interpreted as "local has no prior mirror
 * content; replay the mirror's full history from its root". Use bootstrap
 * only when you want to SKIP PAST a portion of the mirror's history because
 * its content is already locally reflected.
 *
 * <sha> semantics: the tracking ref is inclusive-right, exclusive-left in
 * rev-list terms, i.e. `mirror pull` enumerates `<sha>..<head>` - so the
 * commit you bootstrap AT is treated as "already here, don't replay it,
 * replay its children onward".
 *
 * Bootstrapping at a ROOT commit is almost never what you want: `<root>..
 * <head>` excludes the root, meaning every file the mirror creates in its
 * root commit would be missing from local HEAD, and downstream commits
 * modifying those files would hit modify/delete conflicts. The command
 * warns in that case and points you at the simpler alternative (skip
 * bootstrap entirely, just run `mirror pull`).
 *
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
    console.error(`[git-auto-remote] Mirror '${remote}' already bootstrapped at ${existing.slice(0, 12)}.`);
    console.error(`  Re-bootstrap with:  git-auto-remote mirror bootstrap ${remote} <sha> --force`);
    console.error(`  Or remove the tracking ref to fall back to full-history replay on next pull:`);
    console.error(`    git update-ref -d refs/git-auto-remote/mirror/${remote}/last-synced`);
    return 1;
  }

  const sha = revParse(shaArg);
  if (!sha) {
    console.error(`[git-auto-remote] Cannot resolve '${shaArg}' to a commit.`);
    return 1;
  }

  if (isRootCommit(sha)) {
    console.error(`[git-auto-remote] Warning: ${sha.slice(0, 12)} is a ROOT commit.`);
    console.error(`  Bootstrapping here means its content is SKIPPED from the next 'mirror pull'`);
    console.error(`  (bootstrap semantics: "this SHA's content is already locally reflected").`);
    console.error(`  If you want the root INCLUDED in the replay (fresh clone, no prior content),`);
    console.error(`  skip bootstrap entirely - just run 'mirror pull ${remote}'.`);
    if (!force) {
      console.error(`  To proceed anyway, re-run with --force.`);
      return 1;
    }
  }

  updateTrackingRef(remote, sha);
  console.error(`[git-auto-remote] Mirror '${remote}' bootstrapped at ${sha.slice(0, 12)}.`);
  return 0;
}
