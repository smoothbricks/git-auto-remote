import { installHook } from '../lib/hooks.js';

type SetupOptions = {
  /** Suppress "already up to date" messages. Errors and new-install messages are always shown. */
  quiet?: boolean;
};

export function setup(options: SetupOptions = {}): number {
  const results = [installHook('post-checkout'), installHook('pre-push')];

  for (const r of results) {
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
