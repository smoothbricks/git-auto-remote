import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirrorBootstrap } from '../src/commands/mirror-bootstrap.js';
import { trackingRefName, readTrackingRef } from '../src/lib/mirror-state.js';

const TRACKING_UPSTREAM = trackingRefName('upstream');

/**
 * Integration tests for mirror bootstrap command.
 *
 * Bootstrap initializes the tracking ref for a mirror at a specific SHA,
 * allowing subsequent mirror pulls to skip past that portion of history.
 */

let root: string;
let upstream: string; // bare repo path
let local: string; // working clone path
let originalCwd: string;

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`);
  }
  return (result.stdout ?? '').trim();
}

function commit(cwd: string, path: string, content: string, message: string): string {
  const full = join(cwd, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** Run a function while capturing console.error calls. */
function captureStderr<T>(fn: () => T | Promise<T>): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  const restore = () => {
    console.error = original;
  };
  return Promise.resolve()
    .then(() => fn())
    .then((result) => {
      restore();
      return { result, output: lines.join('\n') };
    })
    .catch((err) => {
      restore();
      throw err;
    });
}

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'gar-bootstrap-int-'));
  upstream = join(root, 'upstream.git');
  local = join(root, 'local');

  // 1) Set up a bare upstream repo and seed it via a scratch clone.
  git(root, 'init', '--bare', '-q', upstream);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', seed);
  commit(seed, 'packages/cli/a.ts', 'pkg A v1\n', 'pkg: add A');
  commit(seed, 'packages/cli/b.ts', 'pkg B v1\n', 'pkg: add B');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', upstream);
  git(seed, 'push', '-q', 'origin', 'main');

  // 2) Create our local work repo with a disjoint private history.
  git(root, 'init', '-q', local);
  commit(local, 'packages/cli/a.ts', 'pkg A v1\n', 'private: import A');
  commit(local, 'packages/cli/b.ts', 'pkg B v1\n', 'private: import B');
  commit(local, 'privpkgs/secret.ts', 'secret v1\n', 'private: add secret');
  git(local, 'branch', '-M', 'private');

  // 3) Add upstream as a mirror remote in local.
  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'fetch', '-q', 'upstream');

  // 4) Configure mirror settings: syncPaths=packages, target branch=private.
  git(local, 'config', 'auto-remote.upstream.syncPaths', 'packages');
  git(local, 'config', 'auto-remote.upstream.syncTargetBranch', 'private');
  git(local, 'config', 'auto-remote.upstream.syncBranch', 'main');
  git(local, 'config', 'auto-remote.upstream.pushSyncRef', 'false');

  // 5) Change to local directory for bootstrap commands
  process.chdir(local);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('mirror bootstrap', () => {
  describe('T1-NB-02: bootstrap refuses when tracking ref already exists', () => {
    test('returns 1 and keeps existing tracking ref when not forced', async () => {
      // Pre-state: set up existing tracking ref
      const upstreamTip = git(local, 'rev-parse', 'upstream/main');
      const firstCommit = git(local, 'rev-list', '--max-parents=0', 'upstream/main');
      git(local, 'update-ref', TRACKING_UPSTREAM, firstCommit);

      const existingTracking = readTrackingRef('upstream');
      expect(existingTracking).toBe(firstCommit);

      // Attempt to bootstrap at a different SHA without --force
      const { result: code, output } = await captureStderr(() => mirrorBootstrap('upstream', upstreamTip, false));

      // Post-state: tracking ref unchanged, exit code 1, error message
      expect(code).toBe(1);
      expect(readTrackingRef('upstream')).toBe(firstCommit);
      expect(output).toContain('already bootstrapped');
      expect(output).toContain('--force');
    });
  });

  describe('T1-NB-03: bootstrap --force overwrites existing tracking ref', () => {
    test('returns 0 and updates tracking ref when forced', async () => {
      // Pre-state: set up existing tracking ref
      const firstCommit = git(local, 'rev-list', '--max-parents=0', 'upstream/main');
      git(local, 'update-ref', TRACKING_UPSTREAM, firstCommit);
      expect(readTrackingRef('upstream')).toBe(firstCommit);

      // Get a different SHA to bootstrap to
      const upstreamTip = git(local, 'rev-parse', 'upstream/main');
      expect(upstreamTip).not.toBe(firstCommit);

      // Bootstrap with --force
      const { result: code, output } = await captureStderr(() => mirrorBootstrap('upstream', upstreamTip, true));

      // Post-state: tracking ref updated, exit code 0, success message
      expect(code).toBe(0);
      expect(readTrackingRef('upstream')).toBe(upstreamTip);
      expect(output).toContain('bootstrapped');
      expect(output).toContain(upstreamTip.slice(0, 8));
    });
  });

  describe('T1-NB-04: bootstrap at root commit refuses without --force', () => {
    test('returns 1 with warning about root commit semantics', async () => {
      // Pre-state: no tracking ref exists
      const firstCommit = git(local, 'rev-list', '--max-parents=0', 'upstream/main');
      expect(readTrackingRef('upstream')).toBeNull();

      // Attempt to bootstrap at root commit without --force
      const { result: code, output } = await captureStderr(() => mirrorBootstrap('upstream', firstCommit, false));

      // Post-state: tracking ref not created, exit code 1, warning message
      expect(code).toBe(1);
      expect(readTrackingRef('upstream')).toBeNull();
      expect(output).toContain('ROOT commit');
      expect(output).toContain('SKIPPED');
      expect(output).toContain('--force');
    });
  });

  describe('T1-NB-05: bootstrap at root commit succeeds with --force; warning emitted', () => {
    test('returns 0 and creates tracking ref at root when forced', async () => {
      // Pre-state: no tracking ref exists
      const firstCommit = git(local, 'rev-list', '--max-parents=0', 'upstream/main');
      expect(readTrackingRef('upstream')).toBeNull();

      // Bootstrap at root commit with --force
      const { result: code, output } = await captureStderr(() => mirrorBootstrap('upstream', firstCommit, true));

      // Post-state: tracking ref created at root, exit code 0, warning emitted
      expect(code).toBe(0);
      expect(readTrackingRef('upstream')).toBe(firstCommit);
      expect(output).toContain('Warning');
      expect(output).toContain('ROOT commit');
      expect(output).toContain('bootstrapped');
    });
  });

  describe('T1-NB-06: bootstrap with unknown remote fails cleanly with explanatory error', () => {
    test('returns 1 with clear error when remote is not configured', async () => {
      // Pre-state: no mirror config for 'unknown-remote'
      const upstreamTip = git(local, 'rev-parse', 'upstream/main');

      // Attempt to bootstrap with unconfigured remote
      const { result: code, output } = await captureStderr(() => mirrorBootstrap('unknown-remote', upstreamTip, false));

      // Post-state: no tracking ref created, exit code 1, explanatory error
      expect(code).toBe(1);
      expect(readTrackingRef('unknown-remote')).toBeNull();
      expect(output).toContain("No mirror configured for 'unknown-remote'");
      expect(output).toContain('Configure first');
      expect(output).toContain('auto-remote.unknown-remote.syncPaths');
    });
  });

  describe('T1-NB-07: bootstrap with unresolvable ref (bad SHA) fails cleanly', () => {
    test('returns 1 with clear error when SHA cannot be resolved', async () => {
      // Pre-state: valid mirror config exists, but bad SHA
      const badSha = 'deadbeef1234567890deadbeef1234567890dead';

      // Attempt to bootstrap with unresolvable SHA
      const { result: code, output } = await captureStderr(() => mirrorBootstrap('upstream', badSha, false));

      // Post-state: no tracking ref created, exit code 1, explanatory error
      expect(code).toBe(1);
      expect(readTrackingRef('upstream')).toBeNull();
      expect(output).toContain('Cannot resolve');
      expect(output).toContain(badSha.slice(0, 8));
    });
  });

  describe('T1-NB-01: scaffold file with beforeEach/afterEach', () => {
    test('setup and teardown work correctly', () => {
      // Verify that beforeEach set up the environment correctly
      expect(existsSync(local)).toBe(true);
      expect(existsSync(join(local, '.git'))).toBe(true);

      // Verify mirror config was set up
      const syncPaths = git(local, 'config', '--get', 'auto-remote.upstream.syncPaths');
      expect(syncPaths).toBe('packages');

      // Verify remote exists
      const remotes = git(local, 'remote');
      expect(remotes).toContain('upstream');

      // Verify we're in the local directory (normalize paths for macOS /private/tmp)
      const cwd = process.cwd();
      const normalizedCwd = cwd.replace(/^\/private/, '');
      const normalizedLocal = local.replace(/^\/private/, '');
      expect(normalizedCwd).toBe(normalizedLocal);
    });
  });
});
