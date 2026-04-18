import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirrorContinue } from '../src/commands/mirror-continue.js';
import { mirrorPull } from '../src/commands/mirror-pull.js';
import { mirrorSkip } from '../src/commands/mirror-skip.js';
import { installHook } from '../src/lib/hooks.js';
import { trackingRefName } from '../src/lib/mirror-state.js';

/**
 * End-to-end coverage of the unified `mirror continue` / `mirror skip`
 * commands across all three pause sub-cases:
 *
 *   A. `git am` conflict (included-subset patch wouldn't apply cleanly)
 *   B. `review-pause` (included subset applied, review content in worktree)
 *   C. `pure-review-pause` (no included, only review content)
 *
 * Plus the author-date preservation guarantees those flows must uphold.
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
  root = mkdtempSync(join(tmpdir(), 'gar-resume-int-'));
  upstream = join(root, 'upstream.git');
  local = join(root, 'local');

  git(root, 'init', '--bare', '-q', upstream);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', seed);
  commit(seed, 'packages/cli/a.ts', 'v1 upstream\n', 'pkg: add A');
  // Add a second (non-root) commit so the bootstrap target isn't a root.
  // Root bootstraps semantically mean "replay EVERYTHING from the start";
  // these tests assume "replay starts AFTER what's tracked", which is only
  // the behaviour for non-root tracking refs. Tests specifically exercising
  // root-inclusive replay set tracking explicitly.
  commit(seed, '.dummy-non-root-marker', 'x\n', 'seed: post-root marker (out of syncPaths)');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', upstream);
  git(seed, 'push', '-q', 'origin', 'main');

  git(root, 'init', '-q', local);
  // Local starts with the SAME A content as upstream so only later conflicts
  // surface; tests that need a conflict override a.ts separately.
  commit(local, 'packages/cli/a.ts', 'v1 upstream\n', 'local: add A');
  git(local, 'branch', '-M', 'private');
  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'fetch', '-q', 'upstream');

  git(local, 'config', 'auto-remote.upstream.syncPaths', 'packages');
  git(local, 'config', 'auto-remote.upstream.syncTargetBranch', 'private');
  git(local, 'config', 'auto-remote.upstream.syncBranch', 'main');
  git(local, 'config', 'auto-remote.upstream.pushSyncRef', 'false');

  // Bootstrap tracking ref to upstream's post-root marker commit (NOT the
  // actual root), so `mirror pull` excludes it from the replay per standard
  // tracking semantics.
  git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));

  process.chdir(local);
  installHook('post-applypatch');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('sub-case A: git am conflict', () => {
  /** Force local to diverge from upstream's A, then push a new upstream A to conflict. */
  function pushUpstreamConflict(message = 'pkg: bump A to v2'): string {
    // Make local's copy of a.ts different so the incoming patch won't apply cleanly.
    writeFileSync(join(local, 'packages/cli/a.ts'), 'v1 local (different)\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-q', '-m', 'local: diverge A');

    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2 upstream\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', message);
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    return git(seed, 'rev-parse', 'HEAD');
  }

  describe('mirror skip during an am conflict', () => {
    test('drops the stuck patch and advances tracking ref past it', async () => {
      const conflictSha = pushUpstreamConflict();

      await mirrorPull({ remote: 'upstream' });
      expect(existsSync(join(local, '.git/rebase-apply'))).toBe(true);

      const code = await mirrorSkip('upstream');
      expect(code).toBe(0);

      expect(existsSync(join(local, '.git/rebase-apply'))).toBe(false);
      expect(git(local, 'rev-parse', TRACKING)).toBe(conflictSha);
      expect(existsSync(join(local, '.git/git-auto-remote/mirror-in-progress'))).toBe(false);
    });

    test('returns 1 when no pause or am is active', async () => {
      const code = await mirrorSkip('upstream');
      expect(code).toBe(1);
    });
  });

  describe('mirror continue during an am conflict', () => {
    test('resolves the conflict via the user-edited index and auto-advances', async () => {
      const conflictSha = pushUpstreamConflict();

      await mirrorPull({ remote: 'upstream' });
      expect(existsSync(join(local, '.git/rebase-apply'))).toBe(true);

      // User resolves by accepting upstream's version.
      writeFileSync(join(local, 'packages/cli/a.ts'), 'v2 upstream\n');
      git(local, 'add', 'packages/cli/a.ts');

      const code = await mirrorContinue('upstream');
      expect(code).toBe(0);

      expect(existsSync(join(local, '.git/rebase-apply'))).toBe(false);
      expect(git(local, 'rev-parse', TRACKING)).toBe(conflictSha);
      expect(existsSync(join(local, '.git/git-auto-remote/mirror-in-progress'))).toBe(false);
      const aContent = readFileSync(join(local, 'packages/cli/a.ts'), 'utf8');
      expect(aContent).toBe('v2 upstream\n');
    });

    test('returns 1 when no pause or am is active', async () => {
      const code = await mirrorContinue('upstream');
      expect(code).toBe(1);
    });
  });

  /**
   * Regression: when `git am` fails structurally BEFORE 3-way merge runs
   * (e.g. rename source or mode-change target not in HEAD), worktree stays
   * clean. The tool used to print "Resolve the conflicts, git add, then
   * mirror continue" which is misleading - there ARE no conflicts and
   * `git add` has nothing to stage. `mirror continue` would then fail with
   * "no changes - did you forget to use 'git add'?".
   *
   * Expected behaviour (v0.5.1+):
   *   - Pull emits a DIFFERENT message pointing at `mirror skip` / abort.
   *   - `mirror continue` on this state returns 1 with its own explanatory
   *     message (rather than trying git am --continue and spewing git's
   *     internal error).
   *   - `mirror skip` works as normal and advances the tracking ref.
   */
  describe('structural am failure (no conflict markers to resolve)', () => {
    /** Push a commit that renames a file which doesn't exist on local HEAD. */
    function pushRenameOfMissingFile(): string {
      const seed = join(root, 'seed');
      // Seed creates `packages/will-be-renamed.ts` then renames it. Since
      // local doesn't have that file, the rename patch's fake-ancestor build
      // fails structurally (not via 3-way conflict).
      writeFileSync(join(seed, 'packages/will-be-renamed.ts'), 'x\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-q', '-m', 'seed: add file to be renamed');
      git(seed, 'push', '-q', 'origin', 'main');

      // Rename the file in a subsequent commit.
      git(seed, 'mv', 'packages/will-be-renamed.ts', 'packages/renamed.ts');
      git(seed, 'commit', '-q', '-m', 'pkg: rename file');
      git(seed, 'push', '-q', 'origin', 'main');

      // Advance tracking past the 'seed: add file to be renamed' commit so the
      // tool thinks that commit is ALREADY synced (it isn't locally, which is
      // exactly the situation that produces the structural failure).
      git(local, 'fetch', '-q', 'upstream');
      const seedCommit = git(seed, 'rev-parse', 'HEAD~1');
      git(local, 'update-ref', TRACKING, seedCommit);
      return git(seed, 'rev-parse', 'HEAD');
    }

    test('pull stops with the structural-failure message; am is in progress but worktree clean', async () => {
      pushRenameOfMissingFile();

      const code = await mirrorPull({ remote: 'upstream' });
      // Pull returns 1 (error, not stopped-2), consistent with other am-stop cases.
      expect(code).toBe(1);
      // am IS in progress.
      expect(existsSync(join(local, '.git/rebase-apply'))).toBe(true);
      // Worktree is clean - no conflict markers to resolve.
      const status = git(local, 'status', '--porcelain');
      expect(status).toBe('');
    });

    test('mirror continue in this state returns 1 without invoking git am --continue', async () => {
      pushRenameOfMissingFile();
      await mirrorPull({ remote: 'upstream' });

      // User naively tries continue. With the v0.5.1 guard it short-circuits.
      const code = await mirrorContinue('upstream');
      expect(code).toBe(1);
      // am is still in progress (continue did not run git am --continue).
      expect(existsSync(join(local, '.git/rebase-apply'))).toBe(true);
    });

    test('mirror skip recovers cleanly', async () => {
      const renameSha = pushRenameOfMissingFile();
      await mirrorPull({ remote: 'upstream' });

      const code = await mirrorSkip('upstream');
      expect(code).toBe(0);
      expect(existsSync(join(local, '.git/rebase-apply'))).toBe(false);
      expect(git(local, 'rev-parse', TRACKING)).toBe(renameSha);
    });
  });

  /**
   * Regression (v0.5.2): `mirror continue` called with unresolved merge
   * conflicts (UU entries) should NOT invoke `git am --continue` - it would
   * fail with git's own terse error. Instead, short-circuit with a clear
   * pointer to the resolution workflow.
   */
  describe('mirror continue pre-check: unresolved merge conflicts', () => {
    function pushConflictingPatch(): string {
      // Diverge local + upstream on the same file so --3way leaves markers.
      writeFileSync(join(local, 'packages/cli/a.ts'), 'v1 local different\n');
      git(local, 'add', '-A');
      git(local, 'commit', '-q', '-m', 'local: diverge');

      const seed = join(root, 'seed');
      writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2 upstream\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-q', '-m', 'up: bump A');
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
      return git(seed, 'rev-parse', 'HEAD');
    }

    test('mirror continue returns 1 without invoking git am --continue when UU entries exist', async () => {
      pushConflictingPatch();
      await mirrorPull({ remote: 'upstream' });
      // UU entry must be present.
      const statusBefore = git(local, 'status', '--porcelain');
      expect(statusBefore).toMatch(/^UU /m);

      const code = await mirrorContinue('upstream');
      expect(code).toBe(1);
      // am is still in progress (continue short-circuited without running it).
      expect(existsSync(join(local, '.git/rebase-apply'))).toBe(true);
      // Still has the UU entry - continue didn't try anything.
      const statusAfter = git(local, 'status', '--porcelain');
      expect(statusAfter).toMatch(/^UU /m);
    });
  });
});

