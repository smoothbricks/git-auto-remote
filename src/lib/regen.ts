import { execFileSync, spawnSync } from 'node:child_process';
import { git, hasStagedChanges, readCommitMeta } from './git.js';

/**
 * Outcome of running the configured `regenerateCommand`:
 *
 *   'ok'               - command succeeded; regen paths inside scope were
 *                        processed per the caller's mode (amended into HEAD,
 *                        or left staged for the caller to commit).
 *   'command-failed'   - command exited non-zero; nothing amended or staged.
 *                        Callers MUST propagate this as a hard error (halt
 *                        the pull, do not advance tracking) - silently
 *                        skipping causes silent state drift across commits.
 *   'leaked-out-scope' - command succeeded BUT modified paths OUTSIDE
 *                        regeneratePaths. Those leaked paths stay unstaged
 *                        in the worktree; only regen-scope paths were
 *                        processed. The next `mirror pull` will refuse with
 *                        dirty-tree, surfacing the config bug. Callers MAY
 *                        treat this as 'ok' for progress purposes (the
 *                        staged/amended content is correct) but should be
 *                        aware the worktree is dirty.
 */
export type RegenerateOutcome = 'ok' | 'command-failed' | 'leaked-out-scope';

/**
 * How the caller wants the regenerated in-scope content handled:
 *
 *   'amend'      - stage the in-scope changes and `git commit --amend --no-edit`
 *                  onto HEAD. Used by sub-case B (after git am applied the
 *                  included subset) and clean-range (amend onto the last
 *                  commit of the range).
 *
 *   'stage-only' - stage the in-scope changes, do NOT commit. Used by
 *                  sub-case C (no HEAD carrier commit to amend onto). Caller
 *                  decides what to do with the staged index - either create
 *                  a synthesized commit with source metadata (empty-review
 *                  case) or leave it staged under a pure-review-pause so
 *                  `mirror continue` commits it alongside user-staged review
 *                  hunks.
 */
export type RegenerateMode = 'amend' | 'stage-only';

export type RegenerateResult = {
  outcome: RegenerateOutcome;
  /**
   * True iff at least one path within `regeneratePaths` was modified AND
   * staged. False when the command was a no-op (regen output already matched
   * existing state) or when outcome is 'command-failed'. Informs the caller
   * in 'stage-only' mode whether a commit should be synthesized.
   */
  staged: boolean;
};

/**
 * Run the configured `regenerateCommand` and handle the resulting changes
 * per `mode`. Safety contract: the command may produce changes only inside
 * `regeneratePaths`; paths modified outside that scope are left unstaged
 * and surfaced via warning (returned as 'leaked-out-scope').
 *
 * Two call sites use this:
 *
 *   - Clean range / sub-case B (mode='amend'): after `git am` created the
 *     HEAD commit for the included subset, amend the regen output into
 *     that commit, preserving its author + author-date via --no-edit.
 *
 *   - Sub-case C (mode='stage-only'): no HEAD carrier exists. Stage the
 *     regen output; caller creates a fresh commit with source metadata
 *     (empty-review case) or leaves staged content for `mirror continue`
 *     to pick up alongside review hunks (pure-review-pause case).
 *
 * v0.5.9: error propagation. Previously the return value was `RegenerateOutcome`
 * and all callers ignored it. Now callers MUST check `result.outcome` and
 * halt on 'command-failed' - silent "continue on failure" caused stale
 * derived state to compound across commits (the motivation for v0.5.9).
 */
export function runRegenerate(
  command: string,
  regeneratePaths: readonly string[],
  remote: string,
  mode: RegenerateMode = 'amend',
): RegenerateResult {
  console.error(`[mirror ${remote}]   regenerating: ${command}`);
  const r = spawnSync('sh', ['-c', command], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if ((r.status ?? 0) !== 0) {
    console.error(
      `[mirror ${remote}]   regenerateCommand exited ${r.status}; halting (fix the command and re-run 'mirror pull').`,
    );
    return { outcome: 'command-failed', staged: false };
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
      `[mirror ${remote}]     (those changes stay unstaged; only regeneratePaths processed. Fix your command or widen regeneratePaths.)`,
    );
  }

  if (inside.length === 0) {
    // Nothing to stage/amend.
    return {
      outcome: outside.length === 0 ? 'ok' : 'leaked-out-scope',
      staged: false,
    };
  }

  // Stage the in-scope changes explicitly by path - don't blanket `git add -A`
  // or we'd absorb the leaked out-of-scope content.
  git('add', '--', ...inside);
  if (!hasStagedChanges()) {
    // Staging no-oped (unlikely, but guard). Probably because the paths are
    // untracked + matching gitignore. Surface a message.
    console.error(`[mirror ${remote}]   regen: nothing to stage after add; skipping.`);
    return {
      outcome: outside.length === 0 ? 'ok' : 'leaked-out-scope',
      staged: false,
    };
  }

  if (mode === 'stage-only') {
    // Caller handles commit creation.
    return {
      outcome: outside.length === 0 ? 'ok' : 'leaked-out-scope',
      staged: true,
    };
  }

  // mode === 'amend': amend the staged content into HEAD.
  //
  // v0.6.0: preserve committer = author on the amended commit. Without
  // GIT_COMMITTER_* env, `git commit --amend --no-edit` would refresh
  // committer to the current user, breaking the invariant that applyRange
  // established for the just-applied commit.
  const headMeta = readCommitMeta('HEAD');
  const amendEnv = {
    ...process.env,
    GIT_COMMITTER_NAME: headMeta.authorName,
    GIT_COMMITTER_EMAIL: headMeta.authorEmail,
    GIT_COMMITTER_DATE: headMeta.authorDate,
  };
  const amend = spawnSync('git', ['commit', '--amend', '--no-edit'], {
    env: amendEnv,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if ((amend.status ?? 0) !== 0) {
    console.error(`[mirror ${remote}]   git commit --amend failed after regen.`);
    return { outcome: 'command-failed', staged: true };
  }
  return {
    outcome: outside.length === 0 ? 'ok' : 'leaked-out-scope',
    staged: true,
  };
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
