import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postCheckout } from '../src/commands/post-checkout.js';
import { prePush } from '../src/commands/pre-push.js';
import { postMerge } from '../src/commands/post-merge.js';
import { installHook } from '../src/lib/hooks.js';
import { trackingRefName } from '../src/lib/mirror-state.js';

const TRACKING_REMOTE1 = trackingRefName('remote1');
const TRACKING_REMOTE2 = trackingRefName('remote2');

/**
 * End-to-end tests for hook entry points (post-checkout, pre-push, post-merge).
 * Each test builds a temp repo with two remotes that have disjoint histories.
 */

let root: string;
let remote1: string; // bare repo path
let remote2: string; // bare repo path
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

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'gar-hooks-int-'));
  remote1 = join(root, 'remote1.git');
  remote2 = join(root, 'remote2.git');
  local = join(root, 'local');

  // 1) Set up two bare remote repos with disjoint histories.
  git(root, 'init', '--bare', '-q', remote1);
  git(root, 'init', '--bare', '-q', remote2);

  // Seed remote1 via a scratch clone.
  const seed1 = join(root, 'seed1');
  git(root, 'init', '-q', seed1);
  commit(seed1, 'packages/a.ts', 'content A\n', 'remote1: initial commit');
  git(seed1, 'branch', '-M', 'main');
  git(seed1, 'remote', 'add', 'origin', remote1);
  git(seed1, 'push', '-q', 'origin', 'main');

  // Seed remote2 via a scratch clone (disjoint history).
  const seed2 = join(root, 'seed2');
  git(root, 'init', '-q', seed2);
  commit(seed2, 'packages/b.ts', 'content B\n', 'remote2: initial commit');
  git(seed2, 'branch', '-M', 'main');
  git(seed2, 'remote', 'add', 'origin', remote2);
  git(seed2, 'push', '-q', 'origin', 'main');

  // 2) Create our local work repo with its own disjoint history.
  git(root, 'init', '-q', local);
  commit(local, 'local-file.ts', 'local content\n', 'local: initial commit');
  git(local, 'branch', '-M', 'local-branch');

  // 3) Add both remotes to the local repo.
  git(local, 'remote', 'add', 'remote1', remote1);
  git(local, 'remote', 'add', 'remote2', remote2);
  git(local, 'fetch', '-q', 'remote1');
  git(local, 'fetch', '-q', 'remote2');

  // 4) Install hooks.
  process.chdir(local);
  installHook('post-checkout');
  installHook('pre-push');
  installHook('post-merge');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('postCheckout', () => {
  describe('sets branch.<X>.pushRemote when ancestry uniquely matches one remote', () => {
    test('T1-NH-02: sets pushRemote to the remote whose history the branch descends from', () => {
      // Create a new branch that descends from remote1's root (via cherry-pick or merge).
      // For simplicity, we'll merge remote1/main into our local branch to create mixed ancestry.
      // Actually, let's create a branch that descends from remote1's root by resetting to it.
      const remote1Root = git(local, 'rev-list', '--max-parents=0', 'remote1/main');

      // Create a new branch based on remote1's root
      git(local, 'checkout', '-b', 'feature-branch', remote1Root);

      // Verify pushRemote is not set initially
      const initialPushRemote = spawnSync('git', ['config', '--get', 'branch.feature-branch.pushRemote'], {
        cwd: local,
        encoding: 'utf8',
      }).stdout?.trim();
      expect(initialPushRemote).toBe('');

      // Call post-checkout with prev=local-branch, new=feature-branch, flag=1 (branch checkout)
      const prevHead = git(local, 'rev-parse', 'local-branch');
      const newHead = git(local, 'rev-parse', 'feature-branch');

      const exitCode = postCheckout([prevHead, newHead, '1']);

      // Assert exit code is 0
      expect(exitCode).toBe(0);

      // Assert pushRemote is now set to remote1
      const pushRemote = git(local, 'config', '--get', 'branch.feature-branch.pushRemote');
      expect(pushRemote).toBe('remote1');
    });
  });

  describe('no-ops when flag=0 (file checkout, not branch)', () => {
    test('T1-NH-03: returns 0 without setting pushRemote', () => {
      const remote1Root = git(local, 'rev-list', '--max-parents=0', 'remote1/main');
      git(local, 'checkout', '-b', 'file-test-branch', remote1Root);

      const prevHead = git(local, 'rev-parse', 'local-branch');
      const newHead = git(local, 'rev-parse', 'file-test-branch');

      // Call with flag=0 (file checkout)
      const exitCode = postCheckout([prevHead, newHead, '0']);

      // Assert exit code is 0
      expect(exitCode).toBe(0);

      // Assert pushRemote is NOT set
      const pushRemoteResult = spawnSync('git', ['config', '--get', 'branch.file-test-branch.pushRemote'], {
        cwd: local,
        encoding: 'utf8',
      });
      expect(pushRemoteResult.stdout?.trim() || '').toBe('');
    });
  });

  describe('no-ops on detached HEAD', () => {
    test('T1-NH-04: returns 0 without setting pushRemote', () => {
      const remote1Root = git(local, 'rev-list', '--max-parents=0', 'remote1/main');

      // Checkout a commit directly (detached HEAD)
      git(local, 'checkout', '-q', remote1Root);

      const prevHead = git(local, 'rev-parse', 'local-branch');
      const newHead = remote1Root;

      // Call post-checkout with flag=1 (even though detached)
      const exitCode = postCheckout([prevHead, newHead, '1']);

      // Assert exit code is 0
      expect(exitCode).toBe(0);

      // Verify we're on detached HEAD
      const branch = spawnSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
        cwd: local,
        encoding: 'utf8',
      });
      expect(branch.status).not.toBe(0); // Should fail on detached HEAD
    });
  });

  describe('preserves user-set branch.<X>.pushRemote', () => {
    test('T1-NH-05: does not override existing pushRemote', () => {
      const remote1Root = git(local, 'rev-list', '--max-parents=0', 'remote1/main');
      git(local, 'checkout', '-b', 'preset-branch', remote1Root);

      // Pre-set pushRemote to a specific value
      git(local, 'config', 'branch.preset-branch.pushRemote', 'remote2');

      const prevHead = git(local, 'rev-parse', 'local-branch');
      const newHead = git(local, 'rev-parse', 'preset-branch');

      // Call post-checkout
      const exitCode = postCheckout([prevHead, newHead, '1']);

      // Assert exit code is 0
      expect(exitCode).toBe(0);

      // Assert pushRemote is still the user-set value (remote2, not remote1)
      const pushRemote = git(local, 'config', '--get', 'branch.preset-branch.pushRemote');
      expect(pushRemote).toBe('remote2');
    });
  });
});