describe('sub-case B: review-pause (mixed partial)', () => {
  /** Seed packages/reviewed on both sides at v1, then push a mixed partial bumping it to v2. */
  function pushMixedPartial(): string {
    // Seed on local at v1.
    writeFileSync(join(local, 'packages/reviewed'), 'reviewed v1\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-q', '-m', 'local: seed reviewed');
    // Seed on upstream at v1.
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/reviewed'), 'reviewed v1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'upstream: seed reviewed');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));

    // The mixed partial on upstream.
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2 upstream\n');
    writeFileSync(join(seed, 'packages/reviewed'), 'reviewed v2\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'feat: bump A + reviewed');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    return git(seed, 'rev-parse', 'HEAD');
  }

  beforeEach(() => {
    // packages/reviewed is a reviewPath: stays OUT of HEAD, overlays to worktree unstaged.
    git(local, 'config', 'auto-remote.upstream.reviewPaths', 'packages/reviewed');
  });

  test('pause leaves HEAD with included only, review content in worktree unstaged', async () => {
    const sourceSha = pushMixedPartial();

    const code = await mirrorPull({ remote: 'upstream' });
    expect(code).toBe(0);

    // HEAD commit bumps a.ts...
    const aContent = readFileSync(join(local, 'packages/cli/a.ts'), 'utf8');
    expect(aContent).toBe('v2 upstream\n');
    // ...but NOT the reviewed bump (it stays at v1 in HEAD).
    const reviewedInHead = git(local, 'show', 'HEAD:packages/reviewed');
    expect(reviewedInHead).toBe('reviewed v1');
    // The WORKING TREE has the v2 content as unstaged changes.
    const reviewedWorktree = readFileSync(join(local, 'packages/reviewed'), 'utf8');
    expect(reviewedWorktree).toBe('reviewed v2\n');
    // Review-pending marker written with phase 'review-pause'.
    const markerPath = join(local, '.git/git-auto-remote/review-pending');
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    expect(marker.phase).toBe('review-pause');
    expect(marker.sourceSha).toBe(sourceSha);
    expect(marker.review).toEqual(['packages/reviewed']);
  });

  test('continue with staged review content amends HEAD preserving author + author-date', async () => {
    await pushMixedPartial();
    await mirrorPull({ remote: 'upstream' });

    const headSha = git(local, 'rev-parse', 'HEAD');
    const origAuthor = git(local, 'show', '-s', '--format=%an <%ae>', headSha);
    const origAuthorDate = git(local, 'show', '-s', '--format=%aI', headSha);

    git(local, 'add', 'packages/reviewed');

    const code = await mirrorContinue('upstream');
    expect(code).toBe(0);

    const newHead = git(local, 'rev-parse', 'HEAD');
    expect(newHead).not.toBe(headSha); // amended -> SHA changes

    // Author + author-date preserved by --amend --no-edit.
    expect(git(local, 'show', '-s', '--format=%an <%ae>', newHead)).toBe(origAuthor);
    expect(git(local, 'show', '-s', '--format=%aI', newHead)).toBe(origAuthorDate);

    // Amended commit contains both files.
    const files = git(local, 'show', '--name-only', '--format=', newHead).split('\n').filter(Boolean).sort();
    expect(files).toEqual(['packages/cli/a.ts', 'packages/reviewed'].sort());
    // Marker cleared.
    expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
  });

  test('continue WITHOUT staging discards unstaged review leftovers', async () => {
    await pushMixedPartial();
    await mirrorPull({ remote: 'upstream' });

    const headSha = git(local, 'rev-parse', 'HEAD');

    const code = await mirrorContinue('upstream');
    expect(code).toBe(0);

    // HEAD unchanged (no amend because nothing staged).
    expect(git(local, 'rev-parse', 'HEAD')).toBe(headSha);
    // Worktree restored to HEAD.
    expect(readFileSync(join(local, 'packages/reviewed'), 'utf8')).toBe('reviewed v1\n');
    expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
  });

  test('skip drops the partial commit entirely and discards worktree overlay', async () => {
    const sourceSha = pushMixedPartial();
    await mirrorPull({ remote: 'upstream' });
    const headAfterPause = git(local, 'rev-parse', 'HEAD');

    const code = await mirrorSkip('upstream');
    expect(code).toBe(0);

    // HEAD reset back to pre-partial state.
    expect(git(local, 'rev-parse', 'HEAD')).not.toBe(headAfterPause);
    // Worktree clean.
    expect(readFileSync(join(local, 'packages/reviewed'), 'utf8')).toBe('reviewed v1\n');
    // Tracking stays at sourceSha (skip doesn't rewind it).
    expect(git(local, 'rev-parse', TRACKING)).toBe(sourceSha);
    expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
  });
});

