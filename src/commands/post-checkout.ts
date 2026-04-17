import { configGet, configSet, currentBranch, gitTry, isAncestorOf, revParse } from '../lib/git.js';
import { collectRemotes } from '../lib/remotes.js';
import { decideRouting } from '../lib/routing.js';

/**
 * post-checkout hook entry point.
 * Args: <prev-head> <new-head> <checkout-type>
 *   checkout-type: 1 = branch checkout, 0 = file checkout
 */
export function postCheckout(args: readonly string[]): number {
  const [prevHead, _newHead, checkoutType] = args;
  if (checkoutType !== '1') return 0; // file checkout, not our concern

  const branch = currentBranch();
  if (!branch) return 0; // detached HEAD - nothing to configure

  // User override: respect any pre-existing pushRemote config.
  if (configGet(`branch.${branch}.pushRemote`)) return 0;

  const remotes = collectRemotes();
  const inherited = inheritedRemoteFrom(prevHead);

  const decision = decideRouting(remotes, (sha) => isAncestorOf(sha, 'HEAD'), inherited);

  switch (decision.kind) {
    case 'no-remotes':
    case 'no-match':
      return 0;

    case 'shared-history': {
      if (decision.inheritedRemote) {
        configSet(`branch.${branch}.pushRemote`, decision.inheritedRemote);
        console.error(`[git-auto-remote] '${branch}' -> pushRemote='${decision.inheritedRemote}' (inherited)`);
      }
      return 0;
    }

    case 'single-match': {
      configSet(`branch.${branch}.pushRemote`, decision.remote);
      console.error(`[git-auto-remote] '${branch}' -> pushRemote='${decision.remote}'`);
      return 0;
    }

    case 'multi-match': {
      console.error(
        `[git-auto-remote] WARNING: '${branch}' descends from multiple fork roots: ${decision.remotes.join(', ')}.`,
      );
      console.error(`[git-auto-remote] Histories appear to be merged. NOT auto-configuring pushRemote.`);
      console.error(`[git-auto-remote] Set manually: git config branch.${branch}.pushRemote <remote>`);
      return 0;
    }
  }
}

/**
 * Determine which remote the previous HEAD's branch was routed to.
 * Used for the shared-history case (mirrors/single-upstream): new branches inherit.
 */
function inheritedRemoteFrom(prevHead: string | undefined): string | null {
  if (!prevHead) return null;
  const prevBranch = findBranchAtCommit(prevHead);
  if (!prevBranch) return null;
  return configGet(`branch.${prevBranch}.pushRemote`);
}

function findBranchAtCommit(sha: string): string | null {
  const resolved = revParse(sha);
  if (!resolved) return null;
  const out = gitTry('for-each-ref', '--format=%(refname:short)', '--points-at', resolved, 'refs/heads/');
  if (!out) return null;
  const first = out.split('\n')[0];
  return first || null;
}
