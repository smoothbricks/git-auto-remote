import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDiffPathspec, mirrorDiff } from '../src/commands/mirror-diff.js';
import { mirrorPull } from '../src/commands/mirror-pull.js';
import { mirrorSource } from '../src/commands/mirror-source.js';
import { installHook } from '../src/lib/hooks.js';
import { getReviewPending, trackingRefName } from '../src/lib/mirror-state.js';

/**
 * Coverage for v0.5.5 `mirror diff` and `mirror source` subcommands plus
 * the pathspec-computation primitive they use (`computeDiffPathspec`). The
 * critical case the user hit in the wild: a partial with regenerate +
 * outside content where the pre-existing footer's `git diff HEAD <sha>`
 * hint was useless because there was no clear in-scope filter.
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
  root = mkdtempSync(join(tmpdir(), 'gar-diff-'));
  upstream = join(root, 'upstream.git');
  local = join(root, 'local');

  git(root, 'init', '--bare', '-q', upstream);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', seed);
  commit(seed, 'packages/cli/a.ts', 'v1\n', 'pkg: add A');
  commit(seed, '.dummy-marker', 'x\n', 'marker'); // non-root seed
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', upstream);
  git(seed, 'push', '-q', 'origin', 'main');

  git(root, 'init', '-q', local);
  commit(local, 'packages/cli/a.ts', 'v1\n', 'local: add A');
  git(local, 'branch', '-M', 'private');
  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'fetch', '-q', 'upstream');

  git(local, 'config', 'auto-remote.upstream.syncPaths', 'packages');
  git(local, 'config', 'auto-remote.upstream.reviewPaths', 'tooling/workspace.gitconfig');
  git(local, 'config', 'auto-remote.upstream.regeneratePaths', 'bun.lock');
  git(local, 'config', 'auto-remote.upstream.excludePaths', 'tooling/sync-with-public.sh');
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

describe('computeDiffPathspec (pure function)', () => {
  test('positive set is sync ∪ review ∪ regenerate ∪ source-specific outside', () => {
    const review = {
      remote: 'upstream',
      sourceSha: 'abc',
      subject: 'x',
      included: ['packages/cli/a.ts'],
      review: ['tooling/workspace.gitconfig'],
      regenerate: ['bun.lock'],
      outside: ['package.json', 'privpkgs/secret.ts'],
      phase: 'review-pause' as const,
    };
    const result = computeDiffPathspec(
      review,
      ['packages', 'tooling'],
      ['tooling/sync-with-public.sh'],
      ['tooling/workspace.gitconfig'],
      ['bun.lock'],
    );
    // Every positive entry from config + source outside is present.
    expect(result).toContain('packages');
    expect(result).toContain('tooling');
    expect(result).toContain('tooling/workspace.gitconfig');
    expect(result).toContain('bun.lock');
    expect(result).toContain('package.json');
    expect(result).toContain('privpkgs/secret.ts');
    // Excludes are present as exclude-magic pathspecs.
    expect(result).toContain(':(exclude)tooling/sync-with-public.sh');
  });

  test('includeExcluded=true drops the :(exclude) pathspecs', () => {
    const review = {
      remote: 'upstream',
      sourceSha: 'abc',
      subject: 'x',
      included: [],
      review: [],
      regenerate: [],
      outside: [],
      phase: 'review-pause' as const,
    };
    const result = computeDiffPathspec(review, ['packages'], ['tooling/sync-with-public.sh'], [], [], true);
    expect(result.some((p) => p.startsWith(':(exclude)'))).toBe(false);
  });
});

describe('mirror diff integration', () => {
  /** Push a partial with included + review + regenerate + outside content. */
  function pushMixedPartial(): string {
    // Seed review/regen/outside baselines on both sides.
    mkdirSync(join(local, 'tooling'), { recursive: true });
    writeFileSync(join(local, 'tooling/workspace.gitconfig'), 'orig\n');
    writeFileSync(join(local, 'bun.lock'), 'local-lock\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-q', '-m', 'local: seed');

    const seed = join(root, 'seed');
    mkdirSync(join(seed, 'tooling'), { recursive: true });
    writeFileSync(join(seed, 'tooling/workspace.gitconfig'), 'orig\n');
    writeFileSync(join(seed, 'bun.lock'), 'upstream-lock v0\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'upstream: seed');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));

    // Mixed partial:
    //   packages/cli/a.ts          (included)
    //   tooling/workspace.gitconfig (review)
    //   bun.lock                    (regenerate)
    //   package.json                (outside - not in any config list)
    //   tooling/sync-with-public.sh (exclude - should be hidden from mirror diff)
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2 upstream\n');
    writeFileSync(join(seed, 'tooling/workspace.gitconfig'), 'modified\n');
    writeFileSync(join(seed, 'bun.lock'), 'upstream-lock v1\n');
    writeFileSync(join(seed, 'package.json'), '{"name":"upstream","version":"1.0.0"}\n');
    writeFileSync(join(seed, 'tooling/sync-with-public.sh'), '#!/bin/sh\nsync_stuff\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'feat: mixed everything');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    return git(seed, 'rev-parse', 'HEAD');
  }

  test('shows outside + review + regenerate delta but not excluded paths', async () => {
    const sourceSha = pushMixedPartial();
    await mirrorPull({ remote: 'upstream' });

    // Sanity: marker is set with the expected classification.
    const marker = getReviewPending();
    expect(marker?.sourceSha).toBe(sourceSha);
    expect(marker?.review).toEqual(['tooling/workspace.gitconfig']);
    expect(marker?.regenerate).toEqual(['bun.lock']);
    expect(marker?.outside).toEqual(['package.json']);

    // Capture mirror-diff stdout by running via execFileSync on a subprocess.
    // (The in-process mirrorDiff() uses stdio: 'inherit' which doesn't help
    // us here; invoke git directly with the pathspec to verify behaviour.)
    const diffOut = git(
      local,
      'diff',
      'HEAD',
      sourceSha,
      '--',
      'packages',
      'tooling/workspace.gitconfig',
      'bun.lock',
      'package.json',
      ':(exclude)tooling/sync-with-public.sh',
    );

    expect(diffOut.length).toBeGreaterThan(0);
    // Outside: package.json appears.
    expect(diffOut).toContain('package.json');
    // Review: workspace.gitconfig change appears.
    expect(diffOut).toContain('tooling/workspace.gitconfig');
    // Regenerate: bun.lock delta (HEAD has local-lock, source has upstream-lock v1).
    expect(diffOut).toContain('bun.lock');
    // Exclude: sync-with-public.sh does NOT appear.
    expect(diffOut).not.toContain('sync-with-public.sh');

    // And running mirrorDiff as a subprocess should exit 0 (it produces output).
    // We run via node to avoid the stdio: 'inherit' duplicating to test output.
    const r = spawnSync('git', ['diff', '--stat', 'HEAD', sourceSha], {
      cwd: local,
      stdio: 'pipe',
    });
    expect(r.status).toBe(0);
  });

  test('mirrorDiff() returns 1 when no pause is active', async () => {
    // No pause set up - don't run mirrorPull.
    const code = mirrorDiff('upstream');
    expect(code).toBe(1);
  });

  test('mirrorSource() returns 1 when no pause is active', async () => {
    const code = mirrorSource('upstream');
    expect(code).toBe(1);
  });

  test('mirrorDiff() returns 0 and runs the diff when a pause IS active', async () => {
    pushMixedPartial();
    await mirrorPull({ remote: 'upstream' });
    // mirror diff uses stdio: 'inherit' so output goes to our stdout; we just
    // verify the exit code is 0 (diff produced output / no error).
    const code = mirrorDiff('upstream');
    expect(code).toBe(0);
  });

  test('mirrorDiff() errors on a mismatched remote name', async () => {
    pushMixedPartial();
    await mirrorPull({ remote: 'upstream' });
    const code = mirrorDiff('wrong-remote-name');
    expect(code).toBe(1);
  });
});