describe('sub-case C: pure-review-only commit', () => {
  /** Seed bun.lock v1 on both sides, then push a commit touching only bun.lock. */
  function pushPureReviewCommit(): string {
    writeFileSync(join(local, 'bun.lock'), 'locked v1\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-q', '-m', 'local: seed bun.lock');
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'bun.lock'), 'locked v1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'upstream: seed bun.lock');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));

    writeFileSync(join(seed, 'bun.lock'), 'locked v2\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'chore: bump bun.lock');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    return git(seed, 'rev-parse', 'HEAD');
  }

  beforeEach(() => {
    // bun.lock is a reviewPath and is NOT under syncPaths (packages).
    git(local, 'config', 'auto-remote.upstream.reviewPaths', 'bun.lock');
  });

  test('pause: HEAD unchanged, bun.lock in worktree unstaged, pending-commit recorded', async () => {
    const sourceSha = pushPureReviewCommit();
    const headBefore = git(local, 'rev-parse', 'HEAD');

    const code = await mirrorPull({ remote: 'upstream' });
    expect(code).toBe(0);

    // HEAD did NOT move (no included content).
    expect(git(local, 'rev-parse', 'HEAD')).toBe(headBefore);
    // Worktree has bun.lock v2.
    expect(readFileSync(join(local, 'bun.lock'), 'utf8')).toBe('locked v2\n');
    // Review-pending at phase 'pure-review-pause'.
    const marker = JSON.parse(readFileSync(join(local, '.git/git-auto-remote/review-pending'), 'utf8'));
    expect(marker.phase).toBe('pure-review-pause');
    expect(marker.included).toEqual([]);
    expect(marker.review).toEqual(['bun.lock']);
    // Pending-commit metadata written.
    const pending = JSON.parse(readFileSync(join(local, '.git/git-auto-remote/pending-commit'), 'utf8'));
    expect(pending.sourceSha).toBe(sourceSha);
    expect(pending.message).toBe('chore: bump bun.lock');
    expect(pending.authorName).toBe('Test');
    // Tracking ref advanced to source SHA at pause time.
    expect(git(local, 'rev-parse', TRACKING)).toBe(sourceSha);
  });

  test('continue with staged content creates a commit preserving author + author-date + message', async () => {
    const sourceSha = pushPureReviewCommit();
    const headBefore = git(local, 'rev-parse', 'HEAD');
    await mirrorPull({ remote: 'upstream' });

    const sourceAuthor = git(local, 'show', '-s', '--format=%an <%ae>', sourceSha);
    const sourceAuthorDate = git(local, 'show', '-s', '--format=%aI', sourceSha);
    const sourceMessage = git(local, 'show', '-s', '--format=%s', sourceSha);

    git(local, 'add', 'bun.lock');
    const code = await mirrorContinue('upstream');
    expect(code).toBe(0);

    const newHead = git(local, 'rev-parse', 'HEAD');
    expect(newHead).not.toBe(headBefore);
    expect(git(local, 'show', '-s', '--format=%an <%ae>', newHead)).toBe(sourceAuthor);
    expect(git(local, 'show', '-s', '--format=%aI', newHead)).toBe(sourceAuthorDate);
    expect(git(local, 'show', '-s', '--format=%s', newHead)).toBe(sourceMessage);
    // Markers cleared.
    expect(existsSync(join(local, '.git/git-auto-remote/pending-commit'))).toBe(false);
    expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
  });

  test('continue WITHOUT staging is a silent no-op commit-wise (Q2a)', async () => {
    await pushPureReviewCommit();
    const headBefore = git(local, 'rev-parse', 'HEAD');
    await mirrorPull({ remote: 'upstream' });

    const code = await mirrorContinue('upstream');
    expect(code).toBe(0);

    expect(git(local, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(readFileSync(join(local, 'bun.lock'), 'utf8')).toBe('locked v1\n');
    expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
    expect(existsSync(join(local, '.git/git-auto-remote/pending-commit'))).toBe(false);
  });

  test('skip discards worktree overlay and advances without committing', async () => {
    const sourceSha = pushPureReviewCommit();
    const headBefore = git(local, 'rev-parse', 'HEAD');
    await mirrorPull({ remote: 'upstream' });

    const code = await mirrorSkip('upstream');
    expect(code).toBe(0);

    expect(git(local, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(readFileSync(join(local, 'bun.lock'), 'utf8')).toBe('locked v1\n');
    expect(git(local, 'rev-parse', TRACKING)).toBe(sourceSha);
    expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
    expect(existsSync(join(local, '.git/git-auto-remote/pending-commit'))).toBe(false);
  });
});

/**
 * v0.5.4 critical regression: when the root commit of the mirror is itself a
 * partial (has review paths or outside-scope paths), resuming past it via
 * `mirror continue` must advance cleanly to subsequent commits. Pre-0.5.4
 * had a "prepend root on every pull iteration" hack that re-pre-pended the
 * root on every resume, causing an infinite loop.
 *
 * The scenario reproduces the real-world bug the user hit on Conloca:
 *   - Fresh local (no tracking ref)
 *   - Upstream's root commit touches a reviewPath AND an out-of-scope path
 *     AND syncPath content -> classified as partial
 *   - First `mirror pull` pauses on the root (sub-case B)
 *   - User stages + `mirror continue` -> amends HEAD
 *   - Second iteration (triggered by continue's tail-call to mirrorPull)
 *     must NOT re-try the root; must proceed to root's children instead.
 */
describe('v0.5.4: root-commit partial + resume does not loop', () => {
  let freshLocal: string;
  let rootSha: string;
  let secondSha: string;

  beforeEach(() => {
    // Upstream: add ANOTHER pre-existing commit series for a cleaner test.
    // pushing a brand new upstream with a root that's itself a partial:
    //   commit 1 (root):   packages/cli/a.ts + reviewPath + out-of-scope file
    //   commit 2:          simple child modifying packages/cli/a.ts
    const seed = join(root, 'seed');
    // beforeEach(main) already created a seed with root + post-root marker.
    // Add a commit that modifies a.ts (clean child of root).
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2 upstream\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'pkg: bump A');
    git(seed, 'push', '-q', 'origin', 'main');

    // Now make the root into a partial post-hoc: commit an additional commit
    // that touches a reviewPath AND an out-of-scope path. Root is already
    // the first commit; to keep things simple, we just treat the root itself
    // as sufficient (it touches only packages/cli/a.ts in current beforeEach,
    // which is clean). We want a ROOT that is a partial though.
    //
    // Simpler: make a BRAND NEW fresh-local scenario with a brand-new seed
    // whose root IS a partial. Avoids mucking with shared beforeEach setup.
    freshLocal = join(root, 'fresh-local-for-root-partial');
    const freshSeed = join(root, 'fresh-seed-for-root-partial');
    const freshUpstream = join(root, 'fresh-upstream-for-root-partial.git');
    git(root, 'init', '--bare', '-q', freshUpstream);
    git(root, 'init', '-q', freshSeed);
    // Root commit: has packages (in sync), reviewPath nx.json, and an
    // out-of-scope PRIVATE.md - makes it a partial.
    mkdirSync(join(freshSeed, 'packages/cli'), { recursive: true });
    writeFileSync(join(freshSeed, 'packages/cli/a.ts'), 'root v1\n');
    writeFileSync(join(freshSeed, 'nx.json'), '{"root": true}\n');
    writeFileSync(join(freshSeed, 'PRIVATE.md'), 'private scratch\n');
    git(freshSeed, 'add', '-A');
    git(freshSeed, 'commit', '-q', '-m', 'root: initial commit (partial)');
    rootSha = git(freshSeed, 'rev-parse', 'HEAD');
    // Child commit: clean, only touches packages/
    writeFileSync(join(freshSeed, 'packages/cli/a.ts'), 'root v1\n+ child line\n');
    git(freshSeed, 'add', '-A');
    git(freshSeed, 'commit', '-q', '-m', 'pkg: bump A');
    secondSha = git(freshSeed, 'rev-parse', 'HEAD');
    git(freshSeed, 'branch', '-M', 'main');
    git(freshSeed, 'remote', 'add', 'origin', freshUpstream);
    git(freshSeed, 'push', '-q', 'origin', 'main');

    git(root, 'init', '-q', freshLocal);
    writeFileSync(join(freshLocal, 'LOCAL_SCAFFOLD'), 'scaffold\n');
    git(freshLocal, 'add', '-A');
    git(freshLocal, 'commit', '-q', '-m', 'local: scaffold');
    git(freshLocal, 'branch', '-M', 'private');
    git(freshLocal, 'remote', 'add', 'upstream', freshUpstream);
    git(freshLocal, 'fetch', '-q', 'upstream');
    git(freshLocal, 'config', 'auto-remote.upstream.syncPaths', 'packages');
    git(freshLocal, 'config', 'auto-remote.upstream.reviewPaths', 'nx.json');
    git(freshLocal, 'config', 'auto-remote.upstream.syncTargetBranch', 'private');
    git(freshLocal, 'config', 'auto-remote.upstream.syncBranch', 'main');
    git(freshLocal, 'config', 'auto-remote.upstream.pushSyncRef', 'false');

    process.chdir(freshLocal);
    installHook('post-applypatch');
  });

  test('full flow: root-partial pauses, continue advances to child without looping on root', async () => {
    // First pull: enumerates [root, child]. Root is partial (has review
    // content + out-of-scope content), so replay pauses after landing the
    // included subset of the root.
    const code1 = await mirrorPull({ remote: 'upstream' });
    expect(code1).toBe(0);

    // HEAD should be the included-only subset of root (packages/cli/a.ts).
    expect(existsSync(join(freshLocal, 'packages/cli/a.ts'))).toBe(true);
    expect(readFileSync(join(freshLocal, 'packages/cli/a.ts'), 'utf8')).toBe('root v1\n');
    // nx.json was review -> in worktree as unstaged.
    expect(readFileSync(join(freshLocal, 'nx.json'), 'utf8')).toContain('"root": true');
    // PRIVATE.md was outside-scope -> NOT on HEAD, NOT in worktree.
    expect(existsSync(join(freshLocal, 'PRIVATE.md'))).toBe(false);
    // Pending review marker written.
    const marker = JSON.parse(readFileSync(join(freshLocal, '.git/git-auto-remote/review-pending'), 'utf8'));
    expect(marker.phase).toBe('review-pause');
    expect(marker.sourceSha).toBe(rootSha);

    // Tracking ref advanced to root SHA.
    expect(git(freshLocal, 'rev-parse', trackingRefName('upstream'))).toBe(rootSha);

    // User stages the review path + continues. continueReviewPause should
    // amend HEAD and tail-call mirrorPull. The BUG we're guarding against:
    // pre-0.5.4, mirrorPull would re-see tracking-at-root and try to replay
    // the root AGAIN (infinite loop).
    git(freshLocal, 'add', 'nx.json');
    const code2 = await mirrorContinue('upstream');
    expect(code2).toBe(0);

    // HEAD's previous commit (root-subset) has been amended to include
    // nx.json; then the child commit landed on top.
    const headSubjects = git(freshLocal, 'log', '--format=%s', '-n', '3').split('\n');
    expect(headSubjects).toEqual(['pkg: bump A', 'root: initial commit (partial)', 'local: scaffold']);

    // Tracking ref is now at the child commit (the latest applied).
    expect(git(freshLocal, 'rev-parse', trackingRefName('upstream'))).toBe(secondSha);

    // Child commit's content landed.
    expect(readFileSync(join(freshLocal, 'packages/cli/a.ts'), 'utf8')).toBe('root v1\n+ child line\n');

    // Review-pending marker cleared.
    expect(existsSync(join(freshLocal, '.git/git-auto-remote/review-pending'))).toBe(false);
  });

  test('skip flow: root-partial skipped -> tracking stays at root, next pull proceeds to child', async () => {
    // First pull pauses on root.
    await mirrorPull({ remote: 'upstream' });
    expect(git(freshLocal, 'rev-parse', trackingRefName('upstream'))).toBe(rootSha);

    // User skips root. Sub-case B skip: reset HEAD~1, discard worktree
    // overlay. Tracking stays at rootSha (already advanced). Skip auto-
    // resumes mirrorPull which should try to process the child. Since
    // the child's diff depends on root's content (which we skipped), it
    // will likely 3-way conflict on packages/cli/a.ts - but that's a REAL
    // conflict from a downstream commit, not the infinite-loop bug we're
    // guarding against. The key invariant: tracking advanced past root,
    // and the stuck commit (if any) is the CHILD, not the root again.
    const code = await mirrorSkip('upstream');
    // Exit 0 if child applied cleanly, 1 if hit a downstream conflict.
    // Either outcome demonstrates we moved past root without looping.
    expect([0, 1]).toContain(code);

    // The infinite-loop bug (pre-0.5.4) had the tool re-prepend root to
    // the replay on every iteration, so the stuck patch in .git/rebase-apply
    // would always be root's patch. Here we verify we moved on: if am is in
    // progress, the stuck commit is the CHILD (not root being retried).
    // Tracking ref itself stays at rootSha on am-conflict (post-applypatch
    // only advances on successful apply) - so we don't check tracking,
    // we check which commit the pipeline is currently processing.
    if (existsSync(join(freshLocal, '.git/rebase-apply/next'))) {
      const stuckPatchFile = join(freshLocal, '.git/rebase-apply/0001');
      const firstLine = readFileSync(stuckPatchFile, 'utf8').split('\n', 1)[0];
      const stuckSha = firstLine.match(/^From\s+([0-9a-f]{40})\s+/)?.[1];
      expect(stuckSha).toBe(secondSha);
      expect(stuckSha).not.toBe(rootSha);
    } else {
      // Clean apply - tracking should be at secondSha
      expect(git(freshLocal, 'rev-parse', trackingRefName('upstream'))).toBe(secondSha);
    }
  });
});

/**
 * v0.5.5 regression: the partial-pause footer tells the user to run
 * `git diff HEAD <sourceSha>` to see what's in the source commit that
 * didn't land in HEAD. That hint is only useful if the diff ACTUALLY
 * produces output - tested explicitly below. Three cases:
 *
 *   1. Review-path overlay: HEAD has included subset, source has
 *      reviewPath content that did NOT land in HEAD.
 *      `git diff HEAD <source>` -> shows reviewPath content change.
 *
 *   2. Outside-scope content: source has a path that doesn't match any
 *      bucket, so it was dropped. HEAD lacks it entirely.
 *      `git diff HEAD <source>` -> shows the dropped path as an addition.
 *
 *   3. Mixed: review + outside + included. All three categories of
 *      "what's in source but not HEAD" surfaced in one diff.
 */
describe('v0.5.5: review-pause footer Dropped-hint produces meaningful diff', () => {
  function pushPartialWithReviewAndOutside(): string {
    // Seed reviewed on both sides at v1.
    writeFileSync(join(local, 'packages/reviewed'), 'reviewed v1\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-q', '-m', 'local: seed reviewed');
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/reviewed'), 'reviewed v1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'upstream: seed reviewed');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));

    // Partial: bumps a.ts (included) + reviewed (review) + root-README.md (outside).
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2 upstream\n');
    writeFileSync(join(seed, 'packages/reviewed'), 'reviewed v2 upstream\n');
    writeFileSync(join(seed, 'README.md'), '# Public Readme\nDescription.\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'feat: bump A + review + outside');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    return git(seed, 'rev-parse', 'HEAD');
  }

  beforeEach(() => {
    git(local, 'config', 'auto-remote.upstream.reviewPaths', 'packages/reviewed');
  });

  test("'git diff HEAD <sourceSha>' after a mixed partial pause shows review + outside content", async () => {
    const sourceSha = pushPartialWithReviewAndOutside();
    const code = await mirrorPull({ remote: 'upstream' });
    expect(code).toBe(0);

    // Sanity: HEAD moved (applyPartial landed the included subset).
    const headSha = git(local, 'rev-parse', 'HEAD');
    expect(headSha).not.toBe(sourceSha);

    // The footer's suggested diff must produce real output AND reference
    // the specific dropped/review paths a user needs to see.
    const diffOut = git(local, 'diff', 'HEAD', sourceSha);
    expect(diffOut.length).toBeGreaterThan(0);

    // Review-path content should be in the diff: HEAD has v1, source has v2.
    expect(diffOut).toContain('packages/reviewed');
    expect(diffOut).toContain('reviewed v2 upstream');

    // Outside-path content: HEAD doesn't have README.md, source does.
    expect(diffOut).toContain('README.md');
    expect(diffOut).toContain('Public Readme');

    // Included paths should NOT appear as deltas (they already landed in HEAD).
    // packages/cli/a.ts should appear in the diff only if there's something
    // different between HEAD's applied version and source's - and by design
    // there shouldn't be for the included subset. Assert it's absent from
    // the diff BY HEADER (not a substring match, since 'a.ts' could show up
    // inside one of the other diffs).
    expect(diffOut).not.toMatch(/^\+\+\+ b\/packages\/cli\/a\.ts$/m);

    // Marker records the correct source sha (what the footer shows).
    const marker = JSON.parse(readFileSync(join(local, '.git/git-auto-remote/review-pending'), 'utf8'));
    expect(marker.sourceSha).toBe(sourceSha);
  });

  test("'git diff HEAD <sourceSha>' output is non-empty even for outside-only partials (no review)", async () => {
    // No review path config this time - the partial is purely included + outside.
    git(local, 'config', '--unset-all', 'auto-remote.upstream.reviewPaths');

    // Seed minimal: just an upstream commit that adds packages/ + outside.
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/cli/b.ts'), 'new b\n');
    writeFileSync(join(seed, 'README.md'), 'outside content\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'feat: mixed + outside');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    const sourceSha = git(seed, 'rev-parse', 'HEAD');

    const code = await mirrorPull({ remote: 'upstream' });
    expect(code).toBe(0);

    const diffOut = git(local, 'diff', 'HEAD', sourceSha);
    expect(diffOut.length).toBeGreaterThan(0);
    // README.md (outside) must appear - that's the only thing the user needs to see.
    expect(diffOut).toContain('README.md');
    expect(diffOut).toContain('outside content');
  });
});

/**
 * CRIT-1 (T2-MCONT-02 through T2-MCONT-09): Perturbation hardening for
 * `mirror continue`. All four continue paths must explicitly re-assert the
 * tracking ref to sourceSha before tail-calling mirrorPull, mirroring the
 * v0.6.3 skip fix. This protects against:
 *   - Manual `git update-ref -d` deleting the tracking ref
 *   - Misconfigured fetch refspec clobbering the ref
 *   - Parallel processes / direnv reload rewinding tracking
 */
describe('CRIT-1: perturbation hardening - tracking ref re-assertion', () => {
  /** Seed packages/reviewed on both sides at v1, then push a mixed partial. */
  function pushMixedPartial(): string {
    writeFileSync(join(local, 'packages/reviewed'), 'reviewed v1\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-q', '-m', 'local: seed reviewed');
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/reviewed'), 'reviewed v1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'upstream: seed reviewed');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));

    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2 upstream\n');
    writeFileSync(join(seed, 'packages/reviewed'), 'reviewed v2\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'feat: bump A + reviewed');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    return git(seed, 'rev-parse', 'HEAD');
  }

  beforeEach(() => {
    git(local, 'config', 'auto-remote.upstream.reviewPaths', 'packages/reviewed');
  });

  describe('T2-MCONT-02/03: continueReviewPause re-asserts tracking ref when deleted', () => {
    test('tracking ref is restored to sourceSha after deletion', async () => {
      const sourceSha = pushMixedPartial();
      await mirrorPull({ remote: 'upstream' });
      expect(git(local, 'rev-parse', TRACKING)).toBe(sourceSha);

      // User stages review content
      git(local, 'add', 'packages/reviewed');

      // Perturbation: delete tracking ref between pause and continue
      git(local, 'update-ref', '-d', TRACKING);
      expect(() => git(local, 'rev-parse', TRACKING)).toThrow();

      // Continue should re-assert tracking before tail-calling mirrorPull
      const code = await mirrorContinue('upstream');
      expect(code).toBe(0);

      // Tracking ref must be at sourceSha, not missing
      expect(git(local, 'rev-parse', TRACKING)).toBe(sourceSha);
    });

    test('no duplicate commits when tracking rewound to older SHA', async () => {
      const sourceSha = pushMixedPartial();
      await mirrorPull({ remote: 'upstream' });

      // User stages and continues
      git(local, 'add', 'packages/reviewed');

      // Perturbation: rewind tracking to parent of sourceSha
      const olderSha = git(local, 'rev-parse', `${sourceSha}^`);
      git(local, 'update-ref', TRACKING, olderSha);

      const code = await mirrorContinue('upstream');
      expect(code).toBe(0);

      // The continued commit should appear only once in log
      const subjects = git(local, 'log', '--format=%s', '-10').split('\n');
      const featCount = subjects.filter(s => s.includes('feat: bump A + reviewed')).length;
      expect(featCount).toBe(1);

      // Tracking must be at sourceSha
      expect(git(local, 'rev-parse', TRACKING)).toBe(sourceSha);
    });
  });

  describe('T2-MCONT-04/05: continuePureReviewPause re-asserts tracking ref when deleted', () => {
    function pushPureReviewCommit(): string {
      writeFileSync(join(local, 'bun.lock'), 'locked v1\n');
      git(local, 'add', '-A');
      git(local, 'commit', '-q', '-m', 'local: seed bun.lock');
      const seed = join(root, 'seed');
      writeFileSync(join(seed, 'bun.lock'), 'locked v1\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-q', '-m', 'upstream: seed bun.lock');
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
      git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));

      writeFileSync(join(seed, 'bun.lock'), 'locked v2\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-q', '-m', 'chore: bump bun.lock');
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
      return git(seed, 'rev-parse', 'HEAD');
    }

    beforeEach(() => {
      git(local, 'config', 'auto-remote.upstream.reviewPaths', 'bun.lock');
    });

    test('tracking ref is restored to sourceSha after deletion', async () => {
      const sourceSha = pushPureReviewCommit();
      await mirrorPull({ remote: 'upstream' });
      expect(git(local, 'rev-parse', TRACKING)).toBe(sourceSha);

      // User stages content
      git(local, 'add', 'bun.lock');

      // Perturbation: delete tracking ref
      git(local, 'update-ref', '-d', TRACKING);

      const code = await mirrorContinue('upstream');
      expect(code).toBe(0);

      // Tracking must be at sourceSha
      expect(git(local, 'rev-parse', TRACKING)).toBe(sourceSha);
    });

    test('no duplicate commits when tracking rewound to older SHA', async () => {
      const sourceSha = pushPureReviewCommit();
      await mirrorPull({ remote: 'upstream' });

      git(local, 'add', 'bun.lock');

      // Perturbation: rewind tracking
      const olderSha = git(local, 'rev-parse', `${sourceSha}^`);
      git(local, 'update-ref', TRACKING, olderSha);

      const code = await mirrorContinue('upstream');
      expect(code).toBe(0);

      // The chore commit should appear only once
      const subjects = git(local, 'log', '--format=%s', '-10').split('\n');
      const choreCount = subjects.filter(s => s.includes('chore: bump bun.lock')).length;
      expect(choreCount).toBe(1);

      expect(git(local, 'rev-parse', TRACKING)).toBe(sourceSha);
    });
  });

  describe('T2-MCONT-06/07: continueAm re-asserts tracking ref after am --continue', () => {
    function pushUpstreamConflict(message = 'pkg: bump A to v2'): string {
      writeFileSync(join(local, 'packages/cli/a.ts'), 'v1 local (different)\n');
      git(local, 'add', '-A');
      git(local, 'commit', '-q', '-m', 'local: diverge A');

      const seed = join(root, 'seed');
      writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2 upstream\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-q', '-m', message);
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
      return git(seed, 'rev-parse', 'HEAD');
    }

    test('tracking ref is restored to sourceSha after deletion during am conflict', async () => {
      const conflictSha = pushUpstreamConflict();

      await mirrorPull({ remote: 'upstream' });
      expect(existsSync(join(local, '.git/rebase-apply'))).toBe(true);

      // User resolves conflict
      writeFileSync(join(local, 'packages/cli/a.ts'), 'v2 upstream\n');
      git(local, 'add', 'packages/cli/a.ts');

      // Perturbation: delete tracking ref while am is still in progress
      git(local, 'update-ref', '-d', TRACKING);

      const code = await mirrorContinue('upstream');
      expect(code).toBe(0);

      // am should be done
      expect(existsSync(join(local, '.git/rebase-apply'))).toBe(false);

      // Tracking must be at conflictSha
      expect(git(local, 'rev-parse', TRACKING)).toBe(conflictSha);
    });

    test('no duplicate commits when tracking rewound during am conflict', async () => {
      const conflictSha = pushUpstreamConflict('feat: critical upstream update');

      await mirrorPull({ remote: 'upstream' });

      // User resolves
      writeFileSync(join(local, 'packages/cli/a.ts'), 'v2 upstream\n');
      git(local, 'add', 'packages/cli/a.ts');

      // Perturbation: rewind tracking
      const olderSha = git(local, 'rev-parse', `${conflictSha}^`);
      git(local, 'update-ref', TRACKING, olderSha);

      const code = await mirrorContinue('upstream');
      expect(code).toBe(0);

      // The commit should appear only once
      const subjects = git(local, 'log', '--format=%s', '-10').split('\n');
      const count = subjects.filter(s => s.includes('feat: critical upstream update')).length;
      expect(count).toBe(1);

      expect(git(local, 'rev-parse', TRACKING)).toBe(conflictSha);
    });
  });

  describe('T2-MCONT-08/09: continue is immune to fetch-refspec clobber on auto-resume', () => {
    test('tracking ref stays at source SHA despite misconfigured +refs/.../mirror/* refspec', async () => {
      const sourceSha = pushMixedPartial();

      // Pause on review
      await mirrorPull({ remote: 'upstream' });
      expect(git(local, 'rev-parse', TRACKING)).toBe(sourceSha);

      // Install the misconfigured fetch refspec
      const olderSha = git(local, 'rev-parse', `${sourceSha}^`);
      git(upstream, 'update-ref', TRACKING, olderSha);
      git(
        local,
        'config',
        '--add',
        'remote.upstream.fetch',
        '+refs/git-auto-remote/mirror/*:refs/git-auto-remote/mirror/*',
      );

      // Stage review and continue
      git(local, 'add', 'packages/reviewed');

      // The continue's tail-call to mirrorPull must NOT clobber tracking
      const code = await mirrorContinue('upstream');
      expect(code).toBe(0);

      // Assertion 1: tracking ends at sourceSha, NOT olderSha
      expect(git(local, 'rev-parse', TRACKING)).toBe(sourceSha);

      // Assertion 2: no duplicate of the continued commit
      const subjects = git(local, 'log', '--format=%s', '-10').split('\n');
      const featCount = subjects.filter(s => s.includes('feat: bump A + reviewed')).length;
      expect(featCount).toBe(1);
    });
  });
});

