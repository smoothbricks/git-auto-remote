import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHook } from '../src/lib/hooks.js';
import { mirrorPull } from '../src/commands/mirror-pull.js';
import { readTrackingRef, trackingRefName } from '../src/lib/mirror-state.js';

/**
 * C1-f: `mirror pull --review-ref <ref>`. On a non-interactive partial/conflict,
 * assemble the reviewable commit (included + review overlay + any conflict
 * markers) into <ref>, leave the tracking ref + target branch unchanged, exit 2.
 * A fully clean run never creates <ref> and advances normally.
 */

const REVIEW_REF = 'refs/heads/gar-sync/x';
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

function gitTry(cwd: string, ...args: string[]): string | null {
  const r = spawnSync('git', args, { cwd, env: { ...process.env, ...ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
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
  root = mkdtempSync(join(tmpdir(), 'gar-revref-'));
  upstream = join(root, 'upstream.git');
  local = join(root, 'local');
  git(root, 'init', '--bare', '-q', upstream);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', seed);
  commit(seed, 'packages/cli/a.ts', 'v1\n', 'pkg: add A');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', upstream);
  git(seed, 'push', '-q', 'origin', 'main');

  git(root, 'init', '-q', local);
  commit(local, 'packages/cli/a.ts', 'v1\n', 'private: a');
  git(local, 'branch', '-M', 'private');
  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'fetch', '-q', 'upstream');
  git(local, 'config', 'auto-remote.upstream.syncPaths', 'packages');
  git(local, 'config', 'auto-remote.upstream.reviewPaths', 'tooling/review.conf');
  git(local, 'config', 'auto-remote.upstream.syncTargetBranch', 'private');
  git(local, 'config', 'auto-remote.upstream.syncBranch', 'main');
  git(local, 'config', 'auto-remote.upstream.pushSyncRef', 'false');
  git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));
  process.chdir(local);
  installHook('post-applypatch');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('mirror pull --review-ref (C1-f)', () => {
  test('clean run: <ref> NOT created, normal advance', async () => {
    const seed = join(root, 'seed');
    commit(seed, 'packages/cli/b.ts', 'B1\n', 'pkg: add B');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    const newTip = git(local, 'rev-parse', 'upstream/main');

    const { code } = await captureErr(() => mirrorPull({ remote: 'upstream', nonInteractive: true, reviewRef: REVIEW_REF, seedTracking: false }));
    expect(code).toBe(0);
    expect(gitTry(local, 'rev-parse', '--verify', REVIEW_REF)).toBeNull(); // not created
    expect(readTrackingRef('upstream')).toBe(newTip); // advanced
    expect(git(local, 'rev-parse', 'private')).not.toBe(''); // applied to target
  });

  test('partial with review: <ref> holds included + review; tracking + HEAD unchanged; exit 2', async () => {
    const seed = join(root, 'seed');
    const full = join(seed, 'packages/cli/d.ts');
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, 'D1\n');
    const rev = join(seed, 'tooling/review.conf');
    mkdirSync(join(rev, '..'), { recursive: true });
    writeFileSync(rev, 'reviewed\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'feat: code + review');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    const headBefore = git(local, 'rev-parse', 'HEAD');
    const trackBefore = readTrackingRef('upstream');

    const { code } = await captureErr(() => mirrorPull({ remote: 'upstream', nonInteractive: true, reviewRef: REVIEW_REF, seedTracking: false }));
    expect(code).toBe(2);
    // <ref> created with BOTH included (d.ts) and review (review.conf) content.
    expect(gitTry(local, 'rev-parse', '--verify', REVIEW_REF)).not.toBeNull();
    expect(git(local, 'show', `${REVIEW_REF}:packages/cli/d.ts`)).toBe('D1');
    expect(git(local, 'show', `${REVIEW_REF}:tooling/review.conf`)).toBe('reviewed');
    // Target branch + tracking ref untouched.
    expect(git(local, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(readTrackingRef('upstream')).toBe(trackBefore);
  });

  test('conflict: <ref> carries git am --3way markers; tracking + HEAD unchanged; exit 2', async () => {
    // Local diverged on a syncPath -> the upstream change will conflict.
    commit(local, 'packages/cli/a.ts', 'local-divergent\n', 'private: diverge a');
    git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));
    const seed = join(root, 'seed');
    commit(seed, 'packages/cli/a.ts', 'v2-upstream\n', 'pkg: bump A');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    const headBefore = git(local, 'rev-parse', 'HEAD');
    const trackBefore = readTrackingRef('upstream');

    const { code } = await captureErr(() => mirrorPull({ remote: 'upstream', nonInteractive: true, reviewRef: REVIEW_REF, seedTracking: false }));
    expect(code).toBe(2);
    expect(gitTry(local, 'rev-parse', '--verify', REVIEW_REF)).not.toBeNull();
    const conflicted = git(local, 'show', `${REVIEW_REF}:packages/cli/a.ts`);
    expect(conflicted).toContain('<<<<<<<');
    expect(conflicted).toContain('>>>>>>>');
    expect(git(local, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(readTrackingRef('upstream')).toBe(trackBefore);
  });
});
