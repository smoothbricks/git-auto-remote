import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitTry } from './git.js';

/**
 * Per-remote mirror configuration read from git config under `fork-remote.<name>.*`.
 * A remote becomes a "mirror" implicitly by having `syncPaths` (or `syncPathsFile`) set.
 */
export type MirrorConfig = {
  /** The git remote name. */
  remote: string;
  /** Pathspecs (allowlist) to include when replaying commits from the mirror. */
  syncPaths: readonly string[];
  /** Pathspecs that are never synced, even if they fall under syncPaths. */
  excludePaths: readonly string[];
  /** Pathspecs (subset of syncPaths) whose changes always trigger a review pause. */
  reviewPaths: readonly string[];
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
  const out = gitTry('config', '--get-regexp', '^fork-remote\\..+\\.(syncpaths|syncpathsfile)');
  if (!out) return [];
  const remotes = new Set<string>();
  for (const line of out.split('\n')) {
    const match = line.match(/^fork-remote\.(.+)\.(syncpaths|syncpathsfile)\s/i);
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

  const syncBranch =
    gitTry('config', '--get', `fork-remote.${remote}.syncBranch`) ??
    detectRemoteHead(remote) ??
    'main';

  const syncTargetBranch =
    gitTry('config', '--get', `fork-remote.${remote}.syncTargetBranch`) ?? remote;

  const partialHandler = gitTry('config', '--get', `fork-remote.${remote}.partialHandler`);

  const pushSyncRefRaw = gitTry('config', '--get', `fork-remote.${remote}.pushSyncRef`);
  const pushSyncRef = pushSyncRefRaw === null ? true : pushSyncRefRaw !== 'false';

  return {
    remote,
    syncPaths,
    excludePaths,
    reviewPaths,
    syncBranch,
    syncTargetBranch,
    partialHandler: partialHandler || null,
    pushSyncRef,
  };
}

/**
 * Read a path list from git config, merging inline `fork-remote.X.<key>`
 * (whitespace-split) and file-referenced `fork-remote.X.<key>File`
 * (newline-separated with # comments, like .gitignore).
 */
function readPathList(remote: string, key: string): string[] {
  const paths: string[] = [];

  const inline = gitTry('config', '--get', `fork-remote.${remote}.${key}`);
  if (inline) {
    for (const p of inline.split(/\s+/)) {
      if (p.length > 0) paths.push(p);
    }
  }

  const filePath = gitTry('config', '--get', `fork-remote.${remote}.${key}File`);
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
function readPathsFile(relativePath: string): string[] {
  const root = git('rev-parse', '--show-toplevel');
  const full = join(root, relativePath);
  const content = readFileSync(full, 'utf8');
  const out: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
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
