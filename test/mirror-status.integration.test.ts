import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirrorStatus } from '../src/commands/mirror-status.js';
import { trackingRefName } from '../src/lib/mirror-state.js';

/**
 * Coverage for `mirror status` with the v0.6.2 `--remotes` flag.
 *
 * The flag enumerates each mirror remote's refs/git-auto-remote/mirror/*
 * via `git ls-remote` and compares to local same-named refs. Useful for
 * surfacing cross-clone drift that the default (local-only) status hides.
 *
 * Output paths exercised:
 *   - remote ref matches local         -> "(matches local)"
 *   - remote ref differs from local    -> "(differs from local: <local-sha8>)"
 *   - remote ref has no local sibling  -> "(no local ref)"
 *   - remote has no mirror refs at all -> "(no mirror refs on remote)"
 *   - ls-remote fails (no such remote) -> "(ls-remote failed: ...)"
 */

let root: string;
let upstream: string;
let local: string;
let originalCwd: string;

const TRACKING_UPSTREAM = trackingRefName('upstream');
const ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...ENV },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} in ${cwd} failed:\n${r.stdout}\n${r.stderr}`);
  }
  return (r.stdout ?? '').trim();
}

function captureLog(fn: () => number): { code: number; stdout: string } {
  const orig = console.log;
  let out = '';
  console.log = (...args: unknown[]) => {
    out += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
  };
  let code: number;
  try {
    code = fn();
  } finally {
    console.log = orig;
  }
  return { code, stdout: out };
}

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'gar-mirror-status-'));
  upstream = join(root, 'upstream.git');
  local = join(root, 'local');

  git(root, 'init', '--bare', '-q', upstream);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', seed);
  mkdirSync(join(seed, 'packages/cli'), { recursive: true });
  writeFileSync(join(seed, 'packages/cli/a.ts'), 'pkg A v1\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'pkg: add A');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', upstream);
  git(seed, 'push', '-q', 'origin', 'main');

  git(root, 'init', '-q', local);
  mkdirSync(join(local, 'packages/cli'), { recursive: true });
  writeFileSync(join(local, 'packages/cli/a.ts'), 'pkg A v1\n');
  git(local, 'add', '-A');
  git(local, 'commit', '-q', '-m', 'private: import A');
  git(local, 'branch', '-M', 'private');
  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'fetch', '-q', 'upstream');

  git(local, 'config', 'auto-remote.upstream.syncPaths', 'packages');
  git(local, 'config', 'auto-remote.upstream.syncTargetBranch', 'private');
  git(local, 'config', 'auto-remote.upstream.syncBranch', 'main');
  git(local, 'config', 'auto-remote.upstream.pushSyncRef', 'false');

  // Bootstrap tracking ref on local AND on upstream (matching SHAs).
  const upstreamTip = git(local, 'rev-parse', 'upstream/main');
  git(local, 'update-ref', TRACKING_UPSTREAM, upstreamTip);
  git(upstream, 'update-ref', TRACKING_UPSTREAM, upstreamTip);

  process.chdir(local);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('mirror status (default, no --remotes)', () => {
  test('does NOT call ls-remote (no remote refs section in output)', () => {
    const { code, stdout } = captureLog(() => mirrorStatus('upstream'));
    expect(code).toBe(0);
    expect(stdout).toContain('upstream');
    expect(stdout).toContain('tracking:');
    expect(stdout).toContain('remote:');
    expect(stdout).toContain('behind:');
    // Default omits the network-call section entirely.
    expect(stdout).not.toContain('refs on remote');
    expect(stdout).not.toContain('matches local');
  });
});

describe('mirror status --remotes (v0.6.2)', () => {
  test('prints "matches local" when remote ref equals local ref', () => {
    const { code, stdout } = captureLog(() => mirrorStatus('upstream', { showRemotes: true }));
    expect(code).toBe(0);
    expect(stdout).toContain('refs on remote (refs/git-auto-remote/mirror/*):');
    expect(stdout).toContain('upstream/last-synced');
    expect(stdout).toContain('(matches local)');
    expect(stdout).not.toContain('(differs from local');
    expect(stdout).not.toContain('(no local ref)');
  });

  test('prints "differs from local: <sha8>" when remote ref ahead of local', () => {
    // Add a new commit upstream and update upstream's tracking ref to the new tip,
    // while local stays at the original bootstrap SHA. Simulates: another clone
    // (CI) processed a commit and pushed the updated tracking ref to remote.
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/cli/b.ts'), 'pkg B v1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'pkg: add B');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    const newTip = git(local, 'rev-parse', 'upstream/main');
    git(upstream, 'update-ref', TRACKING_UPSTREAM, newTip);

    const localSha = git(local, 'rev-parse', TRACKING_UPSTREAM);
    expect(localSha).not.toBe(newTip);

    const { code, stdout } = captureLog(() => mirrorStatus('upstream', { showRemotes: true }));
    expect(code).toBe(0);
    expect(stdout).toContain('upstream/last-synced');
    expect(stdout).toContain(`(differs from local: ${localSha.slice(0, 8)})`);
    expect(stdout).not.toContain('(matches local)');
  });

  test('prints "no local ref" when remote has a mirror ref local does not', () => {
    // Push an additional cross-direction mirror ref onto upstream that local
    // has never seen. Realistic shape: CI for repo X stores its tracking
    // refs under refs/git-auto-remote/mirror/X-repo/last-synced AND
    // refs/git-auto-remote/mirror/Y-repo/last-synced (one for each side of
    // bidirectional sync). A clone that only pulls from one side will only
    // have one of those refs locally.
    // Use a SHA that exists in upstream's object DB (its own tip).
    const upstreamTip = git(upstream, 'rev-parse', 'main');
    git(upstream, 'update-ref', 'refs/git-auto-remote/mirror/other-side/last-synced', upstreamTip);

    const { code, stdout } = captureLog(() => mirrorStatus('upstream', { showRemotes: true }));
    expect(code).toBe(0);
    expect(stdout).toContain('other-side/last-synced');
    expect(stdout).toContain('(no local ref)');
  });

  test('prints "(no mirror refs on remote)" when remote has none', () => {
    // Delete the remote's mirror ref to simulate a cleanly empty remote-side state.
    git(upstream, 'update-ref', '-d', TRACKING_UPSTREAM);
    const { code, stdout } = captureLog(() => mirrorStatus('upstream', { showRemotes: true }));
    expect(code).toBe(0);
    expect(stdout).toContain('refs on remote (refs/git-auto-remote/mirror/*):');
    expect(stdout).toContain('(no mirror refs on remote)');
  });

  test('inserts an empty line between consecutive mirror config blocks', () => {
    // Add a second mirror remote so the output covers more than one block.
    const upstream2 = join(root, 'upstream2.git');
    git(root, 'init', '--bare', '-q', upstream2);
    git(local, 'remote', 'add', 'upstream2', upstream2);
    git(local, 'config', 'auto-remote.upstream2.syncPaths', 'packages');
    git(local, 'config', 'auto-remote.upstream2.syncTargetBranch', 'private');
    git(local, 'config', 'auto-remote.upstream2.syncBranch', 'main');

    const { code, stdout } = captureLog(() => mirrorStatus(undefined, { showRemotes: true }));
    expect(code).toBe(0);
    expect(stdout).toContain('upstream ');
    expect(stdout).toContain('upstream2 ');

    // The two block headers must be separated by at least one blank line.
    // Detect via a regex spanning the second header's preceding context:
    // exactly the "\n\nupstream2 (" pattern (blank line + header line).
    expect(stdout).toMatch(/\n\nupstream2\s+\(/);
  });

  test('prints "(ls-remote failed: ...)" when remote is unreachable', () => {
    // Point the remote at a nonexistent path. ls-remote will fail.
    git(local, 'remote', 'set-url', 'upstream', join(root, 'nonexistent.git'));
    const { code, stdout } = captureLog(() => mirrorStatus('upstream', { showRemotes: true }));
    // Status still succeeds overall - the network failure is reported inline.
    expect(code).toBe(0);
    expect(stdout).toContain('refs on remote');
    expect(stdout).toContain('ls-remote failed');
  });
});
