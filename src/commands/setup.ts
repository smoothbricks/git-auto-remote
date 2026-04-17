import { ALL_HOOKS, installHook } from '../lib/hooks.js';
import { checkGitVersion } from '../lib/git-version.js';

type SetupOptions = {
  /** Suppress "already up to date" messages. Errors and new-install messages are always shown. */
  quiet?: boolean;
};

export function setup(options: SetupOptions = {}): number {
  const versionError = checkGitVersion();
  if (versionError) {
    console.error(`[git-auto-remote] ${versionError}`);
    return 1;
  }

  for (const hook of ALL_HOOKS) {
    const r = installHook(hook);
    if (r.kind === 'already-present') {
      if (!options.quiet) console.error(`[git-auto-remote] ${r.path}: already installed`);
    } else if (r.kind === 'installed') {
      console.error(`[git-auto-remote] ${r.path}: installed`);
    } else if (r.kind === 'appended') {
      console.error(`[git-auto-remote] ${r.path}: appended to existing hook`);
    }
  }

  return 0;
}
