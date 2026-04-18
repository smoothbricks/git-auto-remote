import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirrorPull } from '../src/commands/mirror-pull.js';
import { installHook } from '../src/lib/hooks.js';
import { trackingRefName } from '../src/lib/mirror-state.js';

/**
 * End-to-end coverage of the regenerate feature (v0.5.0).
 *
 * Setup: upstream and local have aligned packages/ content. `bun.lock` at repo
 * root is in regeneratePaths (not in syncPaths). A fake regenerateCommand
 * writes a deterministic bun.lock matching the current packages/ state. We
 * verify the command runs at the right moments, amends HEAD with the regen
 * output, and preserves author + author-date.
 */

let root: string;
let upstream: string;
let local: string;
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
  root = mkdtempSync(join(tmpdir(), 'gar-regen-int-'));
  upstream = join(root, 'upstream.git');
  local = join(root, 'local');

  git(root, 'init', '--bare', '-q', upstream);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', seed);
  commit(seed, 'packages/cli/a.ts', 'v1\n', 'pkg: add A');
  // Second (non-root) commit so the bootstrap target isn't a root commit;
  // root tracking refs would cause `mirror pull` to include the root in
  // the replay, which isn't what these tests are exercising.
  commit(seed, '.dummy-non-root-marker', 'x\n', 'seed: post-root marker');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', upstream);
  git(seed, 'push', '-q', 'origin', 'main');

  git(root, 'init', '-q', local);
  commit(local, 'packages/cli/a.ts', 'v1\n', 'local: add A');
  writeFileSync(join(local, 'bun.lock'), 'stale\n');
  git(local, 'add', '-A');
  git(local, 'commit', '-q', '-m', 'local: seed bun.lock');
  git(local, 'branch', '-M', 'private');
  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'fetch', '-q', 'upstream');

  git(local, 'config', 'auto-remote.upstream.syncPaths', 'packages');
  git(local, 'config', 'auto-remote.upstream.syncTargetBranch', 'private');
  git(local, 'config', 'auto-remote.upstream.syncBranch', 'main');
  git(local, 'config', 'auto-remote.upstream.pushSyncRef', 'false');
  git(local, 'config', 'auto-remote.upstream.regeneratePaths', 'bun.lock');

  // Tracking = upstream/main HEAD (post-root marker commit), NOT the root.
  git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));

  process.chdir(local);
  installHook('post-applypatch');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

/** Configure a regenerateCommand that overwrites bun.lock with a deterministic string. */
function setRegenerateCommand(cmd: string): void {
  git(local, 'config', 'auto-remote.upstream.regenerateCommand', cmd);
}

describe('regenerate on a clean range', () => {
  test('runs when upstream touched a regenerate path; amends the last commit, preserving metadata', async () => {
    // Push a clean-range commit to upstream that bumps bun.lock (and packages/).
    // The tool drops upstream's bun.lock from the patch and regenerates ours.
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2\n');
    writeFileSync(join(seed, 'bun.lock'), 'upstream-lock\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'pkg: bump A + lock');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    setRegenerateCommand("printf 'local-regenerated\\n' > bun.lock");

    const code = await mirrorPull({ remote: 'upstream' });
    expect(code).toBe(0);

    const headSha = git(local, 'rev-parse', 'HEAD');
    expect(git(local, 'show', '-s', '--format=%s', headSha)).toBe('pkg: bump A + lock');
    // bun.lock in HEAD is OUR regenerated content, NOT upstream's.
    expect(git(local, 'show', 'HEAD:bun.lock')).toBe('local-regenerated');
    expect(git(local, 'show', 'HEAD:packages/cli/a.ts')).toBe('v2');
    // Commit includes both files.
    const files = git(local, 'show', '--name-only', '--format=', headSha).split('\n').filter(Boolean).sort();
    expect(files).toEqual(['bun.lock', 'packages/cli/a.ts'].sort());
  });

  test('does NOT run when no commit in the range touched regenerate paths', async () => {
    // Upstream only bumps packages/ - no bun.lock change, no regen trigger.
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'pkg: bump A');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    // Command would fail if invoked.
    setRegenerateCommand('exit 1');

    const preBun = readFileSync(join(local, 'bun.lock'), 'utf8');
    const code = await mirrorPull({ remote: 'upstream' });
    expect(code).toBe(0);
    expect(readFileSync(join(local, 'bun.lock'), 'utf8')).toBe(preBun);
  });
});

