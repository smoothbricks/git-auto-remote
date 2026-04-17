import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Thin wrapper around `git` invocations.
 * Stays synchronous - hooks run fast and sync code is simpler to reason about.
 */

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: readonly string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** Run git and return stdout. Throws GitError on non-zero exit. */
export function git(...args: string[]): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const e = err as { status?: number | null; stderr?: Buffer | string };
    const stderr = e.stderr ? e.stderr.toString() : '';
    throw new GitError(`git ${args.join(' ')} failed: ${stderr}`, args, e.status ?? null, stderr);
  }
}

/** Run git, return stdout on success or null on failure (for probing commands). */
export function gitTry(...args: string[]): string | null {
  try {
    return git(...args);
  } catch {
    return null;
  }
}

/** List of remote names (`git remote`). */
export function listRemotes(): string[] {
  const out = gitTry('remote');
  if (!out) return [];
  return out.split('\n').filter((line) => line.length > 0);
}

/** Root commits (parentless commits) reachable from any ref under `refs/remotes/<remoteName>/`. */
export function findRemoteRoots(remoteName: string): string[] {
  const out = gitTry('rev-list', '--max-parents=0', '--remotes=' + remoteName);
  if (!out) return [];
  return out.split('\n').filter((line) => line.length > 0);
}

/** True iff `ancestor` is an ancestor of `descendant` (or they are equal). */
export function isAncestorOf(ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** Resolve current branch name, or null if in detached HEAD. */
export function currentBranch(): string | null {
  const name = gitTry('symbolic-ref', '--short', '-q', 'HEAD');
  return name || null;
}

/** Resolve a ref to a SHA, or null if invalid. */
export function revParse(ref: string): string | null {
  return gitTry('rev-parse', '--verify', '--quiet', ref);
}

/** Return the path to the .git directory (handles worktrees and submodules). */
export function gitDir(): string {
  return git('rev-parse', '--git-dir');
}

/** Read a git config value, returning null if unset. */
export function configGet(key: string): string | null {
  return gitTry('config', '--get', key);
}

/** Set a git config value. */
export function configSet(key: string, value: string): void {
  git('config', key, value);
}

/** Add a git config value to a multi-value key. */
export function configAdd(key: string, value: string): void {
  git('config', '--add', key, value);
}

/** Return all values for a multi-value config key (empty list if unset). */
export function configGetAll(key: string): string[] {
  const out = gitTry('config', '--get-all', key);
  return out ? out.split('\n').filter((l) => l.length > 0) : [];
}

/** True when `.git/rebase-apply/` exists (i.e. `git am` is in progress). */
export function amInProgress(): boolean {
  return existsSync(join(gitDir(), 'rebase-apply'));
}

/** True when the working tree has uncommitted changes (staged or unstaged). */
export function workingTreeDirty(): boolean {
  const out = gitTry('status', '--porcelain');
  return out !== null && out.length > 0;
}

/**
 * True iff the index differs from HEAD (i.e. `git commit` would produce a
 * non-empty commit). `git diff --cached --quiet` exits 0 when clean, 1 when
 * dirty, and we need the exit code directly (gitTry collapses both to its
 * string-or-null contract).
 */
export function hasStagedChanges(): boolean {
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return false;
  } catch {
    return true;
  }
}

/**
 * True iff the working tree has paths in an UNRESOLVED merge/am conflict state.
 * Distinct from `workingTreeDirty()` - we specifically look for porcelain
 * status codes that indicate an unresolved 3-way merge, not plain
 * modifications or additions.
 *
 * Relevant codes (XY in `git status --porcelain`): DD, AU, UD, UA, DU, AA, UU.
 * See git-status(1) "Short Format".
 *
 * Used to distinguish "git am stopped with conflict markers the user can
 * resolve + `git add` + continue" from "git am stopped structurally (fake-
 * ancestor build failure, missing rename source, etc.) where the worktree is
 * clean and the only recovery is skip or abort".
 */
export function hasUnresolvedMergeConflicts(): boolean {
  const out = gitTry('status', '--porcelain');
  if (!out) return false;
  for (const line of out.split('\n')) {
    if (line.length < 2) continue;
    const xy = line.slice(0, 2);
    if (xy === 'DD' || xy === 'AU' || xy === 'UD' || xy === 'UA' || xy === 'DU' || xy === 'AA' || xy === 'UU') {
      return true;
    }
  }
  return false;
}

/** SHAs of commits in the range `from..to`, oldest-first (topological order). */
export function listCommitsInRange(from: string, to: string): string[] {
  const out = gitTry('rev-list', '--reverse', '--topo-order', `${from}..${to}`);
  if (!out) return [];
  return out.split('\n').filter((line) => line.length > 0);
}

/** Paths changed by a single commit (`git diff-tree --name-only`). */
export function changedPaths(sha: string): string[] {
  const out = gitTry('diff-tree', '--no-commit-id', '--name-only', '-r', sha);
  if (!out) return [];
  return out.split('\n').filter((line) => line.length > 0);
}

/** Subject line of a commit. */
export function commitSubject(sha: string): string {
  return gitTry('log', '-1', '--format=%s', sha) ?? '';
}

/**
 * Read author name/email/date + full commit message for a commit. Fields are
 * NUL-separated (%x00) so commit messages with arbitrary whitespace survive
 * intact. Author date is ISO-strict (%aI) - round-trippable via GIT_AUTHOR_DATE.
 *
 * Used by the pure-review-pause code path where we need to re-create a commit
 * from scratch while preserving the source's author + author-date.
 */
export type CommitMeta = {
  authorName: string;
  authorEmail: string;
  authorDate: string;
  message: string;
};

export function readCommitMeta(sha: string): CommitMeta {
  // execFileSync directly so we keep the raw message (no .trim() surprise).
  const out = execFileSync('git', ['show', '-s', '--format=%an%x00%ae%x00%aI%x00%B', sha], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // split with limit 4: first 3 are name/email/date, everything else is message
  // (rejoined with NUL so we don't lose any separator that happened to be in msg).
  const parts = out.split('\x00');
  const [authorName = '', authorEmail = '', authorDate = '', ...rest] = parts;
  // `git show -s --format=%B` appends a single newline after the commit body,
  // and git itself adds a final newline after format output. Strip ALL trailing
  // newlines so `git commit -m <msg>` produces a canonical message.
  const message = rest.join('\x00').replace(/\n+$/, '');
  return { authorName, authorEmail, authorDate, message };
}

/** Quiet `git fetch <remote>`; throws GitError on failure. */
export function fetchRemote(remote: string): void {
  git('fetch', '--quiet', remote);
}