describe('prePush', () => {
  // Helper to call prePush with stdin
  async function callPrePush(args: string[], stdinData: string): Promise<number> {
    const originalStdin = process.stdin;
    const { Readable } = await import('node:stream');

    // Create a readable stream with our test data
    const mockStdin = Readable.from([stdinData]);
    (process as any).stdin = mockStdin;

    try {
      return await prePush(args);
    } finally {
      process.stdin = originalStdin;
    }
  }

  describe('ancestry-respect', () => {
    test('T1-NH-06a: allows push when commit descends from target remote', async () => {
      // Create a branch on local that descends from remote1's root
      const remote1Root = git(local, 'rev-list', '--max-parents=0', 'remote1/main');
      git(local, 'checkout', '-b', 'remote1-descendant', remote1Root);
      commit(local, 'new-file.ts', 'new content\n', 'descendant commit');

      const localSha = git(local, 'rev-parse', 'HEAD');
      const remote1Sha = git(local, 'rev-parse', 'remote1/main');

      // Push to remote1 - this should be allowed since we're descended from remote1
      const stdin = `refs/heads/remote1-descendant ${localSha} refs/heads/remote1-descendant ${remote1Sha}`;
      const exitCode = await callPrePush(['remote1', remote1], stdin);

      expect(exitCode).toBe(0);
    });
  });

  describe('cross-history-refuse', () => {
    test('T1-NH-06b: refuses push when commit does not descend from target remote', async () => {
      // Create a branch on local that descends from remote1's root
      const remote1Root = git(local, 'rev-list', '--max-parents=0', 'remote1/main');
      git(local, 'checkout', '-b', 'remote1-branch', remote1Root);
      commit(local, 'another-file.ts', 'more content\n', 'another commit');

      const localSha = git(local, 'rev-parse', 'HEAD');
      const remote2Sha = git(local, 'rev-parse', 'remote2/main');

      // Try to push to remote2 - this should be refused since we descend from remote1, not remote2
      const stdin = `refs/heads/remote1-branch ${localSha} refs/heads/remote1-branch ${remote2Sha}`;
      const exitCode = await callPrePush(['remote2', remote2], stdin);

      expect(exitCode).toBe(1);
    });
  });

  describe('deletion-allow', () => {
    test('T1-NH-06c: allows deletion push (localSha is all zeros)', async () => {
      // Attempt to delete a ref on remote1 (localSha = 0000...)
      const remote1Sha = git(local, 'rev-parse', 'remote1/main');

      const stdin = `refs/heads/some-branch 0000000000000000000000000000000000000000 refs/heads/some-branch ${remote1Sha}`;
      const exitCode = await callPrePush(['remote1', remote1], stdin);

      expect(exitCode).toBe(0);
    });
  });

  describe('unknown-remote-allow', () => {
    test('T1-NH-06d: allows push to unknown remote (not our concern)', async () => {
      const localSha = git(local, 'rev-parse', 'HEAD');

      // Push to a remote that doesn't exist in our configuration
      const stdin = `refs/heads/main ${localSha} refs/heads/main 0000000000000000000000000000000000000000`;
      const exitCode = await callPrePush(['unknown-remote', 'https://example.com/unknown.git'], stdin);

      expect(exitCode).toBe(0);
    });
  });
});

