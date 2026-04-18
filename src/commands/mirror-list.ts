import { listMirrorConfigs } from '../lib/mirror-config.js';
import { readTrackingRef } from '../lib/mirror-state.js';

export function mirrorList(): number {
  const mirrors = listMirrorConfigs();
  if (mirrors.length === 0) {
    console.log('No mirrors configured.');
    console.log('Configure with: git config auto-remote.<remote>.syncPaths "<paths>"');
    return 0;
  }
  for (let i = 0; i < mirrors.length; i++) {
    if (i > 0) console.log('');
    const m = mirrors[i];
    const tracking = readTrackingRef(m.remote);
    console.log(`${m.remote}:`);
    console.log(`  syncBranch:        ${m.syncBranch}`);
    console.log(`  syncTargetBranch:  ${m.syncTargetBranch}`);
    console.log(`  syncPaths:         ${m.syncPaths.join(' ') || '(none)'}`);
    if (m.excludePaths.length > 0) {
      console.log(`  excludePaths:      ${m.excludePaths.join(' ')}`);
    }
    if (m.reviewPaths.length > 0) {
      console.log(`  reviewPaths:       ${m.reviewPaths.join(' ')}`);
    }
    if (m.regeneratePaths.length > 0) {
      console.log(`  regeneratePaths:   ${m.regeneratePaths.join(' ')}`);
    }
    if (m.regenerateCommand) {
      console.log(`  regenerateCommand: ${m.regenerateCommand}`);
    }
    console.log(`  partialHandler:    ${m.partialHandler ?? '(none)'}`);
    console.log(`  pushSyncRef:       ${m.pushSyncRef}`);
    console.log(`  tracking:          ${tracking ? tracking.slice(0, 8) : '(not bootstrapped)'}`);
  }
  return 0;
}