/**
 * CRIT-2 (T2-MCONT-10 through T2-MCONT-12): HEAD verification in postAmTransition.
 * When transitioning from am-in-progress to review-pause, the tool must verify
 * that HEAD actually contains the included subset of sourceSha before overlaying
 * review content. If HEAD is wrong (e.g., user ran `git am --abort`), the tool
 * must refuse rather than silently creating a review-pause on inconsistent state.
 */
describe('CRIT-2: postAmTransition HEAD verification', () => {
  function pushAmConflictWithReview(): string {
    // Seed with review path
    writeFileSync(join(local, 'packages/reviewed'), 'reviewed v1\n');
    // Also modify packages/cli/a.ts locally to cause a conflict
    writeFileSync(join(local, 'packages/cli/a.ts'), 'v1 LOCAL MODIFIED\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-q', '-m', 'local: seed reviewed + modify a.ts');

    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/reviewed'), 'reviewed v1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'upstream: seed reviewed');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));

    // Push commit with both conflict-causing change AND review content
    // This will conflict because local modified a.ts differently
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2 upstream conflict\n');
    writeFileSync(join(seed, 'packages/reviewed'), 'reviewed v2 upstream\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'feat: conflicting change + review');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    return git(seed, 'rev-parse', 'HEAD');
  }

  beforeEach(() => {
    git(local, 'config', 'auto-remote.upstream.reviewPaths', 'packages/reviewed');
  });

  test('T2-MCONT-10/11: postAmTransition refuses when HEAD does not contain included subset', async () => {
    const sourceSha = pushAmConflictWithReview();

    // Start mirror pull - should pause on am conflict
    await mirrorPull({ remote: 'upstream' });
    expect(existsSync(join(local, '.git/rebase-apply'))).toBe(true);

    // Get the HEAD before we abort
    const headBeforeAbort = git(local, 'rev-parse', 'HEAD');

    // User bypasses mirror continue and aborts the am directly
    git(local, 'am', '--abort');
    expect(existsSync(join(local, '.git/rebase-apply'))).toBe(false);

    // HEAD should be back to before the am attempt
    const headAfterAbort = git(local, 'rev-parse', 'HEAD');
    expect(headAfterAbort).toBe(headBeforeAbort);

    // The review-pending marker still says am-in-progress
    const marker = JSON.parse(readFileSync(join(local, '.git/git-auto-remote/review-pending'), 'utf8'));
    expect(marker.phase).toBe('am-in-progress');
    expect(marker.sourceSha).toBe(sourceSha);

    // Now user runs mirror continue - it should detect HEAD doesn't have the included subset
    // and refuse (not silently transition to review-pause)
    const code = await mirrorContinue('upstream');
    expect(code).toBe(1);

    // Should NOT have transitioned to review-pause
    const markerAfter = JSON.parse(readFileSync(join(local, '.git/git-auto-remote/review-pending'), 'utf8'));
    expect(markerAfter.phase).toBe('am-in-progress');

    // HEAD should still be at the abort point
    expect(git(local, 'rev-parse', 'HEAD')).toBe(headAfterAbort);
  });
});

