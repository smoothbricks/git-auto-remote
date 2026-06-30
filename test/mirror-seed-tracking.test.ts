import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHook } from '../src/lib/hooks.js';
import { mirrorPull } from '../src/commands/mirror-pull.js';
import { readTrackingRef, trackingRefName } from '../src/lib/mirror-state.js';

/**
 * C1-b: self-healing tracking-ref seeding.
 *
 * `mirror pull` reads the LOCAL tracking ref; a fresh CI clone has none, which
 * triggers a full-history replay even when the remote carries an up-to-date
 * tracking ref. Default-on seeding fetches the remote tracking ref into the
 * local namespace before computing the range, so a fresh clone does an
 * incremental pull. `--no-seed-tracking` opts out.
 *
 * Fixture (root commit is out-of-scope so full-replay applies cleanly too):
 *   upstream/main: [root: README] -> [B: packages/cli/b.ts] -> [C: packages/cli/c.ts]
 *   local/private: disjoint private history, syncPaths=packages, no tracking ref.
 */

let root: string;
let upstream: string;
let local: string;
let originalCwd: string;
let shaB: string;

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
  root = mkdtempSync(join(tmpdir(), 'gar-seed-'));
  upstream = join(root, 'upstream.git');
  local = join(root, 'local');

  git(root, 'init', '--bare', '-q', upstream);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', seed);
  commit(seed, 'README.md', 'public\n', 'docs: readme (out of scope)');
  shaB = commit(seed, 'packages/cli/b.ts', 'pkg B v1\n', 'pkg: add B');
  commit(seed, 'packages/cli/c.ts', 'pkg C v1\n', 'pkg: add C');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', upstream);
  git(seed, 'push', '-q', 'origin', 'main');
  shaB = git(seed, 'rev-parse', shaB);

  git(root, 'init', '-q', local);
  commit(local, 'privpkgs/secret.ts', 'secret\n', 'private: secret');
  git(local, 'branch', '-M', 'private');
  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'fetch', '-q', 'upstream');
  git(local, 'config', 'auto-remote.upstream.syncPaths', 'packages');
  git(local, 'config', 'auto-remote.upstream.syncTargetBranch', 'private');
  git(local, 'config', 'auto-remote.upstream.syncBranch', 'main');
  git(local, 'config', 'auto-remote.upstream.pushSyncRef', 'false');

  process.chdir(local);
  installHook('post-applypatch');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('tracking-ref seeding (C1-b)', () => {
  test('seeds from the remote tracking ref and does an incremental pull (no full replay)', async () => {
    // Remote advertises tracking ref at B; local has none (fresh clone).
    git(upstream, 'update-ref', TRACKING, shaB);
    expect(readTrackingRef('upstream')).toBeNull();

    const { code, err } = await captureErr(() => mirrorPull({ remote: 'upstream' }));
    expect(code).toBe(0);
    expect(err).not.toContain('full-history replay');
    // Only C (after B) was applied: c.ts present, b.ts NOT re-applied.
    expect(existsSync(join(local, 'packages/cli/c.ts'))).toBe(true);
    expect(existsSync(join(local, 'packages/cli/b.ts'))).toBe(false);
    // Local tracking ref now seeded + advanced to upstream tip.
    expect(readTrackingRef('upstream')).toBe(git(local, 'rev-parse', 'upstream/main'));
  });

  test('falls back to full-history replay when the remote lacks a tracking ref', async () => {
    // No remote tracking ref anywhere.
    const { code, err } = await captureErr(() => mirrorPull({ remote: 'upstream' }));
    expect(code).toBe(0);
    expect(err).toContain('full-history replay');
    // Full replay applied BOTH B and C.
    expect(existsSync(join(local, 'packages/cli/b.ts'))).toBe(true);
    expect(existsSync(join(local, 'packages/cli/c.ts'))).toBe(true);
  });

  test('--no-seed-tracking ignores the remote tracking ref and full-replays', async () => {
    git(upstream, 'update-ref', TRACKING, shaB);
    const { code, err } = await captureErr(() => mirrorPull({ remote: 'upstream', seedTracking: false }));
    expect(code).toBe(0);
    expect(err).toContain('full-history replay');
    expect(existsSync(join(local, 'packages/cli/b.ts'))).toBe(true);
    expect(existsSync(join(local, 'packages/cli/c.ts'))).toBe(true);
    // Local ref still got set by the pull's own advance, but NOT seeded beforehand.
  });
});