describe('regenerate on a partial (sub-case B)', () => {
  test('regen runs before review overlay so HEAD has included + regen, worktree has only review', async () => {
    // Seed packages/reviewed at v1 on both sides so the overlay has a base.
    writeFileSync(join(local, 'packages/reviewed'), 'v1\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-q', '-m', 'local: seed reviewed');
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/reviewed'), 'v1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'up: seed reviewed');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));

    // Partial: bumps packages/cli/a.ts (included) AND packages/reviewed (review) AND bun.lock (regen).
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2\n');
    writeFileSync(join(seed, 'packages/reviewed'), 'v2\n');
    writeFileSync(join(seed, 'bun.lock'), 'upstream lock\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'feat: everything');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    git(local, 'config', 'auto-remote.upstream.reviewPaths', 'packages/reviewed');
    setRegenerateCommand("printf 'regenerated\\n' > bun.lock");

    const code = await mirrorPull({ remote: 'upstream' });
    expect(code).toBe(0);

    // HEAD has a.ts bumped AND the regenerated bun.lock (NOT upstream's "upstream lock").
    expect(git(local, 'show', 'HEAD:packages/cli/a.ts')).toBe('v2');
    expect(git(local, 'show', 'HEAD:bun.lock')).toBe('regenerated');
    // HEAD does NOT have reviewed bump; it's still v1 in HEAD.
    expect(git(local, 'show', 'HEAD:packages/reviewed')).toBe('v1');
    // Worktree has the reviewed bump as unstaged.
    expect(readFileSync(join(local, 'packages/reviewed'), 'utf8')).toBe('v2\n');
    // Worktree bun.lock matches HEAD's regenerated version (no leftover unstaged).
    expect(readFileSync(join(local, 'bun.lock'), 'utf8')).toBe('regenerated\n');
  });
});

describe('regenerate error propagation (v0.5.9)', () => {
  test('range: regen command non-zero exit HALTS the pull with code 1', async () => {
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2\n');
    writeFileSync(join(seed, 'bun.lock'), 'upstream-lock\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'pkg: bump A + lock');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    setRegenerateCommand('exit 42');

    const code = await mirrorPull({ remote: 'upstream' });
    // v0.5.9: non-zero regen exit propagates as pull failure.
    expect(code).toBe(1);
    // State: the git am applied the included subset (tracking advanced via
    // post-applypatch hook), but the amend did NOT happen. We halt loudly
    // so the user knows something went wrong. Worktree is whatever the
    // failed regen left it in (possibly unchanged since regen exited 0ly
    // before doing work).
  });

  test('sub-case B partial: regen command non-zero exit HALTS with code 1', async () => {
    // Seed a partial with review + regen content.
    writeFileSync(join(local, 'packages/reviewed'), 'v1\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-q', '-m', 'local: seed reviewed');
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/reviewed'), 'v1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'up: seed reviewed');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));

    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2\n');
    writeFileSync(join(seed, 'packages/reviewed'), 'v2\n');
    writeFileSync(join(seed, 'bun.lock'), 'upstream-lock\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'feat: partial + lock');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    git(local, 'config', 'auto-remote.upstream.reviewPaths', 'packages/reviewed');
    setRegenerateCommand('exit 17');

    const code = await mirrorPull({ remote: 'upstream' });
    expect(code).toBe(1);
  });
});

describe('regenerate safety: command must not touch paths outside regeneratePaths', () => {
  test('leaked changes outside regeneratePaths are NOT amended; tool continues with dirty tree', async () => {
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2\n');
    writeFileSync(join(seed, 'bun.lock'), 'upstream-lock\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'pkg: bump A + lock');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    // Command modifies bun.lock (in scope) AND touches a file outside regeneratePaths.
    setRegenerateCommand("printf 'regenerated\n' > bun.lock && printf 'leaked\n' > packages/cli/leaked.ts");

    const code = await mirrorPull({ remote: 'upstream' });
    expect(code).toBe(0); // amend happens for bun.lock, leaked stays dirty.

    // HEAD has bun.lock amended with our regenerated content.
    expect(git(local, 'show', 'HEAD:bun.lock')).toBe('regenerated');
    // The leaked file is in the worktree (untracked) and flagged in status.
    expect(existsSync(join(local, 'packages/cli/leaked.ts'))).toBe(true);
    const status = git(local, 'status', '--porcelain');
    expect(status).toContain('packages/cli/leaked.ts');
  });

  test('follow-up mirror pull after leak exits 1 with dirty tree message (HIGH-7)', async () => {
    // This test locks in the inline-comment claim at regen.ts:17-19:
    // "The next `mirror pull` will refuse with dirty-tree, surfacing the config bug."
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2\n');
    writeFileSync(join(seed, 'bun.lock'), 'upstream-lock\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'pkg: bump A + lock');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    // First pull: command leaks a file outside regeneratePaths.
    setRegenerateCommand("printf 'regenerated\n' > bun.lock && printf 'leaked\n' > packages/cli/leaked.ts");

    const firstCode = await mirrorPull({ remote: 'upstream' });
    expect(firstCode).toBe(0);
    expect(existsSync(join(local, 'packages/cli/leaked.ts'))).toBe(true);

    // Upstream has no new commits, but the leaked file makes the tree dirty.
    // Second pull should refuse with dirty-tree message.
    let stderrCaptured = '';
    const originalStderr = console.error;
    console.error = (...args: unknown[]) => {
      stderrCaptured += args.join(' ') + '\n';
    };

    const secondCode = await mirrorPull({ remote: 'upstream' });

    console.error = originalStderr;

    expect(secondCode).toBe(1);
    expect(stderrCaptured).toContain('Working tree is dirty');
    expect(stderrCaptured).toContain('upstream');
  });
});
