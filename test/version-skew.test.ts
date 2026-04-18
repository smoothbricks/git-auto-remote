import { beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHook } from '../src/lib/hooks.js';
import { trackingRefName } from '../src/lib/mirror-state.js';
import { mirrorPull } from '../src/commands/mirror-pull.js';
import { VERSION } from '../src/lib/version.js';

const TRACKING_UPSTREAM = trackingRefName('upstream');

/**
 * Version skew detection tests for HIGH-4.
 * When the installed hook pins a different version of git-auto-remote
 * than the currently running CLI, we warn the user.
 */

let root: string;
let upstream: string;
let local: string;
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

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'gar-version-skew-'));
  upstream = join(root, 'upstream.git');
  local = join(root, 'local');

  // Set up a bare upstream repo
  git(root, 'init', '--bare', '-q', upstream);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', seed);
  commit(seed, 'packages/cli/a.ts', 'pkg A v1\n', 'pkg: add A');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', upstream);
  git(seed, 'push', '-q', 'origin', 'main');

  // Create local work repo
  git(root, 'init', '-q', local);
  commit(local, 'packages/cli/a.ts', 'pkg A v1\n', 'private: import A');
  git(local, 'branch', '-M', 'private');
  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'fetch', '-q', 'upstream');
  git(local, 'config', 'auto-remote.upstream.syncPaths', 'packages');
  git(local, 'config', 'auto-remote.upstream.syncTargetBranch', 'private');
  git(local, 'config', 'auto-remote.upstream.syncBranch', 'main');
  git(local, 'config', 'auto-remote.upstream.pushSyncRef', 'false');
  const upstreamTip = git(local, 'rev-parse', 'upstream/main');
  git(local, 'update-ref', TRACKING_UPSTREAM, upstreamTip);

  process.chdir(local);
});

// Clean up handled by afterEach in the test runner

describe('version skew detection', () => {
  test('emits warning when hook version differs from CLI version (T2-MPULL-09)', async () => {
    // Install the hook normally first
    installHook('post-applypatch');

    // Now manually edit the hook to simulate an older version
    const hookPath = join(local, '.git', 'hooks', 'post-applypatch');
    let hookContent = readFileSync(hookPath, 'utf8');
    // Replace the version with a fake old version
    const oldVersion = '0.5.0';
    hookContent = hookContent.replace(
      new RegExp(`git-auto-remote@${VERSION}`, 'g'),
      `git-auto-remote@${oldVersion}`
    );
    writeFileSync(hookPath, hookContent);

    // Add a new upstream commit
    const seed = join(root, 'seed');
    commit(seed, 'packages/cli/b.ts', 'pkg B v1\n', 'pkg: add B');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    // Capture stderr
    const originalError = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => {
      captured.push(args.join(' '));
    };

    let code: number;
    try {
      code = await mirrorPull({ remote: 'upstream' });
    } finally {
      console.error = originalError;
    }

    // Should succeed (warning, not refusal)
    expect(code).toBe(0);

    // Should emit version-skew warning
    const warningPattern = /WARNING.*installed hook pins git-auto-remote@[\d.]+ but you are running @[\d.]+/;
    expect(captured.some((line) => warningPattern.test(line))).toBe(true);
    expect(captured.some((line) => line.includes('State file format may differ'))).toBe(true);
    expect(captured.some((line) => line.includes('git-auto-remote setup'))).toBe(true);
  });

  test('no warning when hook version matches CLI version', async () => {
    // Install the hook at current version
    installHook('post-applypatch');

    // Add a new upstream commit
    const seed = join(root, 'seed');
    commit(seed, 'packages/cli/b.ts', 'pkg B v1\n', 'pkg: add B');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    // Capture stderr
    const originalError = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => {
      captured.push(args.join(' '));
    };

    let code: number;
    try {
      code = await mirrorPull({ remote: 'upstream' });
    } finally {
      console.error = originalError;
    }

    expect(code).toBe(0);

    // Should NOT emit version-skew warning
    const warningPattern = /WARNING.*installed hook pins git-auto-remote@[\d.]+ but you are running @[\d.]+/;
    expect(captured.some((line) => warningPattern.test(line))).toBe(false);
  });

  test('no warning when hook is not installed', async () => {
    // Don't install any hook

    // Add a new upstream commit
    const seed = join(root, 'seed');
    commit(seed, 'packages/cli/b.ts', 'pkg B v1\n', 'pkg: add B');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    // Capture stderr
    const originalError = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => {
      captured.push(args.join(' '));
    };

    let code: number;
    try {
      code = await mirrorPull({ remote: 'upstream' });
    } finally {
      console.error = originalError;
    }

    expect(code).toBe(0);

    // Should NOT emit version-skew warning
    const warningPattern = /WARNING.*installed hook pins git-auto-remote@[\d.]+ but you are running @[\d.]+/;
    expect(captured.some((line) => warningPattern.test(line))).toBe(false);
  });
});
