import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHook } from '../src/lib/hooks.js';
import { mirrorPull } from '../src/commands/mirror-pull.js';
import { readTrackingRef, trackingRefName } from '../src/lib/mirror-state.js';

/**
 * C1-c: robust tracking-ref push via --force-with-lease.
 *
 * The tracking ref is monotonic/authoritative. The final push must use
 * --force-with-lease keyed on the value observed at the START of the run, so:
 *   - a normal advance (remote still at our base) succeeds;
 *   - a concurrent CI that already moved the remote ref is NOT clobbered - the
 *     push declines with a warning and local state is not corrupted.
 *
 * Fixture: upstream/main = [R: README (oos)] -> [B: b.ts] -> [C: c.ts].
 */

let root: string;
let upstream: string;
let local: string;
let originalCwd: string;
let shaR: string;
let shaB: string;
let shaC: string;

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
  root = mkdtempSync(join(tmpdir(), 'gar-push-'));
  upstream = join(root, 'upstream.git');
  local = join(root, 'local');

  git(root, 'init', '--bare', '-q', upstream);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', seed);
  shaR = commit(seed, 'README.md', 'public\n', 'docs: readme (oos)');
  shaB = commit(seed, 'packages/cli/b.ts', 'pkg B v1\n', 'pkg: add B');
  shaC = commit(seed, 'packages/cli/c.ts', 'pkg C v1\n', 'pkg: add C');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', upstream);
  git(seed, 'push', '-q', 'origin', 'main');
  shaR = git(seed, 'rev-parse', shaR);
  shaB = git(seed, 'rev-parse', shaB);
  shaC = git(seed, 'rev-parse', shaC);

  git(root, 'init', '-q', local);
  commit(local, 'privpkgs/secret.ts', 'secret\n', 'private: secret');
  git(local, 'branch', '-M', 'private');
  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'fetch', '-q', 'upstream');
  git(local, 'config', 'auto-remote.upstream.syncPaths', 'packages');
  git(local, 'config', 'auto-remote.upstream.syncTargetBranch', 'private');
  git(local, 'config', 'auto-remote.upstream.syncBranch', 'main');
  git(local, 'config', 'auto-remote.upstream.pushSyncRef', 'true');
  // Local base = R (root); we exclude seeding by leaving the local ref present.
  git(local, 'update-ref', TRACKING, shaR);

  process.chdir(local);
  installHook('post-applypatch');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('robust tracking-ref push (C1-c)', () => {
  test('normal advance: lease passes, remote ref advances', async () => {
    // Remote ref equals our base (R) -> lease holds.
    git(upstream, 'update-ref', TRACKING, shaR);

    const { code, err } = await captureErr(() => mirrorPull({ remote: 'upstream', seedTracking: false }));
    expect(code).toBe(0);
    expect(err).not.toContain('failed to push tracking ref');
    expect(readTrackingRef('upstream')).toBe(shaC); // local advanced to tip
    expect(git(upstream, 'rev-parse', TRACKING)).toBe(shaC); // remote advanced too
  });

  test('stale base vs newer remote: lease declines, remote ref NOT clobbered', async () => {
    // A concurrent CI already advanced the remote ref past our base (R) to B.
    git(upstream, 'update-ref', TRACKING, shaB);

    const { code, err } = await captureErr(() => mirrorPull({ remote: 'upstream', seedTracking: false }));
    // Push failure is a warning, not fatal.
    expect(code).toBe(0);
    expect(err).toContain('failed to push tracking ref');
    // Local advanced fine; state not corrupted.
    expect(readTrackingRef('upstream')).toBe(shaC);
    // Remote ref left at B (lease refused to force it to C).
    expect(git(upstream, 'rev-parse', TRACKING)).toBe(shaB);
  });
});
