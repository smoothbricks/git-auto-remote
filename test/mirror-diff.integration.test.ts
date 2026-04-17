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
 * Coverage for the `mirror diff` and `mirror source` subcommands plus
 * `computeDiffPathspec`. Exists primarily to prevent the v0.5.5 regression
 * where the pathspec used ALL configured sync/review/regenerate paths, so
 * any path that drifted between HEAD and source (from unrelated prior
 * commits) showed up in the diff - flooding the output with 2000+ lines
 * of noise for a commit that only actually touched a handful of paths.
 *
 * The invariant the v0.5.6 fix enforces: `mirror diff` shows only paths
 * THIS SOURCE COMMIT touched, restricted to the review/regenerate/outside
 * buckets of THIS commit's classification (as stored in the review-pending
 * marker). Paths in any of those config lists that this commit DIDN'T
 * touch must not appear.
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
  test('returns review ∪ regenerate ∪ outside (source-commit-specific only)', () => {
    const result = computeDiffPathspec({
      remote: 'upstream',
      sourceSha: 'abc',
      subject: 'x',
      included: ['packages/cli/a.ts'],
      review: ['tooling/workspace.gitconfig'],
      regenerate: ['bun.lock'],
      outside: ['package.json', 'privpkgs/secret.ts'],
      phase: 'review-pause',
    });
    expect(result).toEqual(['tooling/workspace.gitconfig', 'bun.lock', 'package.json', 'privpkgs/secret.ts']);
    // `included` paths MUST NOT be in the filter - they landed in HEAD
    // via `git am`, their diff against source is empty.
    expect(result).not.toContain('packages/cli/a.ts');
  });

  test('empty buckets produce an empty pathspec (= full unfiltered diff)', () => {
    const result = computeDiffPathspec({
      remote: 'upstream',
      sourceSha: 'abc',
      subject: 'x',
      included: ['packages/cli/a.ts'],
      review: [],
      regenerate: [],
      outside: [],
      phase: 'review-pause',
    });
    expect(result).toEqual([]);
  });
});

