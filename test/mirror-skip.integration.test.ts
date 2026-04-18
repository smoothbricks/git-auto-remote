import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirrorPull } from '../src/commands/mirror-pull.js';
import { mirrorSkip } from '../src/commands/mirror-skip.js';
import { installHook } from '../src/lib/hooks.js';
import { setReviewPending, trackingRefName } from '../src/lib/mirror-state.js';

/**
 * End-to-end tests for `mirror skip`. Scenarios focus on v0.6.3 defect A:
 * every pause-skip path must EXPLICITLY advance the tracking ref past the
 * source SHA, not rely on prior state (which is vulnerable to fetch clobber,
 * manual `git update-ref`, etc.).
 *
 * Setup mirrors test/mirror-pull.integration.test.ts (same upstream/local
 * bare pair with disjoint histories, packages/* synced).
 */

const TRACKING_UPSTREAM = trackingRefName('upstream');

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
  root = mkdtempSync(join(tmpdir(), 'gar-mirror-skip-int-'));
  upstream = join(root, 'upstream.git');
  local = join(root, 'local');

  git(root, 'init', '--bare', '-q', upstream);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', seed);
  commit(seed, 'packages/cli/a.ts', 'pkg A v1\n', 'pkg: add A');
  commit(seed, 'packages/cli/b.ts', 'pkg B v1\n', 'pkg: add B');
  // A shared review-path baseline so source commits that modify it are
  // true "modifications" (not additions) and classify into sub-case B/C
  // correctly via --3way.
  mkdirSync(join(seed, 'tooling'), { recursive: true });
  writeFileSync(join(seed, 'tooling/reviewed.conf'), 'v0\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed: reviewed.conf');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', upstream);
  git(seed, 'push', '-q', 'origin', 'main');

  git(root, 'init', '-q', local);
  commit(local, 'packages/cli/a.ts', 'pkg A v1\n', 'private: import A');
  commit(local, 'packages/cli/b.ts', 'pkg B v1\n', 'private: import B');
  // Mirror the review baseline so it's a modification, not an add, on the
  // source commit.
  mkdirSync(join(local, 'tooling'), { recursive: true });
  writeFileSync(join(local, 'tooling/reviewed.conf'), 'v0\n');
  git(local, 'add', '-A');
  git(local, 'commit', '-q', '-m', 'private: seed reviewed.conf');
  git(local, 'branch', '-M', 'private');

  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'fetch', '-q', 'upstream');

  git(local, 'config', 'auto-remote.upstream.syncPaths', 'packages');
  git(local, 'config', 'auto-remote.upstream.reviewPaths', 'tooling/reviewed.conf');
  git(local, 'config', 'auto-remote.upstream.syncTargetBranch', 'private');
  git(local, 'config', 'auto-remote.upstream.syncBranch', 'main');
  git(local, 'config', 'auto-remote.upstream.pushSyncRef', 'false');

  const upstreamTip = git(local, 'rev-parse', 'upstream/main');
  git(local, 'update-ref', TRACKING_UPSTREAM, upstreamTip);

  process.chdir(local);
  installHook('post-applypatch');
  installHook('post-merge');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('mirror skip: v0.6.3 defect A - every pause-skip path must explicitly advance tracking', () => {
  describe('review-pause (sub-case B): included + review', () => {
    /**
     * Build a partial commit that touches both `packages/*` (included) and
     * `tooling/reviewed.conf` (review). `mirror pull` applies included via
     * `git am`, overlays review unstaged, and sets phase 'review-pause'.
     */
    function setupReviewPausePartial(): string {
      const seed = join(root, 'seed');
      writeFileSync(join(seed, 'packages/cli/a.ts'), 'pkg A v2\n');
      writeFileSync(join(seed, 'tooling/reviewed.conf'), 'v1\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-q', '-m', 'feat: bump A + review tweak');
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
      return git(local, 'rev-parse', 'upstream/main');
    }

    test('skip explicitly advances tracking even when tracking ref was deleted after pause', async () => {
      const sourceSha = setupReviewPausePartial();

      // Enter pause.
      const pullCode = await mirrorPull({ remote: 'upstream' });
      expect(pullCode).toBe(0);

      // Sanity: pause marker present, HEAD has the partial commit, tracking
      // was advanced by the successful `git am` to sourceSha.
      expect(git(local, 'rev-parse', TRACKING_UPSTREAM)).toBe(sourceSha);

      // Simulate external perturbation: DELETE the tracking ref outright
      // between the pull and the skip. Pre-v0.6.3, skip assumed the ref was
      // still at sourceSha and did not re-assert it, so the next pull would
      // re-encounter this same commit forever.
      git(local, 'update-ref', '-d', TRACKING_UPSTREAM);
      expect(
        spawnSync('git', ['-C', local, 'rev-parse', '--verify', '--quiet', TRACKING_UPSTREAM], {
          stdio: 'pipe',
        }).status,
      ).not.toBe(0);

      // Skip. It must re-assert tracking at sourceSha.
      const skipCode = await mirrorSkip('upstream');
      expect(skipCode).toBe(0);

      // Assertion: tracking ref EXISTS and equals sourceSha.
      expect(git(local, 'rev-parse', TRACKING_UPSTREAM)).toBe(sourceSha);

      // HEAD should be back at the scaffold (the partial commit was dropped
      // by `reset --hard HEAD~1`).
      const headSubjects = git(local, 'log', '--format=%s', '-3').split('\n');
      expect(headSubjects).not.toContain('feat: bump A + review tweak');
    });
  });

  describe('pure-review-pause (sub-case C): review only, no included', () => {
    /**
     * Source commit touches ONLY `tooling/reviewed.conf` (review) - nothing
     * in packages/. `mirror pull` classifies as partial with included=[], so
     * applyPartial routes to handlePureReview which sets
     * phase 'pure-review-pause' and eagerly advances tracking to the source.
     */
    function setupPureReviewPausePartial(): string {
      const seed = join(root, 'seed');
      writeFileSync(join(seed, 'tooling/reviewed.conf'), 'v1\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-q', '-m', 'chore: bump reviewed.conf');
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
      return git(local, 'rev-parse', 'upstream/main');
    }

    test('skip explicitly advances tracking even when tracking ref was deleted after pause', async () => {
      const sourceSha = setupPureReviewPausePartial();

      const pullCode = await mirrorPull({ remote: 'upstream' });
      expect(pullCode).toBe(0);

      // Sanity: pause marker present, tracking was eagerly advanced.
      expect(git(local, 'rev-parse', TRACKING_UPSTREAM)).toBe(sourceSha);

      // External perturbation: delete tracking ref.
      git(local, 'update-ref', '-d', TRACKING_UPSTREAM);

      const skipCode = await mirrorSkip('upstream');
      expect(skipCode).toBe(0);

      // Must be re-asserted.
      expect(git(local, 'rev-parse', TRACKING_UPSTREAM)).toBe(sourceSha);
    });
  });

  describe('review-pause skip is immune to fetch-refspec clobber on resume', () => {
    /**
     * Critical defense-in-depth case: skip's post-reset auto-resume calls
     * `mirrorPull`, which fetches. If the user has a misconfigured
     *   +refs/git-auto-remote/mirror/*:refs/git-auto-remote/mirror/*
     * fetch refspec AND the bare upstream has an older value at that ref,
     * pre-v0.6.3 the resume's fetch force-overwrote local tracking back to
     * the older SHA, causing the just-skipped commit to re-appear.
     *
     * v0.6.3: skip explicitly advances tracking past sourceSha BEFORE the
     * resume fetch runs, AND mirror-pull's fetch uses an explicit narrow
     * refspec that ignores user-configured refspecs for this path. Either
     * fix alone is insufficient against all perturbations; both together
     * give full immunity.
     */
    test('tracking ref stays at source SHA despite misconfigured +refs/.../mirror/* refspec', async () => {
      const seed = join(root, 'seed');
      writeFileSync(join(seed, 'packages/cli/a.ts'), 'pkg A v2\n');
      writeFileSync(join(seed, 'tooling/reviewed.conf'), 'v1\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-q', '-m', 'feat: bump A + review tweak');
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
      const sourceSha = git(local, 'rev-parse', 'upstream/main');

      // Pause on review.
      await mirrorPull({ remote: 'upstream' });
      expect(git(local, 'rev-parse', TRACKING_UPSTREAM)).toBe(sourceSha);

      // Install the misconfigured fetch refspec that pre-v0.6.1 used to
      // auto-add. Bare upstream's tracking ref points at an OLDER SHA
      // (simulating another clone that's behind us) so if the resume's
      // fetch honored this refspec, it would force-overwrite our tracking
      // back to the older SHA.
      const olderSha = git(local, 'rev-parse', 'upstream/main~0^'); // parent
      git(upstream, 'update-ref', TRACKING_UPSTREAM, olderSha);
      git(
        local,
        'config',
        '--add',
        'remote.upstream.fetch',
        '+refs/git-auto-remote/mirror/*:refs/git-auto-remote/mirror/*',
      );

      // Run skip. It resets HEAD, advances tracking past sourceSha
      // (explicit, not reliant on prior state), and auto-resumes pull.
      // The resume's fetch must NOT clobber tracking back to olderSha.
      const skipCode = await mirrorSkip('upstream');
      expect(skipCode).toBe(0);

      // Assertion 1: tracking ends at sourceSha, NOT olderSha.
      expect(git(local, 'rev-parse', TRACKING_UPSTREAM)).toBe(sourceSha);

      // Assertion 2: the range tracking..HEAD does NOT include sourceSha's
      // subject - the skipped commit must not re-appear in HEAD.
      const headSubjects = git(local, 'log', '--format=%s', '-5').split('\n');
      expect(headSubjects).not.toContain('feat: bump A + review tweak');
    });
  });

  describe('phase-mismatch safety (HIGH-2): am-in-progress marker with mismatched HEAD', () => {
    /**
     * v0.7.0 HIGH-2: If the marker says 'am-in-progress' but no git am is running,
     * the fallback path resets HEAD~1. If the user manually created a commit
     * between the original pause and invoking skip, this would silently drop
     * the user's work. The fix: verify HEAD's commit subject/SHA matches what
     * the marker expected before resetting.
     *
     * T2-MSKIP-01: Set 'am-in-progress' marker manually; create a commit on top
     * of HEAD that's UNRELATED to the source SHA the marker references. Run
     * `mirror skip`. Assert: refuses with explanatory error; does NOT reset HEAD~1.
     */
    test('refuses to reset when HEAD commit does not match marker sourceSha (T2-MSKIP-01)', async () => {
      // Record HEAD before we start - this is the commit that should survive
      const originalHead = git(local, 'rev-parse', 'HEAD');

      // Create a fake marker with 'am-in-progress' phase that references a
      // non-existent sourceSha (simulating the case where the user manually
      // committed something after the original am was interrupted)
      const fakeSourceSha = '0000000000000000000000000000000000000000';
      const fakeSubject = 'fake: commit that never existed';
      setReviewPending({
        remote: 'upstream',
        sourceSha: fakeSourceSha,
        subject: fakeSubject,
        included: ['packages/cli/a.ts'],
        review: [],
        regenerate: [],
        outside: [],
        phase: 'am-in-progress',
      });

      // Create a NEW user commit on top of HEAD - this simulates the user
      // manually doing work after the original am was interrupted
      writeFileSync(join(local, 'user-work.txt'), 'user work content\n');
      git(local, 'add', '-A');
      git(local, 'commit', '-q', '-m', 'user: manual work after am interrupted');
      const userCommitSha = git(local, 'rev-parse', 'HEAD');

      // Verify: HEAD is now the user commit (not the fakeSourceSha)
      expect(userCommitSha).not.toBe(originalHead);

      // Call mirror skip - it should REFUSE because HEAD doesn't match the marker
      const skipCode = await mirrorSkip('upstream');

      // v0.7.0 HIGH-2: skip should detect the mismatch and refuse
      expect(skipCode).toBe(1);

      // CRITICAL: HEAD should still be the user's commit, not reset
      const headAfterSkip = git(local, 'rev-parse', 'HEAD');
      expect(headAfterSkip).toBe(userCommitSha);

      // Verify the user's commit message is still in the log
      const headSubject = git(local, 'log', '-1', '--format=%s', 'HEAD');
      expect(headSubject).toBe('user: manual work after am interrupted');
    });

    /**
     * T2-MSKIP-02: Verify baseline silently does `git reset --hard HEAD~1`,
     * dropping user's commit. This test demonstrates the bug - if the marker
     * sourceSha MATCHES HEAD's parent, the old code would reset and lose the
     * user's commit. After the fix, this should still fail with an error
     * because HEAD itself doesn't match.
     */
    test('baseline verification: user commit would be lost without safety check (T2-MSKIP-02)', async () => {
      // First, create a commit that LOOKS like it could be from a mirror operation
      // (we'll pretend this was the original am-in-progress commit)
      writeFileSync(join(local, 'mirror-content.txt'), 'original mirror content\n');
      git(local, 'add', '-A');
      git(local, 'commit', '-q', '-m', 'feat: original mirror commit');
      const mirrorCommitSha = git(local, 'rev-parse', 'HEAD');

      // Now create a marker that references this commit as the sourceSha
      setReviewPending({
        remote: 'upstream',
        sourceSha: mirrorCommitSha, // marker says this commit was from the mirror
        subject: 'feat: original mirror commit',
        included: ['mirror-content.txt'],
        review: [],
        regenerate: [],
        outside: [],
        phase: 'am-in-progress',
      });

      // The user then creates ANOTHER commit on top
      writeFileSync(join(local, 'user-work.txt'), 'user work content\n');
      git(local, 'add', '-A');
      git(local, 'commit', '-q', '-m', 'user: additional work');
      const userCommitSha = git(local, 'rev-parse', 'HEAD');

      // Verify we have the user commit on top of the mirror commit
      const parentSha = git(local, 'rev-parse', 'HEAD~1');
      expect(parentSha).toBe(mirrorCommitSha);

      // Call mirror skip - with the fix, it should still REFUSE because HEAD
      // doesn't match the marker's sourceSha (even though HEAD~1 does)
      const skipCode = await mirrorSkip('upstream');

      // With v0.7.0 HIGH-2 fix: refuse because HEAD itself doesn't match
      expect(skipCode).toBe(1);

      // Verify: HEAD should still be the user's commit (not reset to mirror commit)
      const headAfterSkip = git(local, 'rev-parse', 'HEAD');
      expect(headAfterSkip).toBe(userCommitSha);
    });
  });
});
