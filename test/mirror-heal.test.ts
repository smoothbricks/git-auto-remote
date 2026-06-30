import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirrorPull } from '../src/commands/mirror-pull.js';
import { getMirrorInProgress, readTrackingRef, setMirrorInProgress, trackingRefName } from '../src/lib/mirror-state.js';

/**
 * C1-d: self-healing stale state.
 *
 *  - A non-interactive clean-range `git am` conflict must `git am --abort`,
 *    clear the in-progress sentinel, AND rewind the tracking ref if
 *    post-applypatch advanced it past the aborted batch.
 *  - A stale in-progress sentinel with NO `git am` running auto-heals (clears +
 *    continues) under --non-interactive, and refuses with a self-guiding
 *    instruction interactively.
 */

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

let root: string;
let upstream: string;
let local: string;
let originalCwd: string;

const TRACKING = trackingRefName('upstream');
const ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t' };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: { ...process.env, ...ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed:\n${r.stdout}\n${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function commit(cwd: string, path: string, content: string, message: string): string {
  const full = join(cwd, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** Install a post-applypatch hook that runs the LOCAL gar source (not bunx). */
function installLocalHook(): void {
  const hookPath = join(local, '.git', 'hooks', 'post-applypatch');
  writeFileSync(hookPath, `#!/usr/bin/env bash\nexec bun "${CLI}" post-applypatch "$@" || true\n`);
  chmodSync(hookPath, 0o755);
}

function captureErr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const orig = console.error;
  let err = '';
  console.error = (...a: unknown[]) => {
    err += a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ') + '\n';
  };
  return fn()
    .then((code) => ({ code, err }))
    .finally(() => {
      console.error = orig;
    });
}

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'gar-heal-'));
  upstream = join(root, 'upstream.git');
  local = join(root, 'local');
  git(root, 'init', '--bare', '-q', upstream);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('clean-range conflict self-healing (C1-d)', () => {
  test('non-interactive abort clears the sentinel AND rewinds the tracking ref', async () => {
    const seed = join(root, 'seed');
    git(root, 'init', '-q', seed);
    const shaA = commit(seed, 'packages/cli/a.ts', 'v1\n', 'pkg: add A');
    commit(seed, 'packages/cli/b.ts', 'B1\n', 'pkg: add B');
    commit(seed, 'packages/cli/a.ts', 'v2\n', 'pkg: bump A'); // C: conflicts with local
    git(seed, 'branch', '-M', 'main');
    git(seed, 'remote', 'add', 'origin', upstream);
    git(seed, 'push', '-q', 'origin', 'main');
    const shaAfull = git(seed, 'rev-parse', shaA);

    git(root, 'init', '-q', local);
    commit(local, 'packages/cli/a.ts', 'local-modified\n', 'private: a');
    git(local, 'branch', '-M', 'private');
    git(local, 'remote', 'add', 'upstream', upstream);
    git(local, 'fetch', '-q', 'upstream');
    git(local, 'config', 'auto-remote.upstream.syncPaths', 'packages');
    git(local, 'config', 'auto-remote.upstream.syncTargetBranch', 'private');
    git(local, 'config', 'auto-remote.upstream.syncBranch', 'main');
    git(local, 'config', 'auto-remote.upstream.pushSyncRef', 'false');
    git(local, 'update-ref', TRACKING, shaAfull); // base = A; range A..C = [B, C]

    process.chdir(local);
    installLocalHook();
    const headBefore = git(local, 'rev-parse', 'HEAD');

    const { code } = await captureErr(() => mirrorPull({ remote: 'upstream', nonInteractive: true, seedTracking: false }));
    expect(code).toBe(2);
    // post-applypatch advanced tracking to B during the batch; the abort path
    // must rewind it back to A so the next run re-attempts the whole range.
    expect(readTrackingRef('upstream')).toBe(shaAfull);
    // Sentinel cleared - not left stale.
    expect(getMirrorInProgress()).toBeNull();
    // HEAD rewound by `git am --abort`; b.ts not present.
    expect(git(local, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(existsSync(join(local, 'packages/cli/b.ts'))).toBe(false);
    expect(readFileSync(join(local, 'packages/cli/a.ts'), 'utf8')).toBe('local-modified\n');
  });
});

describe('stale-sentinel self-healing (C1-d)', () => {
  function setupCleanMirror(): void {
    const seed = join(root, 'seed');
    git(root, 'init', '-q', seed);
    const shaA = commit(seed, 'packages/cli/a.ts', 'v1\n', 'pkg: add A');
    commit(seed, 'packages/cli/b.ts', 'B1\n', 'pkg: add B');
    git(seed, 'branch', '-M', 'main');
    git(seed, 'remote', 'add', 'origin', upstream);
    git(seed, 'push', '-q', 'origin', 'main');
    const shaAfull = git(seed, 'rev-parse', shaA);

    git(root, 'init', '-q', local);
    commit(local, 'packages/cli/a.ts', 'v1\n', 'private: a');
    git(local, 'branch', '-M', 'private');
    git(local, 'remote', 'add', 'upstream', upstream);
    git(local, 'fetch', '-q', 'upstream');
    git(local, 'config', 'auto-remote.upstream.syncPaths', 'packages');
    git(local, 'config', 'auto-remote.upstream.syncTargetBranch', 'private');
    git(local, 'config', 'auto-remote.upstream.syncBranch', 'main');
    git(local, 'config', 'auto-remote.upstream.pushSyncRef', 'false');
    git(local, 'update-ref', TRACKING, shaAfull);
    process.chdir(local);
  }

  test('--non-interactive auto-heals a stale sentinel and proceeds with the sync', async () => {
    setupCleanMirror();
    setMirrorInProgress('upstream'); // simulate a crashed prior run

    const { code, err } = await captureErr(() => mirrorPull({ remote: 'upstream', nonInteractive: true, seedTracking: false }));
    expect(code).toBe(0);
    expect(err).toMatch(/heal|stale/i);
    expect(getMirrorInProgress()).toBeNull();
    // Sync actually proceeded: B landed.
    expect(existsSync(join(local, 'packages/cli/b.ts'))).toBe(true);
  });

  test('interactive refuses a stale sentinel with a self-guiding instruction', async () => {
    setupCleanMirror();
    setMirrorInProgress('upstream');

    const { code, err } = await captureErr(() => mirrorPull({ remote: 'upstream', seedTracking: false }));
    expect(code).toBe(1);
    expect(err).toContain('stale mirror-in-progress');
    expect(err).toContain('mirror skip upstream');
    // Refused: sentinel untouched, sync did not proceed.
    expect(getMirrorInProgress()).toBe('upstream');
    expect(existsSync(join(local, 'packages/cli/b.ts'))).toBe(false);
  });
});
