import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHook } from '../src/lib/hooks.js';
import { mirrorPull } from '../src/commands/mirror-pull.js';

/**
 * End-to-end tests that exercise mirror-pull against a real pair of git repos
 * with disjoint histories. Each test builds:
 *
 *   upstream/   (bare)  --  contains the public-ish history (root: pkg A)
 *   local/      (work)  --  our clone; contains the private-ish history (root: priv A)
 *                           with `upstream` configured as a mirror
 *
 * We then apply commits to upstream, run mirror-pull, and assert on local.
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
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`,
    );
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
  root = mkdtempSync(join(tmpdir(), 'gar-mirror-int-'));
  upstream = join(root, 'upstream.git');
  local = join(root, 'local');

  // 1) Set up a bare upstream repo and seed it via a scratch clone.
  git(root, 'init', '--bare', '-q', upstream);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', seed);
  commit(seed, 'packages/cli/a.ts', 'pkg A v1\n', 'pkg: add A');
  commit(seed, 'packages/cli/b.ts', 'pkg B v1\n', 'pkg: add B');
  // A root-level public-only file to ensure it's excluded from sync.
  commit(seed, 'README.md', 'Public readme\n', 'docs: add readme');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', upstream);
  git(seed, 'push', '-q', 'origin', 'main');

  // 2) Create our local work repo with a disjoint private history.
  //    Content in packages/ is IDENTICAL to upstream (blob hashes line up).
  git(root, 'init', '-q', local);
  commit(local, 'packages/cli/a.ts', 'pkg A v1\n', 'private: import A');
  commit(local, 'packages/cli/b.ts', 'pkg B v1\n', 'private: import B');
  commit(local, 'privpkgs/secret.ts', 'secret v1\n', 'private: add secret');
  git(local, 'branch', '-M', 'private');

  // 3) Add upstream as a mirror remote in local.
  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'fetch', '-q', 'upstream');

  // 4) Configure mirror settings: syncPaths=packages, target branch=private.
  git(local, 'config', 'fork-remote.upstream.syncPaths', 'packages');
  git(local, 'config', 'fork-remote.upstream.syncTargetBranch', 'private');
  git(local, 'config', 'fork-remote.upstream.syncBranch', 'main');
  git(local, 'config', 'fork-remote.upstream.pushSyncRef', 'false');

  // 5) Bootstrap the tracking ref to upstream's current tip (content is in sync).
  const upstreamTip = git(local, 'rev-parse', 'upstream/main');
  git(local, 'update-ref', 'refs/git-auto-remote/mirror/upstream', upstreamTip);

  // 6) Install hooks so post-applypatch runs.
  process.chdir(local);
  installHook('post-applypatch');
  installHook('post-merge'); // unused in these tests but realistic
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('mirror pull', () => {
  describe('when the mirror has no new commits', () => {
    test('exits 0, no changes', async () => {
      const before = git(local, 'rev-parse', 'HEAD');
      const code = await mirrorPull({ remote: 'upstream' });
      expect(code).toBe(0);
      expect(git(local, 'rev-parse', 'HEAD')).toBe(before);
    });
  });

  describe('when the mirror has only clean commits', () => {
    beforeEach(() => {
      const seed = join(root, 'seed');
      commit(seed, 'packages/cli/c.ts', 'pkg C v1\n', 'pkg: add C');
      commit(seed, 'packages/cli/a.ts', 'pkg A v2\n', 'pkg: bump A');
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
    });

    test('cherry-picks all commits onto the local branch', async () => {
      const headBefore = git(local, 'rev-parse', 'HEAD');
      const code = await mirrorPull({ remote: 'upstream' });
      expect(code).toBe(0);
      const log = git(local, 'log', '--format=%s', `${headBefore}..HEAD`).split('\n');
      expect(log).toEqual(['pkg: bump A', 'pkg: add C']); // newest first
    });

    test('advances the tracking ref to the mirror tip', async () => {
      await mirrorPull({ remote: 'upstream' });
      const upstreamTip = git(local, 'rev-parse', 'upstream/main');
      const tracking = git(local, 'rev-parse', 'refs/git-auto-remote/mirror/upstream');
      expect(tracking).toBe(upstreamTip);
    });
  });

  describe('when the mirror has out-of-scope commits', () => {
    beforeEach(() => {
      const seed = join(root, 'seed');
      commit(seed, 'README.md', 'Updated readme\n', 'docs: update readme');
      commit(seed, 'packages/cli/a.ts', 'pkg A v2\n', 'pkg: bump A');
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
    });

    test('applies only the in-scope commit; out-of-scope is absorbed silently', async () => {
      const headBefore = git(local, 'rev-parse', 'HEAD');
      const code = await mirrorPull({ remote: 'upstream' });
      expect(code).toBe(0);
      const log = git(local, 'log', '--format=%s', `${headBefore}..HEAD`).split('\n');
      expect(log).toEqual(['pkg: bump A']);
    });
  });

  describe('when the mirror has a partial commit', () => {
    beforeEach(() => {
      const seed = join(root, 'seed');
      // A partial: touches both a synced path AND an excluded path in one commit.
      writeFileSync(join(seed, 'packages/cli/a.ts'), 'pkg A v2\n');
      writeFileSync(join(seed, 'README.md'), 'Mixed readme\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-q', '-m', 'feat: bump A and readme');
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
    });

    test('--non-interactive stops with exit 2 and does not commit the partial', async () => {
      const headBefore = git(local, 'rev-parse', 'HEAD');
      const code = await mirrorPull({ remote: 'upstream', nonInteractive: true });
      expect(code).toBe(2);
      // Partial was applied then reset, so HEAD is unchanged.
      expect(git(local, 'rev-parse', 'HEAD')).toBe(headBefore);
    });

    test('interactive mode pauses with the partial committed and a review marker', async () => {
      const headBefore = git(local, 'rev-parse', 'HEAD');
      const code = await mirrorPull({ remote: 'upstream' });
      expect(code).toBe(0);
      // Partial IS applied (user can amend).
      expect(git(local, 'rev-parse', 'HEAD')).not.toBe(headBefore);
      // Review-pending file is present.
      expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(true);
    });
  });

  describe('when the mirror was force-pushed', () => {
    beforeEach(() => {
      // Rewrite history on upstream so the existing tracking ref is no longer an ancestor.
      const seed = join(root, 'seed');
      git(seed, 'reset', '--hard', 'HEAD~1');
      commit(seed, 'packages/cli/d.ts', 'pkg D v1\n', 'pkg: replacement after rewrite');
      git(seed, 'push', '-qf', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
    });

    test('refuses to continue and tells the user to re-bootstrap', async () => {
      const code = await mirrorPull({ remote: 'upstream' });
      expect(code).toBe(1);
    });
  });

  describe('when current branch is not the syncTargetBranch', () => {
    test('silently skips (exit 0, no commits)', async () => {
      // Create and checkout a feature branch so we're not on 'private'.
      git(local, 'checkout', '-q', '-b', 'feat/x');
      const headBefore = git(local, 'rev-parse', 'HEAD');
      const code = await mirrorPull({ remote: 'upstream' });
      expect(code).toBe(0);
      expect(git(local, 'rev-parse', 'HEAD')).toBe(headBefore);
    });
  });
});

describe('mirror pull with --on-partial handler', () => {
  let handlerScript: string;

  beforeEach(() => {
    // A partial commit on the mirror for all tests in this block.
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'pkg A v2\n');
    writeFileSync(join(seed, 'README.md'), 'Mixed readme\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'feat: bump A and readme');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    handlerScript = join(root, 'handler.sh');
  });

  test('handler exit 0 = continue: the applied subset stays, no review pending', async () => {
    writeFileSync(handlerScript, '#!/usr/bin/env bash\nexit 0\n');
    execFileSync('chmod', ['+x', handlerScript]);
    const headBefore = git(local, 'rev-parse', 'HEAD');
    const code = await mirrorPull({
      remote: 'upstream',
      nonInteractive: true,
      onPartial: handlerScript,
    });
    expect(code).toBe(0);
    expect(git(local, 'rev-parse', 'HEAD')).not.toBe(headBefore);
    expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
  });

  test('handler exit 2 = skip: HEAD reset, tracking ref still advances (next run resumes past)', async () => {
    writeFileSync(handlerScript, '#!/usr/bin/env bash\nexit 2\n');
    execFileSync('chmod', ['+x', handlerScript]);
    const headBefore = git(local, 'rev-parse', 'HEAD');
    const trackingBefore = git(local, 'rev-parse', 'refs/git-auto-remote/mirror/upstream');
    const code = await mirrorPull({
      remote: 'upstream',
      nonInteractive: true,
      onPartial: handlerScript,
    });
    expect(code).toBe(0);
    expect(git(local, 'rev-parse', 'HEAD')).toBe(headBefore);
    const trackingAfter = git(local, 'rev-parse', 'refs/git-auto-remote/mirror/upstream');
    expect(trackingAfter).not.toBe(trackingBefore); // advanced past the skipped commit
  });

  test('handler exit 1 = punt: in --non-interactive, stops with exit 2', async () => {
    writeFileSync(handlerScript, '#!/usr/bin/env bash\nexit 1\n');
    execFileSync('chmod', ['+x', handlerScript]);
    const code = await mirrorPull({
      remote: 'upstream',
      nonInteractive: true,
      onPartial: handlerScript,
    });
    expect(code).toBe(2);
  });
});

describe('mirror pull with reviewPaths', () => {
  beforeEach(() => {
    // A commit on upstream that ONLY touches a review-required path.
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/gitconfig'), 'v2\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'chore: bump gitconfig');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    git(local, 'config', 'fork-remote.upstream.reviewPaths', 'packages/gitconfig');
  });

  test('treats a commit touching only a reviewPath as partial (pause for review)', async () => {
    const code = await mirrorPull({ remote: 'upstream' });
    expect(code).toBe(0); // paused cleanly
    // Review marker written
    expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(true);
  });
});

describe('mirror pull with excludePaths', () => {
  beforeEach(() => {
    // A commit touching a shared path AND a to-be-excluded path.
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'pkg A v2\n');
    mkdirSync(join(seed, 'packages/internal'), { recursive: true });
    writeFileSync(join(seed, 'packages/internal/secret.ts'), 'do not mirror\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'feat: bump A and add internal secret');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    git(local, 'config', 'fork-remote.upstream.excludePaths', 'packages/internal');
  });

  test('excluded paths are dropped entirely: the commit is classified clean and auto-applied', async () => {
    const code = await mirrorPull({ remote: 'upstream' });
    expect(code).toBe(0);
    // Partial commit should NOT have been recorded - the excluded path drops out of both
    // `included` and `excluded` during classification.
    expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
    // a.ts change landed
    const aContent = require('node:fs').readFileSync(join(local, 'packages/cli/a.ts'), 'utf8');
    expect(aContent).toBe('pkg A v2\n');
    // internal/secret.ts must NOT have been copied into local
    expect(existsSync(join(local, 'packages/internal/secret.ts'))).toBe(false);
  });
});

describe('mirror pull with root commits on the mirror', () => {
  test("can replay the mirror's root commit (regression: format-patch first^..last)", async () => {
    // Build a fresh pair where we DO NOT bootstrap from upstream's tip; instead
    // we bootstrap the tracking ref to a commit on an unrelated history (local's
    // root) so that rev-list tracking..upstream/main includes upstream's root.
    const upstreamRoot = git(join(root, 'seed'), 'rev-list', '--max-parents=0', 'HEAD');
    const localRoot = git(local, 'rev-list', '--max-parents=0', 'private');

    // Point tracking ref at local's root (unrelated to upstream history).
    git(local, 'update-ref', 'refs/git-auto-remote/mirror/upstream', localRoot);

    // Confirm rev-list now includes upstream's root.
    const rangeOut = git(
      local,
      'rev-list',
      '--reverse',
      `${localRoot}..upstream/main`,
    ).split('\n');
    expect(rangeOut[0]).toBe(upstreamRoot); // first commit in range IS the root

    // The replay should succeed - the fix switches `format-patch first^..last` to
    // an explicit SHA list, which works even when `first` has no parent.
    const code = await mirrorPull({ remote: 'upstream' });
    expect(code).toBe(0);

    // The root commit's content (packages/cli/a.ts from pkg:add A) should have
    // landed on local via the replay (local already had it from its own root,
    // so an empty patch was dropped - the important assertion is that no error
    // surfaced from `format-patch root^..`).
    expect(existsSync(join(local, 'packages/cli/a.ts'))).toBe(true);
  });
});
