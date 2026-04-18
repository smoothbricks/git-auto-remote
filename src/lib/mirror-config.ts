import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { git, gitTry } from './git.js';

/**
 * Per-remote mirror configuration read from git config under `auto-remote.<name>.*`.
 * A remote becomes a "mirror" implicitly by having `syncPaths` (or `syncPathsFile`) set.
 */
export type MirrorConfig = {
  /** The git remote name. */
  remote: string;
  /** Pathspecs (allowlist) to include when replaying commits from the mirror. */
  syncPaths: readonly string[];
  /** Pathspecs that are never synced, even if they fall under syncPaths. */
  excludePaths: readonly string[];
  /** Pathspecs whose changes trigger a review pause (worktree overlay). Orthogonal to syncPaths. */
  reviewPaths: readonly string[];
  /**
   * Pathspecs whose changes are dropped from incoming patches and (re-)produced locally
   * by `regenerateCommand` after each apply. Typical targets: bun.lock, generated
   * tsconfig.json references. Orthogonal to syncPaths.
   */
  regeneratePaths: readonly string[];
  /**
   * Shell command (run via `sh -c`) that produces `regeneratePaths` from current sources.
   * For nix/devenv-based repos whose tools live inside a project env, wrap accordingly:
   *   regenerateCommand = devenv shell -c 'bun i && bun run nx sync'
   * so `bun`/`nx` resolve to the pinned versions regardless of the PATH git inherited.
   */
  regenerateCommand: string | null;
  /** Branch on the mirror to pull from. Default: the remote's HEAD branch, or 'main'. */
  syncBranch: string;
  /** Local branch that receives the replayed commits. Default: remote.name (e.g. 'public'). */
  syncTargetBranch: string;
  /** Optional handler command path to invoke on partial commits. */
  partialHandler: string | null;
  /**
   * When true, `mirror pull` pushes the tracking ref to the remote after advancing it,
   * so the sync state is durable across fresh CI clones. Default: true.
   */
  pushSyncRef: boolean;
};

/** List all remotes that are configured as mirrors (have syncPaths or syncPathsFile set). */
export function listMirrorConfigs(): MirrorConfig[] {
  // Git lower-cases the final key segment on storage.
  const out = gitTry('config', '--get-regexp', '^auto-remote\\..+\\.(syncpaths|syncpathsfile)');
  if (!out) return [];
  const remotes = new Set<string>();
  for (const line of out.split('\n')) {
    const match = line.match(/^auto-remote\.(.+)\.(syncpaths|syncpathsfile)\s/i);
    if (match) remotes.add(match[1]);
  }
  return [...remotes]
    .map((r) => getMirrorConfig(r))
    .filter((c): c is MirrorConfig => c !== null);
}

export function getMirrorConfig(remote: string): MirrorConfig | null {
  const syncPaths = readPathList(remote, 'syncPaths');
  if (syncPaths.length === 0) return null;

  const excludePaths = readPathList(remote, 'excludePaths');
  const reviewPaths = readPathList(remote, 'reviewPaths');
  const regeneratePaths = readPathList(remote, 'regeneratePaths');
  const regenerateCommand = gitTry('config', '--get', `auto-remote.${remote}.regenerateCommand`);

  const syncBranch =
    gitTry('config', '--get', `auto-remote.${remote}.syncBranch`) ??
    detectRemoteHead(remote) ??
    'main';

  const syncTargetBranch =
    gitTry('config', '--get', `auto-remote.${remote}.syncTargetBranch`) ?? remote;

  const partialHandler = gitTry('config', '--get', `auto-remote.${remote}.partialHandler`);

  const pushSyncRefRaw = gitTry('config', '--get', `auto-remote.${remote}.pushSyncRef`);
  const pushSyncRef = pushSyncRefRaw === null ? true : pushSyncRefRaw !== 'false';

  return {
    remote,
    syncPaths,
    excludePaths,
    reviewPaths,
    regeneratePaths,
    regenerateCommand: regenerateCommand || null,
    syncBranch,
    syncTargetBranch,
    partialHandler: partialHandler || null,
    pushSyncRef,
  };
}

/**
 * Read a path list from git config, merging inline `auto-remote.X.<key>`
 * (whitespace-split) and file-referenced `auto-remote.X.<key>File`
 * (newline-separated with # comments, like .gitignore).
 */
function readPathList(remote: string, key: string): string[] {
  const paths: string[] = [];

  const inline = gitTry('config', '--get', `auto-remote.${remote}.${key}`);
  if (inline) {
    for (const p of inline.split(/\s+/)) {
      if (p.length > 0) paths.push(p);
    }
  }

  const filePath = gitTry('config', '--get', `auto-remote.${remote}.${key}File`);
  if (filePath) {
    for (const p of readPathsFile(filePath)) paths.push(p);
  }

  return paths;
}

/**
 * Load newline-separated paths from a file, resolving relative to the repo root.
 * Strips `#` comments and blank lines. Throws if the file is missing - a misconfigured
 * `*File` key is a bug we want to surface loudly.
 */
function readPathsFile(filePath: string): string[] {
  const root = git('rev-parse', '--show-toplevel');
  // v0.7.0 MEDIUM-3 (see 2026-04-18-audit.md): Support absolute paths directly
  const full = isAbsolute(filePath) ? filePath : join(root, filePath);
  const content = readFileSync(full, 'utf8');
  const out: string[] = [];
  for (const rawLine of content.split('\n')) {
    // v0.7.0 MEDIUM-3 (see 2026-04-18-audit.md): Strip CRLF line endings before trimming
    const line = rawLine.replace(/\r$/, '').replace(/#.*$/, '').trim();
    if (line.length > 0) out.push(line);
  }
  return out;
}

/** Read refs/remotes/<remote>/HEAD to discover its default branch. */
function detectRemoteHead(remote: string): string | null {
  const symbolic = gitTry('symbolic-ref', `refs/remotes/${remote}/HEAD`);
  if (!symbolic) return null;
  const prefix = `refs/remotes/${remote}/`;
  return symbolic.startsWith(prefix) ? symbolic.slice(prefix.length) : null;
}
