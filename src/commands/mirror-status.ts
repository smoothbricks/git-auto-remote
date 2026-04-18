import { execFileSync } from 'node:child_process';
import { amInProgress, currentBranch, gitTry, isAncestorOf, listCommitsInRange, revParse } from '../lib/git.js';
import { getMirrorConfig, listMirrorConfigs } from '../lib/mirror-config.js';
import { getReviewPending, readTrackingRef } from '../lib/mirror-state.js';

/**
 * Show the local mirror state for one or all configured mirrors.
 *
 * With `--remotes` (showRemotes=true), additionally enumerates each
 * mirror remote's `refs/git-auto-remote/mirror/*` via `git ls-remote`
 * and shows side-by-side comparison vs local. Useful for diagnosing
 * cross-clone drift (e.g. CI pushed updated tracking refs that local
 * hasn't fetched, OR local rolled back and remote is now ahead).
 *
 * Network call cost: one `git ls-remote` per mirror remote when
 * --remotes is set. Default omits to keep status fast.
 */
export function mirrorStatus(remoteArg?: string, options: { showRemotes?: boolean } = {}): number {
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

  for (let i = 0; i < mirrors.length; i++) {
    if (i > 0) console.log('');
    const m = mirrors[i];
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

    // Header: just the routing arrow (`<source>/<branch> -> <target>`).
    // Path lists used to be inlined here but exploded the line width on real
    // configs (Conloca's syncPaths is 24 entries). Counts moved to a
    // dedicated `config:` line below; full lists are in `mirror list`.
    console.log(`${m.remote}  (${m.syncBranch} -> ${m.syncTargetBranch})`);
    const configBits: string[] = [`${m.syncPaths.length} sync`];
    if (m.reviewPaths.length > 0) configBits.push(`${m.reviewPaths.length} review`);
    if (m.regeneratePaths.length > 0) configBits.push(`${m.regeneratePaths.length} regenerate`);
    if (m.excludePaths.length > 0) configBits.push(`${m.excludePaths.length} excluded`);
    console.log(`  config:    ${configBits.join(', ')}  (use 'mirror list' for full paths)`);
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

    if (options.showRemotes) {
      printRemoteMirrorRefs(m.remote);
    }
  }
  return 0;
}

/**
 * Enumerate `refs/git-auto-remote/mirror/*` ON the given remote (via
 * `git ls-remote`) and compare each entry to the local same-named ref.
 * Surfaces cross-clone drift between local authoritative state and what
 * the remote is currently advertising.
 *
 * Reads remote refs over the network (one `ls-remote` call). Errors
 * (network, auth, missing remote) are caught and reported; the caller's
 * exit code is unaffected.
 *
 * SECURITY NOTE: any `mirror/<other-remote>/*` entry shown for this
 * remote indicates a cross-direction ref - the SHA originated on
 * <other-remote>, not on this one. If <other-remote> contains private
 * content and this remote is public-facing, the cross-direction ref
 * exposes <other-remote>'s full commit ancestry (and therefore source
 * code) on this remote's object DB to anyone who fetches the ref. See
 * mirror-bootstrap.ts docstring for the same-direction-only push
 * refspec rule that prevents this leak.
 */
function printRemoteMirrorRefs(remote: string): void {
  console.log(`  refs on remote (refs/git-auto-remote/mirror/*):`);
  let raw: string;
  try {
    raw = execFileSync('git', ['ls-remote', remote, 'refs/git-auto-remote/mirror/*'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stderr?: Buffer | string };
    const stderr = (e.stderr ? Buffer.from(e.stderr).toString() : '').trim();
    console.log(`    (ls-remote failed: ${stderr || 'unreachable'})`);
    return;
  }

  const lines = raw.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) {
    console.log('    (no mirror refs on remote)');
    return;
  }

  // Parse "<sha>\t<refname>" lines.
  const remoteRefs: { refname: string; sha: string }[] = [];
  for (const line of lines) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const sha = line.slice(0, tab);
    const refname = line.slice(tab + 1);
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    remoteRefs.push({ refname, sha });
  }

  // Sort for stable output.
  remoteRefs.sort((a, b) => a.refname.localeCompare(b.refname));

  for (const { refname, sha } of remoteRefs) {
    const localSha = gitTry('rev-parse', '--verify', `${refname}^{commit}`);
    const shortRefname = refname.replace(/^refs\/git-auto-remote\/mirror\//, '');
    if (!localSha) {
      console.log(`    ${shortRefname}  ${sha.slice(0, 8)}  (no local ref)`);
    } else if (localSha === sha) {
      console.log(`    ${shortRefname}  ${sha.slice(0, 8)}  (matches local)`);
    } else {
      console.log(`    ${shortRefname}  ${sha.slice(0, 8)}  (differs from local: ${localSha.slice(0, 8)})`);
    }
  }
}
