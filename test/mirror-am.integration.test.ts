import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirrorAmContinue } from '../src/commands/mirror-am-continue.js';
import { mirrorAmSkip } from '../src/commands/mirror-am-skip.js';
import { mirrorPull } from '../src/commands/mirror-pull.js';
import { installHook } from '../src/lib/hooks.js';
import { trackingRefName } from '../src/lib/mirror-state.js';

/**
 * End-to-end coverage of the conflict-recovery commands. We build a pair of
 * disjoint-history repos, drive `mirror pull` to the point of a conflict, then
 * exercise `mirror am-skip` and `mirror am-continue` against that state.
 */

let root: string;
let upstream: string; // bare
let local: string; // working clone
let originalCwd: string;

const TRACKING = trackingRefName('upstream');

const ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...ENV },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${r.stdout}\n${r.stderr}`);
  }
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

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'gar-am-int-'));
  upstream = join(root, 'upstream.git');
  local = join(root, 'local');

  git(root, 'init', '--bare', '-q', upstream);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', seed);
  commit(seed, 'packages/cli/a.ts', 'v1 upstream\n', 'pkg: add A');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', upstream);
  git(seed, 'push', '-q', 'origin', 'main');

  // local has a DIVERGING version of packages/cli/a.ts (so patches from upstream conflict).
  git(root, 'init', '-q', local);
  commit(local, 'packages/cli/a.ts', 'v1 local (different)\n', 'local: add A');
  git(local, 'branch', '-M', 'private');
  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'fetch', '-q', 'upstream');

  git(local, 'config', 'fork-remote.upstream.syncPaths', 'packages');
  git(local, 'config', 'fork-remote.upstream.syncTargetBranch', 'private');
  git(local, 'config', 'fork-remote.upstream.syncBranch', 'main');
  git(local, 'config', 'fork-remote.upstream.pushSyncRef', 'false');

  // Bootstrap tracking ref to upstream's INITIAL commit so the next upstream
  // commit is what mirror-pull attempts to apply.
  const upstreamRoot = git(local, 'rev-list', '--max-parents=0', 'upstream/main');
  git(local, 'update-ref', TRACKING, upstreamRoot);

  process.chdir(local);
  installHook('post-applypatch');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

/** Add a conflicting commit on upstream so the next `mirror pull` hits `git am` conflict. */
function pushUpstreamConflict(message = 'pkg: bump A to v2'): string {
  const seed = join(root, 'seed');
  writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2 upstream\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', message);
  git(seed, 'push', '-q', 'origin', 'main');
  git(local, 'fetch', '-q', 'upstream');
  return git(seed, 'rev-parse', 'HEAD');
}

describe('mirror am-skip', () => {
  test('drops the stuck patch and advances tracking ref past it', async () => {
    const conflictSha = pushUpstreamConflict();

    // Trigger conflict.
    await mirrorPull({ remote: 'upstream' });
    expect(existsSync(join(local, '.git/rebase-apply'))).toBe(true);

    const trackingBefore = git(local, 'rev-parse', TRACKING);
    expect(trackingBefore).not.toBe(conflictSha);

    const code = await mirrorAmSkip('upstream');
    expect(code).toBe(0);

    // am is done.
    expect(existsSync(join(local, '.git/rebase-apply'))).toBe(false);
    // Tracking ref advanced to the skipped commit's SHA.
    expect(git(local, 'rev-parse', TRACKING)).toBe(conflictSha);
    // Sentinel cleared (single-patch run).
    expect(existsSync(join(local, '.git/git-auto-remote/mirror-in-progress'))).toBe(false);
  });

  test('returns 1 when no git am is in progress', async () => {
    const code = await mirrorAmSkip('upstream');
    expect(code).toBe(1);
  });
});

describe('mirror am-continue', () => {
  test('resolves the conflict via the user-edited index and auto-advances', async () => {
    const conflictSha = pushUpstreamConflict();

    await mirrorPull({ remote: 'upstream' });
    expect(existsSync(join(local, '.git/rebase-apply'))).toBe(true);

    // User "resolves" by choosing the upstream version.
    writeFileSync(join(local, 'packages/cli/a.ts'), 'v2 upstream\n');
    git(local, 'add', 'packages/cli/a.ts');

    const code = await mirrorAmContinue('upstream');
    expect(code).toBe(0);

    expect(existsSync(join(local, '.git/rebase-apply'))).toBe(false);
    expect(git(local, 'rev-parse', TRACKING)).toBe(conflictSha);
    expect(existsSync(join(local, '.git/git-auto-remote/mirror-in-progress'))).toBe(false);
    // A commit landed with the upstream content.
    const aContent = require('node:fs').readFileSync(join(local, 'packages/cli/a.ts'), 'utf8');
    expect(aContent).toBe('v2 upstream\n');
  });

  test('returns 1 when no git am is in progress', async () => {
    const code = await mirrorAmContinue('upstream');
    expect(code).toBe(1);
  });
});
