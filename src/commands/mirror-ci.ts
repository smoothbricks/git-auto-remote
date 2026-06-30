import { currentBranch, gitTry, revParse } from '../lib/git.js';
import { getMirrorConfig, listMirrorConfigs, type MirrorConfig } from '../lib/mirror-config.js';
import { mirrorPull } from './mirror-pull.js';
import { setup } from './setup.js';

export type MirrorCiOptions = {
  /** Review ref to assemble on partial/conflict. Default refs/heads/gar-sync/<remote>. */
  reviewRef?: string | null;
  /** On a clean sync, also push the target branch to `<remote>[:<dstref>]`. */
  pushBranchTo?: string | null;
  /** When false, skip the optional branch push on a clean sync. Default true. */
  push?: boolean;
  /** Seed the tracking ref from the remote on a fresh clone (default true). */
  seedTracking?: boolean;
};

/**
 * C1-g: idiot-proof one-shot CI sync for one direction (or all). For each
 * configured mirror it: ensures config is loaded (committed config supported),
 * installs hooks if missing, checks out the target branch, then runs a
 * self-healing non-interactive `mirror pull --review-ref <ref>`. mirror pull
 * seeds + pushes the tracking ref itself (same-direction-only, force-with-lease).
 * On a clean sync (exit 0) it optionally pushes the target branch; on a
 * partial/conflict (exit 2) it leaves the review ref for the caller to push and
 * prints the exact next command. Exit: 0 synced, 2 review needed, 1 hard error.
 */
export async function mirrorCi(remoteArg: string | undefined, options: MirrorCiOptions = {}): Promise<number> {
  const mirrors = remoteArg
    ? [getMirrorConfig(remoteArg)].filter((c): c is MirrorConfig => c !== null)
    : listMirrorConfigs();

  if (remoteArg && mirrors.length === 0) {
    console.error(`[git-auto-remote] No mirror configured for remote '${remoteArg}'.`);
    console.error(`  Commit an auto-remote.gitconfig or set: git config auto-remote.${remoteArg}.syncPaths "<paths>"`);
    console.error(`  Next: git-auto-remote mirror status  # diagnose configuration`);
    return 1;
  }
  if (mirrors.length === 0) {
    console.error('[git-auto-remote] No mirrors configured; nothing to do.');
    console.error('  Next: git-auto-remote mirror status  # diagnose configuration');
    return 0;
  }

  // Install hooks if missing (idempotent). Best-effort: never fail ci on hooks.
  setup({ quiet: true });

  let worst = 0;
  for (const mirror of mirrors) {
    const code = await ciOne(mirror, options);
    if (code === 1) return 1;
    if (code === 2) worst = 2;
  }
  return worst;
}

async function ciOne(mirror: MirrorConfig, options: MirrorCiOptions): Promise<number> {
  const ref = options.reviewRef ?? `refs/heads/gar-sync/${mirror.remote}`;

  // mirror pull silently skips when not on the target branch, so make sure we
  // are on it first (the CI checkout normally leaves us here already).
  if (currentBranch() !== mirror.syncTargetBranch) {
    if (gitTry('checkout', mirror.syncTargetBranch) === null) {
      console.error(`[mirror ${mirror.remote}] ci: cannot checkout target branch '${mirror.syncTargetBranch}'.`);
      console.error(`  Next: git checkout ${mirror.syncTargetBranch}  # then re-run 'git-auto-remote mirror ci ${mirror.remote}'`);
      return 1;
    }
  }

  const code = await mirrorPull({
    remote: mirror.remote,
    nonInteractive: true,
    reviewRef: ref,
    seedTracking: options.seedTracking,
  });

  if (code === 1) {
    console.error(`[mirror ${mirror.remote}] ci: hard error (see above).`);
    console.error(`  Next: git-auto-remote mirror status ${mirror.remote}  # diagnose, fix, then re-run 'mirror ci ${mirror.remote}'`);
    return 1;
  }

  if (code === 2) {
    console.error(`[mirror ${mirror.remote}] ci: review needed - assembled ${ref} (tracking ref unchanged; nothing pushed).`);
    console.error(
      `  Next: git push --force-with-lease <pr-remote> ${ref} && gh pr create --base ${mirror.syncTargetBranch} --head ${ref}  # open/refresh the single review PR for this direction`,
    );
    return 2;
  }

  // code === 0: clean. mirror pull already pushed the tracking ref.
  if (options.push !== false && options.pushBranchTo) {
    if (!pushBranch(mirror.syncTargetBranch, options.pushBranchTo)) {
      console.error(`[mirror ${mirror.remote}] ci: Warning: failed to push '${mirror.syncTargetBranch}' to ${options.pushBranchTo}.`);
    }
  }

  if (revParse(ref)) {
    console.error(`[mirror ${mirror.remote}] ci: synced clean; a stale review ref ${ref} remains from a prior run.`);
    console.error(`  Next: git push <pr-remote> :${ref}  # delete the review branch (the review PR auto-closes)`);
  } else {
    console.error(`[mirror ${mirror.remote}] ci: synced clean; up to date.`);
  }
  return 0;
}

/**
 * Push the synced target branch to `<remote>[:<dstref>]` (plain, non-forced).
 * `--no-verify`: this is a sanctioned self-push by `mirror ci` of the branch it
 * just synced; gar's own pre-push cross-history guard must not block it. The
 * guard stays active for everything else (notably the public-facing push the
 * consuming workflow performs).
 */
function pushBranch(branch: string, spec: string): boolean {
  const colon = spec.indexOf(':');
  const remote = colon < 0 ? spec : spec.slice(0, colon);
  const dst = colon < 0 ? `refs/heads/${branch}` : spec.slice(colon + 1);
  return gitTry('push', '--quiet', '--no-verify', remote, `refs/heads/${branch}:${dst}`) !== null;
}
