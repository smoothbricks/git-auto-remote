import { execFileSync, spawnSync } from 'node:child_process';
import { git, hasStagedChanges } from './git.js';

/**
 * Run the configured `regenerateCommand` after a range or partial's apply and
 * amend the resulting changes into HEAD (preserving author + author-date via
 * `--amend --no-edit`).
 *
 * Safety contract: the command may produce changes ONLY inside `regeneratePaths`.
 * If it touches anything outside, we do NOT amend those paths - they stay as
 * dirty worktree state and will trip the `mirror pull` dirty-tree precondition
 * on the next iteration, surfacing the config bug to the user.
 *
 * @returns
 *   'ok'                - command succeeded and HEAD was amended (or no changes needed)
 *   'command-failed'    - command exited non-zero; nothing amended
 *   'leaked-out-scope'  - command modified paths outside regeneratePaths; those stay
 *                         dirty in the worktree (config error surfaced upstream)
 */
export type RegenerateOutcome = 'ok' | 'command-failed' | 'leaked-out-scope';

export function runRegenerate(
  command: string,
  regeneratePaths: readonly string[],
  remote: string,
): RegenerateOutcome {
  console.error(`[mirror ${remote}]   regenerating: ${command}`);
  const r = spawnSync('sh', ['-c', command], { stdio: ['ignore', 'inherit', 'inherit'] });
  if ((r.status ?? 0) !== 0) {
    console.error(
      `[mirror ${remote}]   regenerateCommand exited ${r.status}; leaving HEAD as-is (no amend).`,
    );
    return 'command-failed';
  }

  // What did the command change? Look at the full worktree (tracked + untracked)
  // diff against HEAD to catch both modifications and newly-created files.
  const modified = listModifiedVsHead();

  // Partition into "inside regenerate scope" vs "outside".
  const inside: string[] = [];
  const outside: string[] = [];
  for (const p of modified) {
    if (matchesAny(p, regeneratePaths)) inside.push(p);
    else outside.push(p);
  }

  if (outside.length > 0) {
    console.error(
      `[mirror ${remote}]   regenerateCommand modified paths outside regeneratePaths: ${outside.join(', ')}`,
    );
    console.error(
      `[mirror ${remote}]     (those changes stay unstaged; only regeneratePaths amended. Fix your command or widen regeneratePaths.)`,
    );
  }

  if (inside.length === 0) {
    // Nothing to amend. (Either no change or all changes leaked.)
    return outside.length === 0 ? 'ok' : 'leaked-out-scope';
  }

  // Stage the in-scope changes explicitly by path - don't blanket `git add -A`
  // or we'd absorb the leaked out-of-scope content.
  git('add', '--', ...inside);
  if (!hasStagedChanges()) {
    // Staging no-oped (unlikely, but guard). Probably because the paths are
    // untracked + matching gitignore. Surface a message.
    console.error(`[mirror ${remote}]   regen: nothing to stage after add; skipping amend.`);
    return outside.length === 0 ? 'ok' : 'leaked-out-scope';
  }
  const amend = spawnSync('git', ['commit', '--amend', '--no-edit'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if ((amend.status ?? 0) !== 0) {
    console.error(`[mirror ${remote}]   git commit --amend failed after regen.`);
    return 'command-failed';
  }
  return outside.length === 0 ? 'ok' : 'leaked-out-scope';
}

/**
 * Return the list of paths the working tree currently differs from HEAD on.
 * Covers modified-tracked, deleted-tracked, and untracked files. Uses
 * `git status --porcelain=v1 -z` (NUL-delimited) to avoid ambiguity with
 * whitespace-stripping and rename separators.
 *
 * -z format per entry: "XY path\0" where X+Y is 2 chars of status. For rename
 *  entries: "XY new\0old\0". We want new path; skip the old by advancing.
 */
function listModifiedVsHead(): string[] {
  let raw: string;
  try {
    raw = execFileSync('git', ['status', '--porcelain=v1', '-z', '-uall'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return [];
  }
  if (raw.length === 0) return [];

  const tokens = raw.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (entry.length < 4) continue; // empty trailing token
    const status = entry.slice(0, 2);
    // Entry format: "XY<space>path" -> skip 3 chars to get the path.
    const path = entry.slice(3);
    paths.push(path);
    // Renames (R) and copies (C) have the "old name" as the next NUL-separated token.
    if (status[0] === 'R' || status[0] === 'C') {
      i += 1; // consume the old path token
    }
  }
  return paths;
}

function matchesAny(path: string, specs: readonly string[]): boolean {
  return specs.some((s) => path === s || path.startsWith(s + '/'));
}
