import { existsSync, readFileSync } from 'node:fs';
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
   * Runs after each apply when the source commit touched any regeneratePaths. Null = none.
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

/** Git lower-cases the final key segment on storage. */
const MIRROR_KEY_RE = '^auto-remote\\..+\\.(syncpaths|syncpathsfile)';

/**
 * Resolve the committed mirror-config file, if any. A repo can ship its
 * `[auto-remote "..."]` sections in a worktree file so a fresh CI clone (or an
 * agent in a blank session) recognizes its mirrors WITHOUT a host-specific
 * bootstrap that stamps `.git/config`. Resolution order:
 *
 *   1. `git config auto-remote.configFile <path>` (relative to repo root, or absolute)
 *   2. repo-root `auto-remote.gitconfig`
 *   3. `tooling/auto-remote.gitconfig`
 *
 * Returns an absolute path to an existing file, or null when none is present.
 * An explicit `configFile` that points at a missing file is a hard error - a
 * misconfiguration we surface loudly rather than silently treating the repo as
 * having no mirrors.
 */
export function committedConfigPath(): string | null {
  const root = gitTry('rev-parse', '--show-toplevel');

  const explicit = gitTry('config', '--get', 'auto-remote.configFile');
  if (explicit) {
    const full = isAbsolute(explicit) ? explicit : root ? join(root, explicit) : explicit;
    if (!existsSync(full)) {
      throw new Error(
        `auto-remote.configFile points at '${explicit}' but that file does not exist (resolved to '${full}'). ` +
          `Create the committed config file or unset the key: git config --unset auto-remote.configFile`,
      );
    }
    return full;
  }

  if (!root) return null;
  for (const rel of ['auto-remote.gitconfig', 'tooling/auto-remote.gitconfig']) {
    const candidate = join(root, rel);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Read a key with committed-file fallback: standard `git config` wins, the
 * committed file fills in anything the host has not overridden.
 */
function mergedGet(committed: string | null, key: string): string | null {
  const standard = gitTry('config', '--get', key);
  if (standard !== null) return standard;
  return committed ? gitTry('config', '--file', committed, '--get', key) : null;
}

/** Collect remote names whose syncpaths/syncpathsfile key appears in `getRegexpOut`. */
function collectMirrorRemotes(getRegexpOut: string | null, into: Set<string>): void {
  if (!getRegexpOut) return;
  for (const line of getRegexpOut.split('\n')) {
    const match = line.match(/^auto-remote\.(.+)\.(syncpaths|syncpathsfile)\s/i);
    if (match) into.add(match[1]);
  }
}

/** List all remotes that are configured as mirrors (have syncPaths or syncPathsFile set). */
export function listMirrorConfigs(): MirrorConfig[] {
  const committed = committedConfigPath();
  const remotes = new Set<string>();
  collectMirrorRemotes(gitTry('config', '--get-regexp', MIRROR_KEY_RE), remotes);
  if (committed) collectMirrorRemotes(gitTry('config', '--file', committed, '--get-regexp', MIRROR_KEY_RE), remotes);
  return [...remotes].map((r) => getMirrorConfig(r)).filter((c): c is MirrorConfig => c !== null);
}

export function getMirrorConfig(remote: string): MirrorConfig | null {
  const committed = committedConfigPath();

  const syncPaths = readPathList(remote, 'syncPaths', committed);
  if (syncPaths.length === 0) return null;

  const excludePaths = readPathList(remote, 'excludePaths', committed);
  const reviewPaths = readPathList(remote, 'reviewPaths', committed);
  const regeneratePaths = readPathList(remote, 'regeneratePaths', committed);
  const regenerateCommand = mergedGet(committed, `auto-remote.${remote}.regenerateCommand`);

  const syncBranch =
    mergedGet(committed, `auto-remote.${remote}.syncBranch`) ?? detectRemoteHead(remote) ?? 'main';

  const syncTargetBranch = mergedGet(committed, `auto-remote.${remote}.syncTargetBranch`) ?? remote;

  const partialHandler = mergedGet(committed, `auto-remote.${remote}.partialHandler`);

  const pushSyncRefRaw = mergedGet(committed, `auto-remote.${remote}.pushSyncRef`);
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
 * Read a path list, merging inline `auto-remote.X.<key>` (whitespace-split)
 * and file-referenced `auto-remote.X.<key>File` (newline-separated with #
 * comments, like .gitignore). Both the inline key and the file key prefer a
 * standard `git config` value, falling back to the committed config file.
 */
function readPathList(remote: string, key: string, committed: string | null): string[] {
  const paths: string[] = [];

  const inline = mergedGet(committed, `auto-remote.${remote}.${key}`);
  if (inline) {
    for (const p of inline.split(/\s+/)) {
      if (p.length > 0) paths.push(p);
    }
  }

  const filePath = mergedGet(committed, `auto-remote.${remote}.${key}File`);
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
  if (!existsSync(full)) {
    throw new Error(
      `syncPathsFile/excludePathsFile/... points at '${filePath}' but that file does not exist (resolved to '${full}').`,
    );
  }
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
