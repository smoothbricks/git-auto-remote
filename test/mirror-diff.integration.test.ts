import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDiffPathspec, mirrorDiff } from '../src/commands/mirror-diff.js';
import { mirrorPull } from '../src/commands/mirror-pull.js';
import { mirrorSource } from '../src/commands/mirror-source.js';
import { installHook } from '../src/lib/hooks.js';
import { getReviewPending, setReviewPending, trackingRefName } from '../src/lib/mirror-state.js';

/**
 * Coverage for the `mirror diff` and `mirror source` subcommands plus
 * `computeDiffPathspec`.
 *
 * v0.5.7 INVARIANT: `mirror diff` shows ONLY paths in this source commit's
 * `review` bucket. The `regenerate` and `outside` buckets are explicitly
 * excluded:
 *
 *   - regenerate paths (e.g. bun.lock) ALWAYS drift against source by design
 *     because we regenerate them locally from our own inputs. Surfacing that
 *     drift in `mirror diff` is noise - it doesn't represent a decision the
 *     user needs to make.
 *   - outside paths are outside the sync scope (not in syncPaths AND not in
 *     reviewPaths AND not in regeneratePaths). By definition we do not
 *     synchronise these from source. Showing their diff in `mirror diff` is
 *     strictly wrong - it suggests the tool might do something with them.
 *     User would see file lists like `package.json`, `privpkgs/*.json` in
 *     narrow-syncPaths repos and reasonably wonder why.
 *
 * Prior history:
 *   v0.5.5: pathspec was `syncPaths ∪ reviewPaths ∪ regeneratePaths` (config
 *           lists), leaking unrelated drift from prior commits into every
 *           diff.
 *   v0.5.6: narrowed to THIS commit's `review ∪ regenerate ∪ outside`
 *           buckets - fixed the unrelated-drift leak but STILL surfaced
 *           outside and regenerate noise.
 *   v0.5.7: narrowed to THIS commit's `review` bucket only (this file).
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

describe('computeDiffPathspec (pure function) - v0.5.7 review-only invariant', () => {
  test('returns ONLY review paths (regenerate and outside are excluded)', () => {
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
    // Only review content is informative drift that warrants human attention.
    expect(result).toEqual(['tooling/workspace.gitconfig']);
    // regenerate paths always drift by construction (we regen them locally).
    expect(result).not.toContain('bun.lock');
    // outside paths are outside the sync scope - we do not sync them, so
    // their diff has no meaning to the mirror workflow.
    expect(result).not.toContain('package.json');
    expect(result).not.toContain('privpkgs/secret.ts');
    // `included` paths MUST NOT be in the filter - they landed in HEAD
    // via `git am`, their diff against source is empty.
    expect(result).not.toContain('packages/cli/a.ts');
  });

  test('empty review bucket produces an empty pathspec (signals no-drift case)', () => {
    const result = computeDiffPathspec({
      remote: 'upstream',
      sourceSha: 'abc',
      subject: 'x',
      included: ['packages/cli/a.ts'],
      review: [],
      regenerate: ['bun.lock'],
      outside: ['package.json'],
      phase: 'review-pause',
    });
    // Despite non-empty regenerate/outside, no review paths = no review
    // drift for the user to audit. `mirrorDiff` must treat [] as a signal
    // to print "No review drift" rather than running an unfiltered diff.
    expect(result).toEqual([]);
  });

  test('all buckets empty also produces empty pathspec', () => {
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

  test('multiple review paths are all included, in original order', () => {
    const result = computeDiffPathspec({
      remote: 'upstream',
      sourceSha: 'abc',
      subject: 'x',
      included: [],
      review: ['a.tsx', 'b.tsx', 'nested/c.tsx'],
      regenerate: ['bun.lock'],
      outside: ['package.json'],
      phase: 'review-pause',
    });
    expect(result).toEqual(['a.tsx', 'b.tsx', 'nested/c.tsx']);
  });
});

describe('mirror diff integration - v0.5.7 review-only invariant', () => {
  /**
   * Push a mixed partial with review + regenerate + outside content, AND
   * introduce drift on a packages/ path NOT touched by this commit (to
   * prove the pathspec filter is commit-scoped, not config-scoped).
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
    // upcoming source commit. Earlier (v0.5.5) code would surface this as
    // noise when 'packages' appeared as a syncPath in the pathspec.
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

  test('T1 REGRESSION: review path DOES appear; outside/regenerate/drifted paths do NOT', async () => {
    const { sourceSha, driftedPath } = pushMixedPartialWithDrift();
    await mirrorPull({ remote: 'upstream' });

    const marker = getReviewPending();
    expect(marker?.sourceSha).toBe(sourceSha);

    // Classification sanity: each bucket has the expected content.
    expect(marker?.review).toEqual(['tooling/workspace.gitconfig']);
    expect(marker?.regenerate).toEqual(['bun.lock']);
    expect(marker?.outside).toEqual(['package.json']);

    // Compute the filtered pathspec the subcommand would use.
    const pathspec = computeDiffPathspec(marker!);
    // Only review paths in the filter.
    expect(pathspec).toEqual(['tooling/workspace.gitconfig']);
    // Regenerate/outside/drifted paths are NOT in the filter.
    expect(pathspec).not.toContain('bun.lock');
    expect(pathspec).not.toContain('package.json');
    expect(pathspec).not.toContain(driftedPath);

    // Running `git diff HEAD <sourceSha> -- <filtered paths>` produces
    // output that contains ONLY review drift.
    const diffOut = git(local, 'diff', 'HEAD', sourceSha, '--', ...pathspec);
    expect(diffOut).toContain('tooling/workspace.gitconfig');
    // Critical assertions - none of these noise paths must appear.
    expect(diffOut).not.toContain('bun.lock');
    expect(diffOut).not.toContain('package.json');
    expect(diffOut).not.toContain(driftedPath);
    expect(diffOut).not.toContain('sync-with-public.sh');
  });

  test('T2: --raw bypasses the filter (includes everything that differs)', async () => {
    const { sourceSha, driftedPath } = pushMixedPartialWithDrift();
    await mirrorPull({ remote: 'upstream' });

    // Unfiltered diff - everything that differs between HEAD and source.
    // This mode is explicitly for debugging / seeing the full picture.
    const rawDiff = git(local, 'diff', 'HEAD', sourceSha);
    expect(rawDiff).toContain(driftedPath); // drift is visible in raw mode
    expect(rawDiff).toContain('package.json'); // outside visible in raw mode
    expect(rawDiff).toContain('bun.lock'); // regenerate visible in raw mode
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

  /**
   * The EXACT scenario from the Conloca v0.5.6 bug report:
   *
   *   $ bunx git-auto-remote@0.5.6 mirror diff --stat
   *    bun.lock                                | 2996 +++---...
   *    package.json                            |   95 ++++--
   *    privpkgs/example/package.json           |   86 +++++
   *    privpkgs/tldraw-app/package.json        |  122 +++++++
   *    privpkgs/vite-plugin-ligma/package.json |   51 +++
   *
   * None of these should appear: bun.lock is regenerate, package.json and
   * privpkgs/* are outside. The review bucket is [] - correct output is
   * "No review drift for this commit." and stdout MUST NOT contain any of
   * the above file names.
   *
   * NOTE (v0.5.9+): sub-case B and sub-case C empty-review partials now
   * auto-apply without writing a review-pending marker, so this state is
   * no longer reachable through normal `mirrorPull` flow. The test
   * synthesizes the marker directly via `setReviewPending` to lock in the
   * DEFENSIVE behavior of `mirrorDiff`: if an empty-review marker somehow
   * exists (corruption, external tooling, future bug), `mirror diff` must
   * NOT fall through to `git diff HEAD <sha>` with no pathspec (the
   * original v0.5.6 bug which diffed everything).
   */
  test('T3 REGRESSION (Conloca bug): mirror diff with synthesized empty-review marker prints no-drift message, not everything-diff', () => {
    // Synthesize a pause marker with review=[] directly. We don't need a
    // real upstream commit - `mirror diff` only uses the marker's bucket
    // arrays to decide the pathspec. The sourceSha just has to exist for
    // potential `git diff HEAD <sha>` fallthrough (which we're asserting
    // does NOT happen).
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'any source commit');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    const sourceSha = git(local, 'rev-parse', 'upstream/main');

    setReviewPending({
      remote: 'upstream',
      sourceSha,
      subject: 'Update dependencies and improve type safety',
      included: [],
      review: [], // THE defensive case: empty review
      regenerate: ['bun.lock'],
      outside: [
        'package.json',
        'privpkgs/example/package.json',
        'privpkgs/tldraw-app/package.json',
        'privpkgs/vite-plugin-ligma/package.json',
      ],
      phase: 'review-pause',
    });

    // Capture console.log (see earlier tests for rationale).
    const originalLog = console.log;
    let captured = '';
    console.log = (...args: unknown[]): void => {
      captured += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
    };
    let code: number;
    try {
      code = mirrorDiff(undefined, ['--stat']);
    } finally {
      console.log = originalLog;
    }

    expect(code).toBe(0);
    // None of the noise paths must appear.
    expect(captured).not.toContain('bun.lock');
    expect(captured).not.toContain('package.json');
    expect(captured).not.toContain('privpkgs/');
    // The no-drift message must appear.
    expect(captured).toContain('No review drift for this commit.');
  });

  test('mirrorDiff() prints "No review drift" and exits 0 when review bucket is empty (defensive)', () => {
    // See T3 note: this state is not reachable via normal mirrorPull flow
    // after v0.5.9, but the defensive branch in mirrorDiff is worth locking
    // in. Synthesize the marker directly.
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'bump deps');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    const sourceSha = git(local, 'rev-parse', 'upstream/main');

    setReviewPending({
      remote: 'upstream',
      sourceSha,
      subject: 'bump deps',
      included: [],
      review: [],
      regenerate: ['bun.lock'],
      outside: ['package.json'],
      phase: 'review-pause',
    });

    const originalLog = console.log;
    let captured = '';
    console.log = (...args: unknown[]): void => {
      captured += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
    };
    let code: number;
    try {
      code = mirrorDiff(undefined, ['--stat']);
    } finally {
      console.log = originalLog;
    }

    expect(code).toBe(0);
    expect(captured).toContain('No review drift for this commit.');
    expect(captured).not.toContain('bun.lock');
    expect(captured).not.toContain('package.json');
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

  /**
   * T2-MDIFF-01: garbage-sourceSha detection (MEDIUM-1 part 1)
   * When sourceSha is missing from object DB (post-GC or force-push),
   * mirror diff should emit a tool-authored error rather than raw
   * `fatal: bad object` from git.
   */
  test('mirror diff emits tool-authored error when sourceSha is missing from object DB', () => {
    // Synthesize a marker pointing at a SHA that doesn't exist in the object DB.
    // This simulates post-GC or force-push scenarios where the commit is dropped.
    const garbageSha = 'deadbeef' + '0'.repeat(32); // 40-char hex SHA that doesn't exist

    setReviewPending({
      remote: 'upstream',
      sourceSha: garbageSha,
      subject: 'Some commit that got GC-ed',
      included: ['packages/cli/a.ts'],
      review: ['tooling/workspace.gitconfig'],
      regenerate: [],
      outside: [],
      phase: 'review-pause',
    });

    // Capture stderr to verify tool-authored error (not raw git error).
    const originalError = console.error;
    let captured = '';
    console.error = (...args: unknown[]): void => {
      captured += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
    };
    let code: number;
    try {
      code = mirrorDiff(undefined);
    } finally {
      console.error = originalError;
    }

    expect(code).toBe(1);
    // Must emit tool-authored error, NOT raw `fatal: bad object` from git.
    expect(captured).toContain('[git-auto-remote]');
    expect(captured).toContain('not in object DB');
    expect(captured).toContain('post-GC or upstream force-push');
    expect(captured).toContain(garbageSha.slice(0, 8));
    // Must NOT contain raw git error.
    expect(captured).not.toContain('fatal: bad object');
  });
});

