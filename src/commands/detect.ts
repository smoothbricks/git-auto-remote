import { isAncestorOf, revParse } from '../lib/git.js';
import { collectRemotes } from '../lib/remotes.js';
import { decideRouting } from '../lib/routing.js';

/** Show ancestry analysis for a given ref (default: HEAD). */
export function detect(ref: string = 'HEAD'): number {
  const sha = revParse(ref);
  if (!sha) {
    console.error(`[git-auto-remote] Unknown ref: ${ref}`);
    return 1;
  }

  const remotes = collectRemotes();
  console.log(`Analyzing ${ref} (${sha.slice(0, 8)}):\n`);

  for (const r of remotes) {
    if (r.roots.length === 0) {
      console.log(`  ${r.name}: no roots detected`);
      continue;
    }
    const matches = r.roots.filter((root) => isAncestorOf(root, sha));
    const label =
      matches.length === 0 ? 'NOT a descendant' : `descends from ${matches.map((m) => m.slice(0, 8)).join(', ')}`;
    console.log(`  ${r.name}: ${label}`);
  }

  const decision = decideRouting(remotes, (s) => isAncestorOf(s, sha), null);
  console.log(`\nDecision: ${JSON.stringify(decision)}`);
  return 0;
}