/**
 * HIGH-5 (T2-STR-01): Strengthen existing test to verify no spurious output.
 */
describe('HIGH-5: strengthened diagnostics for continue without staging', () => {
  function pushMixedPartial(): string {
    writeFileSync(join(local, 'packages/reviewed'), 'reviewed v1\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-q', '-m', 'local: seed reviewed');
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/reviewed'), 'reviewed v1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'upstream: seed reviewed');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));

    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2 upstream\n');
    writeFileSync(join(seed, 'packages/reviewed'), 'reviewed v2\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'feat: bump A + reviewed');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    return git(seed, 'rev-parse', 'HEAD');
  }

  beforeEach(() => {
    git(local, 'config', 'auto-remote.upstream.reviewPaths', 'packages/reviewed');
  });

  test('continue WITHOUT staging discards unstaged review leftovers and emits no Applying/Partial lines', async () => {
    await pushMixedPartial();
    await mirrorPull({ remote: 'upstream' });

    const headSha = git(local, 'rev-parse', 'HEAD');

    // Capture stderr during continue
    const originalStderr = process.stderr.write;
    const stderrChunks: string[] = [];
    process.stderr.write = (chunk: string | Buffer) => {
      stderrChunks.push(String(chunk));
      return true;
    };

    const code = await mirrorContinue('upstream');

    // Restore stderr
    process.stderr.write = originalStderr;

    expect(code).toBe(0);
    expect(git(local, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(readFileSync(join(local, 'packages/reviewed'), 'utf8')).toBe('reviewed v1\n');
    expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);

    // Assert no "Applying:" or "Partial:" lines in stderr (these indicate
    // spurious mirrorPull activity on the just-continued commit)
    const stderr = stderrChunks.join('');
    expect(stderr).not.toContain('Applying:');
    expect(stderr).not.toContain('Partial:');
  });
});