// T2-MSRC-01: garbage-sourceSha detection for mirror source
// MEDIUM-1 (see 2026-04-18-audit.md): mirror source should detect garbage sourceSha
describe('mirror source garbage-sourceSha detection (MEDIUM-1)', () => {
  test('mirror source emits tool-authored error when sourceSha is missing from object DB', () => {
    // Synthesize a marker pointing at a SHA that doesn't exist in the object DB.
    // This simulates post-GC or force-push scenarios where the commit is gone.
    const garbageSha = '1234567890abcdef1234567890abcdef12345678';

    setReviewPending({
      remote: 'upstream',
      sourceSha: garbageSha,
      subject: 'Some commit that was GCed',
      included: [],
      review: ['packages/cli/a.ts'],
      regenerate: [],
      outside: [],
      phase: 'review-pause',
    });

    // Capture stderr to verify tool-authored error, not raw git error
    const originalStderr = console.error;
    let capturedStderr = '';
    console.error = (...args: unknown[]): void => {
      capturedStderr += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
    };

    let code: number;
    try {
      code = mirrorSource(undefined);
    } finally {
      console.error = originalStderr;
    }

    expect(code).toBe(1);
    // Must emit the tool-authored error message, not raw git "fatal: bad object"
    expect(capturedStderr).toContain('[git-auto-remote] Source commit 12345678 not in object DB');
    expect(capturedStderr).toContain('post-GC or upstream force-push');
    expect(capturedStderr).toContain("Re-fetch upstream or run 'mirror skip' to drop this pause");
    expect(capturedStderr).not.toContain('fatal: bad object');
  });
});

