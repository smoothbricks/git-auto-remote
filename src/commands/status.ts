import { configGet, currentBranch, isAncestorOf } from '../lib/git.js';
import { hookStatus } from '../lib/hooks.js';
import { collectRemotes } from '../lib/remotes.js';
import { decideRouting } from '../lib/routing.js';

export function status(): number {
  const remotes = collectRemotes();

  console.log('Remotes:');
  if (remotes.length === 0) {
    console.log('  (none)');
  } else {
    for (const r of remotes) {
      const rootsLabel =
        r.roots.length === 0 ? '(no roots detected - fetch the remote?)' : r.roots.map((s) => s.slice(0, 8)).join(', ');
      console.log(`  ${r.name}: ${rootsLabel}`);
    }
  }

  console.log('\nHooks:');
  for (const hook of ['post-checkout', 'pre-push'] as const) {
    console.log(`  ${hook}: ${hookStatus(hook)}`);
  }

  const branch = currentBranch();
  console.log('\nCurrent branch:');
  if (!branch) {
    console.log('  (detached HEAD)');
    return 0;
  }
  const configured = configGet(`branch.${branch}.pushRemote`);
  const decision = decideRouting(remotes, (sha) => isAncestorOf(sha, 'HEAD'), null);
  console.log(`  name: ${branch}`);
  console.log(`  configured pushRemote: ${configured ?? '(none)'}`);
  console.log(`  routing decision: ${formatDecision(decision)}`);
  return 0;
}

function formatDecision(d: ReturnType<typeof decideRouting>): string {
  switch (d.kind) {
    case 'no-remotes':
      return 'no remotes configured';
    case 'no-match':
      return 'no matching remote';
    case 'single-match':
      return `route to '${d.remote}'`;
    case 'multi-match':
      return `AMBIGUOUS - multiple matches: ${d.remotes.join(', ')}`;
    case 'shared-history':
      return `shared history across remotes (inherit: ${d.inheritedRemote ?? 'none'})`;
  }
}
