import { listMirrorConfigs } from '../lib/mirror-config.js';
import { readTrackingRef } from '../lib/mirror-state.js';

export function mirrorList(): number {
  const mirrors = listMirrorConfigs();
  if (mirrors.length === 0) {
    console.log('No mirrors configured.');
    console.log('Configure with: git config auto-remote.<remote>.syncPaths "<paths>"');
    return 0;
  }
  for (const m of mirrors) {
    const tracking = readTrackingRef(m.remote);
    console.log(`${m.remote}:`);
    console.log(`  syncPaths:         ${m.syncPaths.join(' ')}`);
    console.log(`  syncBranch:        ${m.syncBranch}`);
    console.log(`  syncTargetBranch:  ${m.syncTargetBranch}`);
    console.log(`  partialHandler:    ${m.partialHandler ?? '(none)'}`);
    console.log(`  pushSyncRef:       ${m.pushSyncRef}`);
    console.log(`  tracking:          ${tracking ? tracking.slice(0, 8) : '(not bootstrapped)'}`);
  }
  return 0;
}