// T2-MSRC-01: garbage-sourceSha detection for mirror source
// MEDIUM-1 (see 2026-04-18-audit.md): mirror source should detect garbage sourceSha
describe('mirror source garbage-sourceSha detection (MEDIUM-1)', () => {
  test('mirror source emits tool-authored error when sourceSha is missing from object DB', () => {
    // Synthesize a marker pointing at a SHA that doesn't exist in the object DB.
    // This simulates post-GC or force-push scenarios where the commit is gone.
    const garbageSha = '1234567890abcdef1234567890abcdef12345678';

    setReviewPending({
      remote: 'upstream',
      sourceSha: garbageSha,
      subject: 'Some commit that was GCed',
      included: [],
      review: ['packages/cli/a.ts'],
      regenerate: [],
      outside: [],
      phase: 'review-pause',
    });

    // Capture stderr to verify tool-authored error, not raw git error
    const originalStderr = console.error;
    let capturedStderr = '';
    console.error = (...args: unknown[]): void => {
      capturedStderr += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
    };

    let code: number;
    try {
      code = mirrorSource(undefined);
    } finally {
      console.error = originalStderr;
    }

    expect(code).toBe(1);
    // Must emit the tool-authored error message, not raw git "fatal: bad object"
    expect(capturedStderr).toContain('[git-auto-remote] Source commit 12345678 not in object DB');
    expect(capturedStderr).toContain('post-GC or upstream force-push');
    expect(capturedStderr).toContain("Re-fetch upstream or run 'mirror skip' to drop this pause");
    expect(capturedStderr).not.toContain('fatal: bad object');
  });
});
