import { amInProgress, currentBranch, isAncestorOf, listCommitsInRange, revParse } from '../lib/git.js';
import { getMirrorConfig, listMirrorConfigs } from '../lib/mirror-config.js';
import { getReviewPending, readTrackingRef } from '../lib/mirror-state.js';

export function mirrorStatus(remoteArg?: string): number {
  const mirrors = remoteArg
    ? [getMirrorConfig(remoteArg)].filter((m): m is NonNullable<typeof m> => m !== null)
    : listMirrorConfigs();

  if (mirrors.length === 0) {
    console.log(remoteArg ? `No mirror configured for '${remoteArg}'.` : 'No mirrors configured.');
    return 0;
  }

  const branch = currentBranch();
  console.log(`Current branch: ${branch ?? '(detached)'}`);
  if (amInProgress()) {
    console.log('git am:         IN PROGRESS (resolve with --continue or --abort)');
  }
  const review = getReviewPending();
  if (review) {
    console.log(`review-pending: ${review.remote} ${review.sourceSha.slice(0, 8)} (${review.subject})`);
  }
  console.log('');

  for (const m of mirrors) {
    const tracking = readTrackingRef(m.remote);
    const remoteTip = revParse(`refs/remotes/${m.remote}/${m.syncBranch}`);
    // `behind` semantics:
    //   - tracking present + ancestor of remoteTip -> standard <tracking>..<tip>
    //   - tracking present + NOT ancestor -> unknown (force-push or cross-history)
    //   - tracking absent + remoteTip present -> full history from mirror's root
    //     (this is the fresh-clone / unbootstrapped case; next pull replays all)
    //   - remoteTip absent -> null (not fetched yet)
    const behind = !remoteTip
      ? null
      : !tracking
        ? listCommitsInRange(null, remoteTip).length
        : isAncestorOf(tracking, remoteTip)
          ? listCommitsInRange(tracking, remoteTip).length
          : null;

    console.log(`${m.remote} (target: ${m.syncTargetBranch}, paths: ${m.syncPaths.join(' ')})`);
    console.log(`  tracking:  ${tracking ? tracking.slice(0, 8) : '(not bootstrapped)'}`);
    console.log(`  remote:    ${remoteTip ? remoteTip.slice(0, 8) : '(not fetched)'}`);
    if (behind === null) {
      if (!remoteTip) {
        console.log('  behind:    unknown (not fetched)');
      } else {
        console.log('  behind:    unknown (force-push or disjoint-history tracking ref)');
      }
    } else if (!tracking) {
      console.log(`  behind:    ${behind} commit${behind === 1 ? '' : 's'} (full-history replay pending)`);
    } else {
      console.log(`  behind:    ${behind} commit${behind === 1 ? '' : 's'}`);
    }
  }
  return 0;
}
