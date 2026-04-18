import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHook } from '../src/lib/hooks.js';
import { VERSION } from '../src/lib/version.js';
import { mirrorPull } from '../src/commands/mirror-pull.js';
import { trackingRefName } from '../src/lib/mirror-state.js';

const TRACKING_UPSTREAM = trackingRefName('upstream');

/**
 * T1-SKEW-01: Version-skew detection test (HIGH-4)
 *
 * Synthesize the scenario: install hook (which embeds `bunx git-auto-remote@<VERSION>`),
 * then EDIT the hook to pin a different version. Call `mirrorPull`. Assert: warning emitted.
 *
 * This test will initially FAIL on baseline because no warning currently exists.
 * The B-HOOKS batch in Phase 2 will implement the warning.
 *
 * Context from AUDIT-v0.6.3.md HIGH-4:
 * - Code path: src/lib/hooks.ts:37-44
 * - Hooks call `bunx --bun git-auto-remote@${VERSION}`
 * - Failure mode: User upgrades git-auto-remote but never re-runs setup; hooks invoke
 *   an older version via bunx. Tracking ref semantics, sentinel filenames, and marker
 *   format differ across versions. Mismatched hook↔CLI pairs can leave state in a
 *   shape neither side understands.
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
  const parentDir = join(full, '..');
  if (!existsSync(parentDir)) {
    // Use sync version with recursive option
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').mkdirSync(parentDir, { recursive: true });
  }
  writeFileSync(full, content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'gar-skew-test-'));
  upstream = join(root, 'upstream.git');
  local = join(root, 'local');

  // 1) Set up a bare upstream repo and seed it via a scratch clone.
  git(root, 'init', '--bare', '-q', upstream);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', seed);
  commit(seed, 'packages/cli/a.ts', 'pkg A v1\n', 'pkg: add A');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', upstream);
  git(seed, 'push', '-q', 'origin', 'main');

  // 2) Create our local work repo with a disjoint private history.
  git(root, 'init', '-q', local);
  commit(local, 'packages/cli/a.ts', 'pkg A v1\n', 'private: import A');
  git(local, 'branch', '-M', 'private');

  // 3) Add upstream as a mirror remote in local.
  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'fetch', '-q', 'upstream');

  // 4) Configure mirror settings: syncPaths=packages, target branch=private.
  git(local, 'config', 'auto-remote.upstream.syncPaths', 'packages');
  git(local, 'config', 'auto-remote.upstream.syncTargetBranch', 'private');
  git(local, 'config', 'auto-remote.upstream.syncBranch', 'main');
  git(local, 'config', 'auto-remote.upstream.pushSyncRef', 'false');

  // 5) Bootstrap the tracking ref to upstream's current tip.
  const upstreamTip = git(local, 'rev-parse', 'upstream/main');
  git(local, 'update-ref', TRACKING_UPSTREAM, upstreamTip);

  // 6) Change to local repo for hook installation.
  process.chdir(local);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('version skew detection (HIGH-4)', () => {
  test('warns when hook version differs from CLI version', async () => {
    // Install the hook (normally this embeds the current VERSION)
    installHook('post-checkout');

    // Verify hook was installed with current version
    const hookPath = join(local, '.git/hooks/post-checkout');
    const originalContent = readFileSync(hookPath, 'utf8');
    expect(originalContent).toContain(`git-auto-remote@${VERSION}`);

    // EDIT the hook to pin a DIFFERENT version (simulate version skew)
    // This simulates the scenario where the user upgraded git-auto-remote
    // but never re-ran setup, so the hook still calls an older version.
    const differentVersion = '0.5.0'; // An older version
    const skewedContent = originalContent.replace(
      /bunx --bun git-auto-remote@[\d.]+/,
      `bunx --bun git-auto-remote@${differentVersion}`
    );

    // Verify replacement happened
    expect(skewedContent).not.toBe(originalContent);
    expect(skewedContent).toContain(`git-auto-remote@${differentVersion}`);
    expect(skewedContent).not.toContain(`git-auto-remote@${VERSION}`);

    // Write the skewed hook back
    writeFileSync(hookPath, skewedContent);

    // Add a new commit to upstream so mirrorPull has work to do
    const seed = join(root, 'seed');
    commit(seed, 'packages/cli/b.ts', 'pkg B v1\n', 'pkg: add B');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    // Capture console.error to check for warning
    const originalError = console.error;
    let captured = '';
    console.error = (...args: unknown[]): void => {
      captured += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
    };

    try {
      // Run mirrorPull - this should detect version skew and emit a warning
      await mirrorPull({ remote: 'upstream' });
    } finally {
      console.error = originalError;
    }

    // ASSERT: A warning about version skew should be emitted.
    // This test currently FAILS on baseline because no warning is implemented yet.
    // The B-HOOKS task in Phase 2 will implement the warning.
    expect(captured).toMatch(/version.*(skew|mismatch|different|warning)/i);
    expect(captured).toContain(VERSION);
    expect(captured).toContain(differentVersion);
  });

  test('detects version in hook snippet format', () => {
    // This test verifies the hook format assumptions used by the skew detection.
    // The hook snippet contains: `bunx --bun git-auto-remote@${VERSION}`
    installHook('post-checkout');

    const hookPath = join(local, '.git/hooks/post-checkout');
    const content = readFileSync(hookPath, 'utf8');

    // The hook should contain a pinned version in the bunx call
    expect(content).toMatch(/bunx --bun git-auto-remote@\d+\.\d+\.\d+/);

    // The version should match the current VERSION
    expect(content).toContain(`git-auto-remote@${VERSION}`);
  });
});
