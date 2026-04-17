import { currentBranch } from '../lib/git.js';
import { listMirrorConfigs } from '../lib/mirror-config.js';
import { mirrorPull } from './mirror-pull.js';

/**
 * Git's `post-merge` hook runs after a successful `git pull` / `git merge`.
 * For each configured mirror whose `syncTargetBranch` matches the current branch,
 * we run `mirror pull`. Failures never fail the user's pull.
 */
export async function postMerge(): Promise<number> {
  const branch = currentBranch();
  if (!branch) return 0;

  for (const mirror of listMirrorConfigs()) {
    if (mirror.syncTargetBranch !== branch) continue;
    try {
      // Interactive mode: at a partial we pause for human review (exit 0),
      // at a conflict we leave git am open and print instructions (exit 1).
      // Either way we DO NOT propagate a non-zero to fail the outer `git pull`.
      await mirrorPull({ remote: mirror.remote, nonInteractive: false });
    } catch (err) {
      console.error(
        `[git-auto-remote] mirror pull ${mirror.remote} errored: ${(err as Error).message}`,
      );
    }
  }
  return 0;
}
