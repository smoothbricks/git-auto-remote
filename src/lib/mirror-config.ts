import { gitTry } from './git.js';

/**
 * Per-remote mirror configuration read from git config under `fork-remote.<name>.*`.
 * A remote becomes a "mirror" implicitly by having `syncPaths` set.
 */
export type MirrorConfig = {
  /** The git remote name. */
  remote: string;
  /** Pathspecs (allowlist) to include when replaying commits from the mirror. */
  syncPaths: readonly string[];
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

/** List all remotes that are configured as mirrors (have syncPaths set). */
export function listMirrorConfigs(): MirrorConfig[] {
  // Git config normalizes the final segment of a key to lowercase on storage,
  // so `fork-remote.X.syncPaths` is stored and returned as `fork-remote.X.syncpaths`.
  const regex = '^fork-remote\\..+\\.syncpaths';
  const out = gitTry('config', '--get-regexp', regex);
  if (!out) return [];
  const remotes = new Set<string>();
  for (const line of out.split('\n')) {
    const match = line.match(/^fork-remote\.(.+)\.syncpaths\s/i);
    if (match) remotes.add(match[1]);
  }
  return [...remotes]
    .map((r) => getMirrorConfig(r))
    .filter((c): c is MirrorConfig => c !== null);
}

export function getMirrorConfig(remote: string): MirrorConfig | null {
  const syncPathsRaw = gitTry('config', '--get', `fork-remote.${remote}.syncPaths`);
  if (!syncPathsRaw) return null;
  const syncPaths = syncPathsRaw.split(/\s+/).filter((p) => p.length > 0);
  if (syncPaths.length === 0) return null;

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
    syncBranch,
    syncTargetBranch,
    partialHandler: partialHandler || null,
    pushSyncRef,
  };
}

/** Read refs/remotes/<remote>/HEAD to discover its default branch. */
function detectRemoteHead(remote: string): string | null {
  const symbolic = gitTry('symbolic-ref', `refs/remotes/${remote}/HEAD`);
  if (!symbolic) return null;
  const prefix = `refs/remotes/${remote}/`;
  return symbolic.startsWith(prefix) ? symbolic.slice(prefix.length) : null;
}
