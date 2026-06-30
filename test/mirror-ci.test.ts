import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirrorCi } from '../src/commands/mirror-ci.js';
import { readTrackingRef, trackingRefName } from '../src/lib/mirror-state.js';

/**
 * C1-g: `mirror ci` - idiot-proof one-shot CI sync for a direction.
 *
 * It ensures config is loaded, installs hooks (setup), checks out the target
 * branch, then runs a self-healing non-interactive `mirror pull --review-ref`.
 * On a clean sync it returns 0 (mirror pull already pushed the tracking ref to
 * its OWN remote, force-with-lease, bypassing the pre-push guard via --no-verify
 * since the ref carries source-side history). On a partial/conflict it leaves the
 * review ref locally, pushes nothing, and prints the exact next command (exit 2).
 *
 * Fixture: upstream/main = [README (oos)] -> [packages/cli/a.ts]; local/private
 * is disjoint private history, syncPaths=packages.
 */

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
  root = mkdtempSync(join(tmpdir(), 'gar-ci-'));
  upstream = join(root, 'upstream.git');
  local = join(root, 'local');

  git(root, 'init', '--bare', '-q', upstream);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', seed);
  commit(seed, 'README.md', 'public\n', 'docs: readme (oos)');
  commit(seed, 'packages/cli/a.ts', 'v1\n', 'pkg: add A');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', upstream);
  git(seed, 'push', '-q', 'origin', 'main');

  git(root, 'init', '-q', local);
  commit(local, 'privpkgs/secret.ts', 'secret\n', 'private: secret');
  git(local, 'branch', '-M', 'private');
  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'fetch', '-q', 'upstream');
  git(local, 'config', 'auto-remote.upstream.syncPaths', 'packages');
  git(local, 'config', 'auto-remote.upstream.reviewPaths', 'tooling/review.conf');
  git(local, 'config', 'auto-remote.upstream.syncTargetBranch', 'private');
  git(local, 'config', 'auto-remote.upstream.syncBranch', 'main');
  git(local, 'config', 'auto-remote.upstream.pushSyncRef', 'true');

  process.chdir(local);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('mirror ci (C1-g)', () => {
  test('clean sync: exit 0, tracking ref advanced + created on the source remote, no review ref', async () => {
    // No tracking ref anywhere -> full replay, clean (a.ts is a new file on private).
    const { code, err } = await captureErr(() => mirrorCi('upstream'));
    expect(code).toBe(0);

    // No review ref left behind on a clean run.
    expect(gitTry(local, 'rev-parse', '--verify', 'refs/heads/gar-sync/upstream')).toBeNull();

    // Local tracking ref advanced to the upstream tip ...
    const tip = git(local, 'rev-parse', 'upstream/main');
    expect(readTrackingRef('upstream')).toBe(tip);
    // ... and pushed to its OWN remote (created directly, --no-verify bypasses the
    // pre-push guard that setup() just installed - the ref carries source history).
    expect(git(upstream, 'rev-parse', TRACKING)).toBe(tip);

    // Synced content landed on the target branch.
    expect(existsSync(join(local, 'packages/cli/a.ts'))).toBe(true);
    expect(err).toContain('synced clean');
  });

  test('conflict: exit 2, default review ref written with markers, tracking ref unchanged, prints exact Next', async () => {
    // Local diverges on a syncPath; base the tracking ref at the current upstream
    // tip so the NEXT upstream change is the one that conflicts.
    commit(local, 'packages/cli/a.ts', 'local-divergent\n', 'private: diverge a');
    git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));
    const seed = join(root, 'seed');
    commit(seed, 'packages/cli/a.ts', 'v2-upstream\n', 'pkg: bump A');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    const trackBefore = readTrackingRef('upstream');
    const { code, err } = await captureErr(() => mirrorCi('upstream', { seedTracking: false }));
    expect(code).toBe(2);

    // Default review ref name is refs/heads/gar-sync/<remote>; it carries markers.
    const ref = 'refs/heads/gar-sync/upstream';
    expect(gitTry(local, 'rev-parse', '--verify', ref)).not.toBeNull();
    const conflicted = git(local, 'show', `${ref}:packages/cli/a.ts`);
    expect(conflicted).toContain('<<<<<<<');
    expect(conflicted).toContain('>>>>>>>');

    // Nothing advanced or pushed.
    expect(readTrackingRef('upstream')).toBe(trackBefore);
    expect(gitTry(upstream, 'rev-parse', TRACKING)).toBeNull();

    // Self-guiding: a Next: line with the exact push + open-PR command.
    expect(err).toContain('review needed');
    expect(err).toMatch(/Next:/);
    expect(err).toContain('gh pr create');
  });

  test('explicit --review-ref overrides the default name', async () => {
    commit(local, 'packages/cli/a.ts', 'local-divergent\n', 'private: diverge a');
    git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));
    const seed = join(root, 'seed');
    commit(seed, 'packages/cli/a.ts', 'v2-upstream\n', 'pkg: bump A');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    const { code } = await captureErr(() =>
      mirrorCi('upstream', { reviewRef: 'refs/heads/gar-sync/public-to-private', seedTracking: false }),
    );
    expect(code).toBe(2);
    expect(gitTry(local, 'rev-parse', '--verify', 'refs/heads/gar-sync/public-to-private')).not.toBeNull();
    expect(gitTry(local, 'rev-parse', '--verify', 'refs/heads/gar-sync/upstream')).toBeNull();
  });

  test('unconfigured remote: exit 1 with a named diagnostic + Next', async () => {
    const { code, err } = await captureErr(() => mirrorCi('not-a-mirror'));
    expect(code).toBe(1);
    expect(err).toContain("No mirror configured for remote 'not-a-mirror'");
    expect(err).toContain('Next:');
  });

  test('off the target branch: checks out the target, then syncs clean', async () => {
    // Start on a different branch; mirror ci must switch to the target (private).
    git(local, 'checkout', '-q', '-b', 'feature');
    expect(git(local, 'symbolic-ref', '--short', 'HEAD')).toBe('feature');

    const { code } = await captureErr(() => mirrorCi('upstream', { seedTracking: false }));
    expect(code).toBe(0);
    expect(git(local, 'symbolic-ref', '--short', 'HEAD')).toBe('private');
    expect(existsSync(join(local, 'packages/cli/a.ts'))).toBe(true);
  });
});
