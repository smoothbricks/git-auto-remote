import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirrorPull } from '../src/commands/mirror-pull.js';
import { installHook } from '../src/lib/hooks.js';
import { readTrackingRef, trackingRefName } from '../src/lib/mirror-state.js';

/**
 * An echo: a change that crossed from the target to the mirror comes back on the next pull. It must be dropped as
 * already applied even after a later target commit changed the same lines, where `git am --3way` would conflict.
 */

const REVIEW_REF = 'refs/heads/gar-sync/x';
const TRACKING = trackingRefName('upstream');
const ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t' };

let root: string;
let seed: string;
let local: string;
let originalCwd: string;

function git(cwd: string, args: string[], input?: string, env: Record<string, string> = {}): string {
  const r = spawnSync('git', args, {
    cwd,
    input,
    env: { ...process.env, ...ENV, ...env },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed:\n${r.stdout}\n${r.stderr}`);
  return (r.stdout ?? '').trim();
}

/** A commit of <content> at <path>, authored at <time> (unix seconds) when given. */
function commit(cwd: string, path: string, content: string, message: string, time?: number): string {
  const full = join(cwd, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message], undefined, time ? { GIT_AUTHOR_DATE: `${time} +0000` } : {});
  return git(cwd, ['rev-parse', 'HEAD']);
}

/** Copy local commit <sha> onto the mirror the way the other direction does: format-patch | git am. */
function crossToMirror(sha: string): void {
  git(seed, ['am', '-q'], git(local, ['format-patch', '-1', '--stdout', sha]));
  git(seed, ['push', '-q', 'origin', 'main']);
  git(local, ['fetch', '-q', 'upstream']);
}

function quietly(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const orig = console.error;
  let err = '';
  console.error = (...a: unknown[]) => {
    err += `${a.map(String).join(' ')}\n`;
  };
  return fn()
    .then((code) => ({ code, err }))
    .finally(() => {
      console.error = orig;
    });
}

const pull = () =>
  quietly(() => mirrorPull({ remote: 'upstream', nonInteractive: true, reviewRef: REVIEW_REF, seedTracking: false }));

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'gar-echo-'));
  const upstream = join(root, 'upstream.git');
  seed = join(root, 'seed');
  local = join(root, 'local');
  git(root, ['init', '--bare', '-q', upstream]);
  git(root, ['init', '-q', seed]);
  commit(seed, 'packages/cli/a.ts', 'v1\n', 'pkg: add A');
  git(seed, ['branch', '-M', 'main']);
  git(seed, ['remote', 'add', 'origin', upstream]);
  git(seed, ['push', '-q', 'origin', 'main']);

  git(root, ['init', '-q', local]);
  commit(local, 'packages/cli/a.ts', 'v1\n', 'private: a');
  git(local, ['branch', '-M', 'private']);
  git(local, ['remote', 'add', 'upstream', upstream]);
  git(local, ['fetch', '-q', 'upstream']);
  for (const [key, value] of [
    ['syncPaths', 'packages'],
    ['syncTargetBranch', 'private'],
    ['syncBranch', 'main'],
    ['pushSyncRef', 'false'],
  ]) {
    git(local, ['config', `auto-remote.upstream.${key}`, value]);
  }
  git(local, ['update-ref', TRACKING, git(local, ['rev-parse', 'upstream/main'])]);
  process.chdir(local);
  installHook('post-applypatch');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('mirror pull: a change coming back from the mirror', () => {
  test('is dropped as already applied after a later target commit changed the same line', async () => {
    const release = commit(local, 'packages/cli/a.ts', 'v2\n', 'chore(release): publish');
    commit(local, 'packages/cli/a.ts', 'v3-next\n', 'chore(release): prepare next prerelease');
    crossToMirror(release);
    const head = git(local, ['rev-parse', 'HEAD']);

    const { code, err } = await pull();
    expect(err).not.toContain('conflict');
    expect(code).toBe(0);
    expect(err).toContain('already on private');
    expect(git(local, ['rev-parse', 'HEAD'])).toBe(head);
    expect(readTrackingRef('upstream')).toBe(git(local, ['rev-parse', 'upstream/main']));
  });

  test('still applies the mirror commits around it', async () => {
    const release = commit(local, 'packages/cli/a.ts', 'v2\n', 'chore(release): publish');
    commit(local, 'packages/cli/a.ts', 'v3-next\n', 'chore(release): prepare next prerelease');
    commit(seed, 'packages/cli/b.ts', 'B\n', 'pkg: add B');
    crossToMirror(release);
    commit(seed, 'packages/cli/c.ts', 'C\n', 'pkg: add C');
    git(seed, ['push', '-q', 'origin', 'main']);
    git(local, ['fetch', '-q', 'upstream']);

    const { code, err } = await pull();
    expect(err).not.toContain('conflict');
    expect(code).toBe(0);
    expect(git(local, ['log', '--format=%s', '-2'])).toBe('pkg: add C\npkg: add B');
    expect(git(local, ['show', 'HEAD:packages/cli/a.ts'])).toBe('v3-next');
    expect(readTrackingRef('upstream')).toBe(git(local, ['rev-parse', 'upstream/main']));
  });

  test('is not confused with the same edit made independently at another time', async () => {
    commit(local, 'packages/cli/a.ts', 'v2\n', 'private: bump A', 1_800_000_000);
    commit(local, 'packages/cli/a.ts', 'v3-next\n', 'private: bump A again', 1_800_000_100);
    commit(seed, 'packages/cli/a.ts', 'v2\n', 'pkg: bump A', 1_800_000_050);
    git(seed, ['push', '-q', 'origin', 'main']);
    git(local, ['fetch', '-q', 'upstream']);

    const { code } = await pull();
    expect(code).toBe(2);
  });
});

describe('mirror pull: a conflict a person resolved in the review ref', () => {
  test('is not replayed once the resolution is merged, whatever content the person kept', async () => {
    commit(local, 'packages/cli/a.ts', 'local\n', 'private: edit A');
    commit(seed, 'packages/cli/a.ts', 'v2\n', 'pkg: bump A');
    git(seed, ['push', '-q', 'origin', 'main']);
    git(local, ['fetch', '-q', 'upstream']);
    expect((await pull()).code).toBe(2);

    // The review PR: one commit on top of the review ref keeps the target's line, then a rebase merge.
    git(local, ['switch', '-q', '--detach', REVIEW_REF]);
    commit(local, 'packages/cli/a.ts', 'local\n', 'private: keep A');
    git(local, ['branch', '-f', 'private', 'HEAD']);
    git(local, ['switch', '-q', 'private']);
    const merged = git(local, ['rev-parse', 'HEAD']);

    const { code, err } = await pull();
    expect(err).not.toContain('conflict');
    expect(code).toBe(0);
    expect(err).toContain('already on private');
    expect(git(local, ['rev-parse', 'HEAD'])).toBe(merged);
    expect(readTrackingRef('upstream')).toBe(git(local, ['rev-parse', 'upstream/main']));
  });

  test('still applies a second mirror commit with the same author, time and message', async () => {
    commit(seed, 'packages/cli/b.ts', 'B\n', 'pkg: add file', 1_800_000_000);
    const first = git(seed, ['rev-parse', 'HEAD']);
    commit(seed, 'packages/cli/c.ts', 'C\n', 'pkg: add file', 1_800_000_000);
    git(seed, ['push', '-q', 'origin', 'main']);
    git(local, ['fetch', '-q', 'upstream']);
    git(local, ['am', '-q'], git(seed, ['format-patch', '-1', '--stdout', first]));

    const { code, err } = await pull();
    expect(err).not.toContain('conflict');
    expect(code).toBe(0);
    expect(git(local, ['show', 'HEAD:packages/cli/c.ts'])).toBe('C');
    expect(readTrackingRef('upstream')).toBe(git(local, ['rev-parse', 'upstream/main']));
  });
});
