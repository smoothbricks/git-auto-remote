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
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

/** Quiet `git fetch <remote>`; throws GitError on failure. */
export function fetchRemote(remote: string): void {
  git('fetch', '--quiet', remote);
}