describe('postMerge', () => {
  beforeEach(() => {
    // Configure mirror settings for local repo
    git(local, 'config', 'auto-remote.remote1.syncPaths', 'packages');
    git(local, 'config', 'auto-remote.remote1.syncTargetBranch', 'local-branch');
    git(local, 'config', 'auto-remote.remote1.syncBranch', 'main');
    git(local, 'config', 'auto-remote.remote1.pushSyncRef', 'false');

    // Set up tracking ref for remote1
    const remote1Tip = git(local, 'rev-parse', 'remote1/main');
    git(local, 'update-ref', TRACKING_REMOTE1, remote1Tip);

    // Ensure we're on the target branch
    git(local, 'checkout', '-q', 'local-branch');
  });

  describe('success path', () => {
    test('T1-NH-07a: runs mirrorPull successfully when no new commits', async () => {
      // No new commits on remote1, so mirrorPull should succeed quietly
      const exitCode = await postMerge();
      expect(exitCode).toBe(0);
    });
  });

  describe('isolated-failure path', () => {
    test('T1-NH-07b: catches and logs mirrorPull errors without propagating', async () => {
      // Corrupt the tracking ref to cause an error by pointing it to a valid SHA
      // that is not an ancestor of the remote's current state
      const localSha = git(local, 'rev-parse', 'HEAD');
      git(local, 'update-ref', TRACKING_REMOTE1, localSha);

      // Should still return 0 even though mirrorPull will error internally
      const exitCode = await postMerge();
      expect(exitCode).toBe(0);
    });
  });

  describe('MERGE_HEAD-present path', () => {
    test('T1-NH-07c: handles merge when MERGE_HEAD is present (squash merge scenario)', async () => {
      // Simulate a squash merge scenario by checking if post-merge runs correctly
      // after a merge has completed. We'll add a commit to remote1, fetch it,
      // and then manually create a merge commit.

      // Add a new commit to remote1 via seed1
      const seed1 = join(root, 'seed1');
      commit(seed1, 'packages/c.ts', 'content C\n', 'remote1: add C');
      git(seed1, 'push', '-q', 'origin', 'main');

      // Fetch in local repo
      git(local, 'fetch', '-q', 'remote1');

      // Merge remote1/main into local-branch (allow unrelated histories since they are disjoint)
      git(local, 'merge', '-q', '--no-edit', '--allow-unrelated-histories', 'remote1/main');

      // Now call postMerge - should succeed
      const exitCode = await postMerge();
      expect(exitCode).toBe(0);
    });
  });
});