describe('mirror diff integration', () => {
  /**
   * Push a partial with included + review + regenerate + outside content,
   * PLUS introduce drift (local has changes to a path outside this commit's
   * buckets, to verify the pathspec scopes the diff correctly).
   */
  function pushMixedPartialWithDrift(): {
    sourceSha: string;
    driftedPath: string;
  } {
    // Seed review/regen baselines on both sides.
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

    // DRIFT: local-only divergence on packages/cli/a.ts, NOT touched by the
    // upcoming source commit. This is the trap the v0.5.5 pathspec fell
    // into - earlier code included 'packages' (syncPath) as positive filter,
    // surfacing this drift as noise in every diff.
    writeFileSync(join(local, 'packages/cli/a.ts'), 'local-v2-DRIFT\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-q', '-m', 'local: diverge a.ts (unrelated to upstream)');

    // Mixed partial on upstream:
    //   tooling/workspace.gitconfig (review)
    //   bun.lock                    (regenerate)
    //   package.json                (outside)
    //   tooling/sync-with-public.sh (exclude - must be hidden)
    //   Does NOT touch packages/cli/a.ts (so drift must not surface).
    writeFileSync(join(seed, 'tooling/workspace.gitconfig'), 'modified\n');
    writeFileSync(join(seed, 'bun.lock'), 'upstream-lock v1\n');
    writeFileSync(join(seed, 'package.json'), '{"name":"upstream","version":"1.0.0"}\n');
    writeFileSync(join(seed, 'tooling/sync-with-public.sh'), '#!/bin/sh\nsync_stuff\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'feat: review + regen + outside (no sync)');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    return {
      sourceSha: git(seed, 'rev-parse', 'HEAD'),
      driftedPath: 'packages/cli/a.ts',
    };
  }

  test('T1 REGRESSION: drifted-but-not-touched paths do NOT appear in mirror diff', async () => {
    const { sourceSha, driftedPath } = pushMixedPartialWithDrift();
    await mirrorPull({ remote: 'upstream' });

    const marker = getReviewPending();
    expect(marker?.sourceSha).toBe(sourceSha);
    // Sanity: the source commit did NOT touch the drifted path.
    expect(marker?.included).not.toContain(driftedPath);
    expect(marker?.review).not.toContain(driftedPath);
    expect(marker?.regenerate).not.toContain(driftedPath);
    expect(marker?.outside).not.toContain(driftedPath);

    // Compute the filtered pathspec the subcommand would use.
    const pathspec = computeDiffPathspec(marker!);
    // Drifted path is NOT in the filter.
    expect(pathspec).not.toContain(driftedPath);

    // Running `git diff HEAD <sourceSha> -- <filtered paths>` produces
    // output that contains review + regenerate + outside content, and does
    // NOT contain the drifted path.
    const diffOut = git(local, 'diff', 'HEAD', sourceSha, '--', ...pathspec);
    expect(diffOut).toContain('tooling/workspace.gitconfig');
    expect(diffOut).toContain('bun.lock');
    expect(diffOut).toContain('package.json');
    // Critical assertion: drifted path must NOT appear.
    expect(diffOut).not.toContain(driftedPath);
    // Excluded path must NOT appear (not in any bucket by construction).
    expect(diffOut).not.toContain('sync-with-public.sh');
  });

  test('T2: --raw bypasses the filter (includes drifted paths)', async () => {
    const { sourceSha, driftedPath } = pushMixedPartialWithDrift();
    await mirrorPull({ remote: 'upstream' });

    // Unfiltered diff - everything that differs between HEAD and source.
    // This mode is explicitly for debugging / seeing the full picture.
    const rawDiff = git(local, 'diff', 'HEAD', sourceSha);
    expect(rawDiff).toContain(driftedPath); // drift is visible in raw mode
    expect(rawDiff).toContain('package.json');
  });

  test('classification-sanity: review/regenerate/outside buckets as expected', async () => {
    const { sourceSha } = pushMixedPartialWithDrift();
    await mirrorPull({ remote: 'upstream' });

    const marker = getReviewPending();
    expect(marker?.sourceSha).toBe(sourceSha);
    expect(marker?.review).toEqual(['tooling/workspace.gitconfig']);
    expect(marker?.regenerate).toEqual(['bun.lock']);
    expect(marker?.outside).toEqual(['package.json']);
    // tooling/sync-with-public.sh is in excludePaths, so it's dropped
    // at classify-time and appears in no bucket.
    expect(marker?.included).not.toContain('tooling/sync-with-public.sh');
    expect(marker?.review).not.toContain('tooling/sync-with-public.sh');
    expect(marker?.regenerate).not.toContain('tooling/sync-with-public.sh');
    expect(marker?.outside).not.toContain('tooling/sync-with-public.sh');
  });

  test('mirrorDiff() returns 1 when no pause is active', () => {
    const code = mirrorDiff(undefined);
    expect(code).toBe(1);
  });

  test('mirrorSource() returns 1 when no pause is active', () => {
    const code = mirrorSource(undefined);
    expect(code).toBe(1);
  });

  test('mirrorDiff() returns 0 when a pause IS active (with default remote resolution)', async () => {
    pushMixedPartialWithDrift();
    await mirrorPull({ remote: 'upstream' });
    // No remote arg - should resolve to the pause's remote automatically.
    const code = mirrorDiff(undefined);
    expect(code).toBe(0);
  });

  test('mirrorDiff() errors on a mismatched explicit remote name', async () => {
    pushMixedPartialWithDrift();
    await mirrorPull({ remote: 'upstream' });
    const code = mirrorDiff('wrong-remote-name');
    expect(code).toBe(1);
  });

  test('mirrorDiff() accepts an explicit matching remote arg (for scripting)', async () => {
    pushMixedPartialWithDrift();
    await mirrorPull({ remote: 'upstream' });
    const code = mirrorDiff('upstream');
    expect(code).toBe(0);
  });
});
