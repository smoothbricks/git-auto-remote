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

  git(local, 'config', 'fork-remote.upstream.syncPaths', 'packages');
  git(local, 'config', 'fork-remote.upstream.syncTargetBranch', 'private');
  git(local, 'config', 'fork-remote.upstream.syncBranch', 'main');
  git(local, 'config', 'fork-remote.upstream.pushSyncRef', 'false');

  // Bootstrap tracking ref to upstream's INITIAL commit.
  const upstreamRoot = git(local, 'rev-list', '--max-parents=0', 'upstream/main');
  git(local, 'update-ref', TRACKING, upstreamRoot);

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
    git(local, 'config', 'fork-remote.upstream.reviewPaths', 'packages/reviewed');
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
    const files = git(local, 'show', '--name-only', '--format=', newHead)
      .split('\n')
      .filter(Boolean)
      .sort();
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
    git(local, 'config', 'fork-remote.upstream.reviewPaths', 'bun.lock');
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
    const marker = JSON.parse(
      readFileSync(join(local, '.git/git-auto-remote/review-pending'), 'utf8'),
    );
    expect(marker.phase).toBe('pure-review-pause');
    expect(marker.included).toEqual([]);
    expect(marker.review).toEqual(['bun.lock']);
    // Pending-commit metadata written.
    const pending = JSON.parse(
      readFileSync(join(local, '.git/git-auto-remote/pending-commit'), 'utf8'),
    );
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
