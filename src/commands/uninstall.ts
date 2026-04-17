import { uninstallHook } from '../lib/hooks.js';

export function uninstall(): number {
  for (const hook of ['post-checkout', 'pre-push'] as const) {
    const result = uninstallHook(hook);
    switch (result.kind) {
      case 'removed':
        console.error(`[git-auto-remote] ${result.path}: removed our block`);
        break;
      case 'not-present':
        console.error(`[git-auto-remote] ${result.path}: no git-auto-remote block found`);
        break;
      case 'file-missing':
        console.error(`[git-auto-remote] ${result.path}: no hook file`);
        break;
    }
  }
  return 0;
}
