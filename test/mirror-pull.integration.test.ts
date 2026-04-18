import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHook } from '../src/lib/hooks.js';
import { trackingRefName } from '../src/lib/mirror-state.js';
import { mirrorPull } from '../src/commands/mirror-pull.js';

const TRACKING_UPSTREAM = trackingRefName('upstream');

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
  git(local, 'config', 'auto-remote.upstream.syncPaths', 'packages');
  git(local, 'config', 'auto-remote.upstream.syncTargetBranch', 'private');
  git(local, 'config', 'auto-remote.upstream.syncBranch', 'main');
  git(local, 'config', 'auto-remote.upstream.pushSyncRef', 'false');

  // 5) Bootstrap the tracking ref to upstream's current tip (content is in sync).
  const upstreamTip = git(local, 'rev-parse', 'upstream/main');
  git(local, 'update-ref', TRACKING_UPSTREAM, upstreamTip);

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
      const tracking = git(local, 'rev-parse', TRACKING_UPSTREAM);
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

    test('--non-interactive with empty review + no handler: auto-applies (no stop)', async () => {
      // v0.5.8: review bucket is empty (no reviewPaths configured, and the
      // README is 'outside', not 'review'). A partial with review=[] has
      // nothing for a human to decide, so it auto-applies in all modes -
      // including --non-interactive - rather than stopping.
      const headBefore = git(local, 'rev-parse', 'HEAD');
      const code = await mirrorPull({
        remote: 'upstream',
        nonInteractive: true,
      });
      expect(code).toBe(0);
      // Commit landed.
      expect(git(local, 'rev-parse', 'HEAD')).not.toBe(headBefore);
      // README (outside) must NOT have been pulled in.
      const readmeLocal = join(local, 'README.md');
      expect(existsSync(readmeLocal)).toBe(false);
      // No review-pending marker.
      expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
    });

    test('interactive mode auto-applies when review bucket is empty (no pointless pause)', async () => {
      // v0.5.8 FIX: a partial commit with review=[] (only outside + included,
      // or outside + included + regenerate) has nothing for a human to decide.
      // Pre-v0.5.8 incorrectly paused with a "review required" marker, forcing
      // the user to type `mirror continue` for no reason.
      const headBefore = git(local, 'rev-parse', 'HEAD');
      const code = await mirrorPull({ remote: 'upstream' });
      expect(code).toBe(0);
      // Commit landed (included subset applied via git am).
      expect(git(local, 'rev-parse', 'HEAD')).not.toBe(headBefore);
      // README (outside) must NOT have been pulled in.
      expect(existsSync(join(local, 'README.md'))).toBe(false);
      // CRITICAL: NO review-pending marker must be written. Pre-v0.5.8 wrote
      // one here, causing the bogus pause.
      expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
      // Tracking ref advanced to source SHA.
      const upstreamTip = git(local, 'rev-parse', 'upstream/main');
      const tracking = git(local, 'rev-parse', TRACKING_UPSTREAM);
      expect(tracking).toBe(upstreamTip);
    });
  });

  describe('partial with empty review + regenerate (Conloca 56472eb1 shape)', () => {
    /**
     * EXACT SHAPE of the v0.5.7 Conloca bug: a partial commit that touches
     *   included (packages/*)   - applied via git am
     *   regenerate (bun.lock)   - regenerated locally + amended into HEAD
     *   outside (privpkgs/*)    - dropped from the patch
     *   review ([])             - EMPTY
     *
     * Pre-v0.5.8 this paused with a bogus "review required" marker. v0.5.8
     * must auto-apply: included lands, regenerate amends HEAD, outside is
     * dropped, no pause, no marker, tracking advances.
     */
    beforeEach(() => {
      // Seed bun.lock on both sides so it's a modification (not add) - the
      // realistic Conloca state.
      const seed = join(root, 'seed');
      writeFileSync(join(seed, 'bun.lock'), 'upstream-lock v0\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-q', '-m', 'seed: bun.lock v0');
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
      git(local, 'update-ref', TRACKING_UPSTREAM, git(local, 'rev-parse', 'upstream/main'));
      // Local has a different bun.lock (simulates prior local regeneration).
      writeFileSync(join(local, 'bun.lock'), 'local-regen\n');
      git(local, 'add', '-A');
      git(local, 'commit', '-q', '-m', 'local: seed bun.lock');

      // Configure regenerate + excludePaths (outside is implicit by
      // not matching anything).
      git(local, 'config', 'auto-remote.upstream.regeneratePaths', 'bun.lock');
      // Deterministic, git-independent regen so we don't depend on devenv/bun.
      git(local, 'config', 'auto-remote.upstream.regenerateCommand', "printf 'regenerated\\n' > bun.lock");

      // Upstream commit: touches included + regenerate + outside, no review.
      writeFileSync(join(seed, 'packages/cli/a.ts'), 'pkg A v2-Conloca\n');
      writeFileSync(join(seed, 'bun.lock'), 'upstream-lock v1\n');
      mkdirSync(join(seed, 'privpkgs/tldraw-app'), { recursive: true });
      writeFileSync(join(seed, 'privpkgs/tldraw-app/package.json'), '{"name":"td","v":"1"}\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-q', '-m', 'Refactor: cms-spa component structure (#5)');
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
    });

    test('auto-applies without pausing; review-pending marker is NOT written', async () => {
      const headBefore = git(local, 'rev-parse', 'HEAD');
      const code = await mirrorPull({ remote: 'upstream' });
      expect(code).toBe(0);
      // Included landed.
      expect(git(local, 'rev-parse', 'HEAD')).not.toBe(headBefore);
      expect(readFileSync(join(local, 'packages/cli/a.ts'), 'utf8')).toBe('pkg A v2-Conloca\n');
      // Regenerate: HEAD has OUR regenerated bun.lock, not source's 'upstream-lock v1'.
      expect(readFileSync(join(local, 'bun.lock'), 'utf8')).toBe('regenerated\n');
      // Outside dropped.
      expect(existsSync(join(local, 'privpkgs/tldraw-app/package.json'))).toBe(false);
      // No pause.
      expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
      // Tracking advanced.
      const upstreamTip = git(local, 'rev-parse', 'upstream/main');
      expect(git(local, 'rev-parse', TRACKING_UPSTREAM)).toBe(upstreamTip);
    });

    test('emits a one-line "Partial auto-applied" note listing regenerate + outside paths', async () => {
      // Capture console.error to verify user-facing messaging.
      const originalError = console.error;
      let captured = '';
      console.error = (...args: unknown[]): void => {
        captured += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
      };
      try {
        const code = await mirrorPull({ remote: 'upstream' });
        expect(code).toBe(0);
      } finally {
        console.error = originalError;
      }
      // One-line header in the auto-apply style.
      expect(captured).toMatch(/Partial auto-applied:\s+[0-9a-f]{8}\s+Refactor: cms-spa/);
      // Lists the regenerated + outside paths so user has visibility.
      expect(captured).toContain('Regenerated:');
      expect(captured).toContain('bun.lock');
      expect(captured).toContain('Outside (dropped):');
      expect(captured).toContain('privpkgs/tldraw-app/package.json');
      // MUST NOT contain the pre-v0.5.8 full-header-and-footer message.
      expect(captured).not.toContain('Review (in worktree, unstaged)');
      expect(captured).not.toContain('Continue: git-auto-remote mirror continue');
    });

    test('handler is NOT invoked when review is empty (even if configured, sub-case B)', async () => {
      // Handler creates a side-effect file if invoked. Assert it was NOT created.
      const handlerScript = join(root, 'handler-must-not-fire.sh');
      const sideEffect = join(root, 'handler-fired.marker');
      writeFileSync(handlerScript, `#!/usr/bin/env bash\ntouch ${JSON.stringify(sideEffect)}\nexit 0\n`);
      execFileSync('chmod', ['+x', handlerScript]);

      const code = await mirrorPull({
        remote: 'upstream',
        onPartial: handlerScript,
      });
      expect(code).toBe(0);
      // Handler's outcomes (resolved/skipped/punted/dirty-tree) all presuppose
      // review content to adjudicate. With review=[] there's nothing for the
      // handler to decide, so it must be skipped entirely.
      expect(existsSync(sideEffect)).toBe(false);
      // And the commit still auto-applies.
      expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
    });
  });

  describe('pure-non-sync partial with regenerate (Conloca 0c18e179 shape, sub-case C empty-review)', () => {
    /**
     * v0.5.9 INVARIANT: if a source commit touches a regenerate path, the
     * regenerate command MUST run, regardless of whether the commit has
     * included or review content.
     *
     * The Conloca bug report (v0.5.7/v0.5.8):
     *
     *   [mirror private] Partial:  0c18e179  chore(deps): update vite to 7.3.1
     *     Regenerate (auto-produced):     bun.lock
     *     Outside sync scope (dropped):   package.json
     *   [mirror private]   (regenerate paths touched: run 'devenv shell -c
     *     'bun install'' after continue if needed)
     *
     * The commit only bumps deps (bun.lock + root package.json, neither in
     * syncPaths). Pre-v0.5.9:
     *   - paused, demanded user action for nothing
     *   - did NOT run the regenerate command
     *   - local bun.lock stayed stale until the NEXT sub-case B commit
     *     came along and accumulated all drift into its amend
     *
     * v0.5.9 behavior:
     *   - regenerate command runs (no exception to the invariant)
     *   - regenerated content staged for commit
     *   - if staged diff non-empty: create a new local commit with source's
     *     author/email/date/message preserved (same pattern as
     *     continuePureReviewPause when the user stages review content)
     *   - if staged diff empty (regen was a no-op): just advance tracking
     *   - outside paths dropped (never synced)
     *   - tracking advances past source SHA
     *   - NO pause marker written, NO handler invocation
     */
    beforeEach(() => {
      const seed = join(root, 'seed');
      writeFileSync(join(seed, 'bun.lock'), 'upstream-lock v0\n');
      writeFileSync(join(seed, 'package.json'), '{"name":"upstream","v":"0"}\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-q', '-m', 'seed: bun.lock + package.json');
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
      git(local, 'update-ref', TRACKING_UPSTREAM, git(local, 'rev-parse', 'upstream/main'));

      // Local has a bun.lock that doesn't match what regen will produce -
      // ensures regen creates a diff.
      writeFileSync(join(local, 'bun.lock'), 'local-old\n');
      git(local, 'add', '-A');
      git(local, 'commit', '-q', '-m', 'local: seed bun.lock');

      git(local, 'config', 'auto-remote.upstream.regeneratePaths', 'bun.lock');
      git(local, 'config', 'auto-remote.upstream.regenerateCommand', "printf 'regenerated\\n' > bun.lock");

      // Source commit: ONLY touches regenerate + outside. No packages/ touch.
      writeFileSync(join(seed, 'bun.lock'), 'upstream-lock v1\n');
      writeFileSync(join(seed, 'package.json'), '{"name":"upstream","v":"1","dep":"x"}\n');
      // Author/date must be preserved on the synthesized commit.
      spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'pre-commit marker to bump index'], {
        cwd: seed,
        stdio: 'ignore',
      });
      // Go back and make the real commit with specific author metadata.
      git(seed, 'reset', '--hard', 'HEAD~1');
      writeFileSync(join(seed, 'bun.lock'), 'upstream-lock v1\n');
      writeFileSync(join(seed, 'package.json'), '{"name":"upstream","v":"1","dep":"x"}\n');
      git(seed, 'add', '-A');
      const makeCommit = spawnSync('git', ['commit', '-q', '-m', 'chore(deps): update vite to 7.3.1'], {
        cwd: seed,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Upstream Author',
          GIT_AUTHOR_EMAIL: 'upstream@example.com',
          GIT_AUTHOR_DATE: '2026-01-22T19:46:46+04:00',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      });
      if (makeCommit.status !== 0) throw new Error('seed commit failed');
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
    });

    test('regen runs; synthesizes a commit with source author/email/date/message preserved', async () => {
      const headBefore = git(local, 'rev-parse', 'HEAD');
      const sourceSha = git(local, 'rev-parse', 'upstream/main');

      const code = await mirrorPull({ remote: 'upstream' });
      expect(code).toBe(0);

      const headAfter = git(local, 'rev-parse', 'HEAD');
      // A new commit was created.
      expect(headAfter).not.toBe(headBefore);
      // Source author/email/date are preserved on the synthesized commit.
      expect(git(local, 'log', '-1', '--format=%an')).toBe('Upstream Author');
      expect(git(local, 'log', '-1', '--format=%ae')).toBe('upstream@example.com');
      expect(git(local, 'log', '-1', '--format=%aI')).toBe('2026-01-22T19:46:46+04:00');
      // Subject preserved verbatim.
      expect(git(local, 'log', '-1', '--format=%s')).toBe('chore(deps): update vite to 7.3.1');
      // Commit's bun.lock is the REGENERATED content, NOT upstream's.
      expect(git(local, 'show', 'HEAD:bun.lock')).toBe('regenerated');
      // Commit contains ONLY bun.lock (NOT package.json - outside dropped).
      const files = git(local, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
      expect(files).toEqual(['bun.lock']);
      // Tracking advanced past source SHA.
      expect(git(local, 'rev-parse', TRACKING_UPSTREAM)).toBe(sourceSha);
      // No pause markers.
      expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
      expect(existsSync(join(local, '.git/git-auto-remote/pending-commit'))).toBe(false);
      // Outside path dropped - root package.json NOT pulled in.
      expect(existsSync(join(local, 'package.json'))).toBe(false);
    });

    test('emits a one-line "Partial auto-applied (regenerate only)" note', async () => {
      const originalError = console.error;
      let captured = '';
      console.error = (...args: unknown[]): void => {
        captured += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
      };
      try {
        const code = await mirrorPull({ remote: 'upstream' });
        expect(code).toBe(0);
      } finally {
        console.error = originalError;
      }

      // Qualifier is "(regenerate only)" because regen produced a commit.
      expect(captured).toMatch(/Partial auto-applied:\s+[0-9a-f]{8}\s+chore\(deps\).*\(regenerate only\)/);
      expect(captured).toContain('Regenerated:');
      expect(captured).toContain('bun.lock');
      expect(captured).toContain('Outside (dropped):');
      expect(captured).toContain('package.json');

      // MUST NOT contain the pre-v0.5.9 pause messaging.
      expect(captured).not.toContain('(regenerate paths touched: run');
      expect(captured).not.toContain('Continue: git-auto-remote mirror continue');
      expect(captured).not.toContain('Review (in worktree, unstaged)');
    });

    test('no-op regen (output matches existing): tracking advances, NO commit created', async () => {
      // Override regen command to produce content matching local's existing bun.lock.
      git(local, 'config', 'auto-remote.upstream.regenerateCommand', "printf 'local-old\\n' > bun.lock");

      const headBefore = git(local, 'rev-parse', 'HEAD');
      const sourceSha = git(local, 'rev-parse', 'upstream/main');

      const code = await mirrorPull({ remote: 'upstream' });
      expect(code).toBe(0);

      // HEAD unchanged: regen was idempotent.
      expect(git(local, 'rev-parse', 'HEAD')).toBe(headBefore);
      // Tracking still advances past source (commit is considered processed).
      expect(git(local, 'rev-parse', TRACKING_UPSTREAM)).toBe(sourceSha);
      // No pause markers.
      expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
      // bun.lock unchanged.
      expect(readFileSync(join(local, 'bun.lock'), 'utf8')).toBe('local-old\n');
    });

    test('--non-interactive: regen runs and commit is synthesized (does NOT stop with exit 2)', async () => {
      const code = await mirrorPull({
        remote: 'upstream',
        nonInteractive: true,
      });
      expect(code).toBe(0);
      expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
      expect(git(local, 'log', '-1', '--format=%s')).toBe('chore(deps): update vite to 7.3.1');
    });

    test('handler is NOT invoked when review is empty (sub-case C, regen-only)', async () => {
      const handlerScript = join(root, 'handler-must-not-fire-c.sh');
      const sideEffect = join(root, 'handler-fired-c.marker');
      writeFileSync(handlerScript, `#!/usr/bin/env bash\ntouch ${JSON.stringify(sideEffect)}\nexit 0\n`);
      execFileSync('chmod', ['+x', handlerScript]);

      const code = await mirrorPull({
        remote: 'upstream',
        onPartial: handlerScript,
      });
      expect(code).toBe(0);
      expect(existsSync(sideEffect)).toBe(false);
      // Commit still synthesized (invariant holds regardless of handler).
      expect(git(local, 'log', '-1', '--format=%s')).toBe('chore(deps): update vite to 7.3.1');
    });

    test('regen command failure (non-zero exit): HALTS with error, no commit, no tracking advance', async () => {
      git(local, 'config', 'auto-remote.upstream.regenerateCommand', 'exit 42');

      const headBefore = git(local, 'rev-parse', 'HEAD');
      const trackingBefore = git(local, 'rev-parse', TRACKING_UPSTREAM);

      const code = await mirrorPull({ remote: 'upstream' });
      // Error propagation: non-zero exit.
      expect(code).toBe(1);
      // HEAD unchanged, tracking unchanged - no silent state corruption.
      expect(git(local, 'rev-parse', 'HEAD')).toBe(headBefore);
      expect(git(local, 'rev-parse', TRACKING_UPSTREAM)).toBe(trackingBefore);
      // No markers left behind.
      expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
      expect(existsSync(join(local, '.git/git-auto-remote/pending-commit'))).toBe(false);
    });
  });

  describe('pure-non-sync partial with NO regenerate paths (pure outside-only)', () => {
    /**
     * Edge case: commit touches ONLY outside paths (no included, no review,
     * no regenerate). Nothing for the tool to do. Advance tracking, emit
     * "(non-sync only, no regenerate)" note.
     */
    beforeEach(() => {
      const seed = join(root, 'seed');
      writeFileSync(join(seed, 'package.json'), '{"name":"upstream","v":"0"}\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-q', '-m', 'seed: package.json');
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
      git(local, 'update-ref', TRACKING_UPSTREAM, git(local, 'rev-parse', 'upstream/main'));

      writeFileSync(join(seed, 'package.json'), '{"name":"upstream","v":"1"}\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-q', '-m', 'docs: bump version comment');
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
    });

    test('advances tracking without commit, no pause, no handler', async () => {
      const headBefore = git(local, 'rev-parse', 'HEAD');
      const sourceSha = git(local, 'rev-parse', 'upstream/main');
      const code = await mirrorPull({ remote: 'upstream' });
      expect(code).toBe(0);
      expect(git(local, 'rev-parse', 'HEAD')).toBe(headBefore);
      expect(git(local, 'rev-parse', TRACKING_UPSTREAM)).toBe(sourceSha);
      expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
      expect(existsSync(join(local, 'package.json'))).toBe(false);
    });
  });

  describe('sub-case C with review AND regenerate: regen stages at pause entry, review overlays unstaged', () => {
    /**
     * Commit touches included=[], review=[x], regenerate=[bun.lock],
     * outside=[pkg.json]. Pre-v0.5.9: paused with "run regen manually" hint.
     * v0.5.9: regen runs at pause entry, stages regen content, review
     * overlays unstaged. `mirror continue` commits the full index (regen +
     * user-staged review hunks) as ONE commit with source metadata via
     * existing continuePureReviewPause logic.
     */
    beforeEach(() => {
      // Seed review + regen baselines.
      const seed = join(root, 'seed');
      mkdirSync(join(seed, 'tooling'), { recursive: true });
      writeFileSync(join(seed, 'tooling/reviewed.conf'), 'v0\n');
      writeFileSync(join(seed, 'bun.lock'), 'upstream-lock v0\n');
      writeFileSync(join(seed, 'package.json'), '{"name":"up","v":"0"}\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-q', '-m', 'seed: baselines');
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
      git(local, 'update-ref', TRACKING_UPSTREAM, git(local, 'rev-parse', 'upstream/main'));
      mkdirSync(join(local, 'tooling'), { recursive: true });
      writeFileSync(join(local, 'tooling/reviewed.conf'), 'v0\n');
      writeFileSync(join(local, 'bun.lock'), 'local-old\n');
      git(local, 'add', '-A');
      git(local, 'commit', '-q', '-m', 'local: seed baselines');

      git(local, 'config', 'auto-remote.upstream.reviewPaths', 'tooling/reviewed.conf');
      git(local, 'config', 'auto-remote.upstream.regeneratePaths', 'bun.lock');
      git(local, 'config', 'auto-remote.upstream.regenerateCommand', "printf 'regenerated\\n' > bun.lock");

      // Source commit: review + regenerate + outside (no included).
      writeFileSync(join(seed, 'tooling/reviewed.conf'), 'v1\n');
      writeFileSync(join(seed, 'bun.lock'), 'upstream-lock v1\n');
      writeFileSync(join(seed, 'package.json'), '{"name":"up","v":"1"}\n');
      git(seed, 'add', '-A');
      const r = spawnSync('git', ['commit', '-q', '-m', 'chore(deps): bump vite + tweak review'], {
        cwd: seed,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Upstream Author',
          GIT_AUTHOR_EMAIL: 'upstream@example.com',
          GIT_AUTHOR_DATE: '2026-02-01T10:00:00+04:00',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      });
      if (r.status !== 0) throw new Error('seed commit failed');
      git(seed, 'push', '-q', 'origin', 'main');
      git(local, 'fetch', '-q', 'upstream');
    });

    test('at pause entry: regen STAGED, review UNSTAGED in worktree, pure-review-pause marker written', async () => {
      const code = await mirrorPull({ remote: 'upstream' });
      expect(code).toBe(0);

      // Pause marker present.
      expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(true);
      expect(existsSync(join(local, '.git/git-auto-remote/pending-commit'))).toBe(true);

      // bun.lock (regen) is STAGED.
      const stagedNames = git(local, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();
      expect(stagedNames).toEqual(['bun.lock']);
      // Staged content is our regenerated output, not upstream's.
      expect(git(local, 'show', ':bun.lock')).toBe('regenerated');

      // tooling/reviewed.conf (review) is UNSTAGED in worktree.
      expect(readFileSync(join(local, 'tooling/reviewed.conf'), 'utf8')).toBe('v1\n');
      const unstagedNames = git(local, 'diff', '--name-only').split('\n').filter(Boolean).sort();
      expect(unstagedNames).toContain('tooling/reviewed.conf');
    });

    test('mirror continue with user-staged review: ONE commit lands with source metadata, containing BOTH regen + review', async () => {
      await mirrorPull({ remote: 'upstream' });

      // User stages the review hunk.
      git(local, 'add', 'tooling/reviewed.conf');

      const { mirrorContinue } = await import('../src/commands/mirror-continue.js');
      const code = await mirrorContinue('upstream');
      expect(code).toBe(0);

      // One new commit at HEAD with source metadata.
      expect(git(local, 'log', '-1', '--format=%an')).toBe('Upstream Author');
      expect(git(local, 'log', '-1', '--format=%ae')).toBe('upstream@example.com');
      expect(git(local, 'log', '-1', '--format=%aI')).toBe('2026-02-01T10:00:00+04:00');
      expect(git(local, 'log', '-1', '--format=%s')).toBe('chore(deps): bump vite + tweak review');

      // Commit content: BOTH bun.lock (regen) AND tooling/reviewed.conf (review).
      // NOT package.json (outside).
      const files = git(local, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
      expect(files).toEqual(['bun.lock', 'tooling/reviewed.conf']);
      expect(git(local, 'show', 'HEAD:bun.lock')).toBe('regenerated');
      expect(git(local, 'show', 'HEAD:tooling/reviewed.conf')).toBe('v1');

      // Markers cleared.
      expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
      expect(existsSync(join(local, '.git/git-auto-remote/pending-commit'))).toBe(false);
    });

    test('regen command failure at pause entry: HALTS with error, no pause marker stranded', async () => {
      git(local, 'config', 'auto-remote.upstream.regenerateCommand', 'exit 42');

      const headBefore = git(local, 'rev-parse', 'HEAD');
      const trackingBefore = git(local, 'rev-parse', TRACKING_UPSTREAM);

      const code = await mirrorPull({ remote: 'upstream' });
      expect(code).toBe(1);
      // No state advancement or marker creation.
      expect(git(local, 'rev-parse', 'HEAD')).toBe(headBefore);
      expect(git(local, 'rev-parse', TRACKING_UPSTREAM)).toBe(trackingBefore);
      expect(existsSync(join(local, '.git/git-auto-remote/review-pending'))).toBe(false);
      expect(existsSync(join(local, '.git/git-auto-remote/pending-commit'))).toBe(false);
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
    // A partial commit that touches included + review + outside. Review
    // content is REQUIRED for the handler path to engage (v0.5.8+: handler
    // is skipped when review bucket is empty because its outcomes all
    // presuppose review content to adjudicate).
    const seed = join(root, 'seed');
    // Seed the review file on both sides so it's a modification.
    mkdirSync(join(seed, 'tooling'), { recursive: true });
    writeFileSync(join(seed, 'tooling/reviewed.conf'), 'v0\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'seed: reviewed.conf');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    git(local, 'update-ref', TRACKING_UPSTREAM, git(local, 'rev-parse', 'upstream/main'));
    // Local has the same baseline so --3way can apply.
    mkdirSync(join(local, 'tooling'), { recursive: true });
    writeFileSync(join(local, 'tooling/reviewed.conf'), 'v0\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-q', '-m', 'local: seed reviewed.conf');

    // Configure reviewPaths.
    git(local, 'config', 'auto-remote.upstream.reviewPaths', 'tooling/reviewed.conf');

    // The partial commit: included + review + outside.
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'pkg A v2\n');
    writeFileSync(join(seed, 'tooling/reviewed.conf'), 'v1\n');
    writeFileSync(join(seed, 'README.md'), 'Mixed readme\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'feat: bump A + review + readme');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    handlerScript = join(root, 'handler.sh');
  });

  test('handler exit 0 = continue: the applied subset stays, no review pending', async () => {
    // Handler semantics (resolved = exit 0): handler is responsible for
    // leaving the worktree clean. Discard the unstaged review overlay to
    // simulate "I accept the included subset, reject the review hunks".
    writeFileSync(
      handlerScript,
      '#!/usr/bin/env bash\ngit restore tooling/reviewed.conf 2>/dev/null || true\nexit 0\n',
    );
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
    const trackingBefore = git(local, 'rev-parse', TRACKING_UPSTREAM);
    const code = await mirrorPull({
      remote: 'upstream',
      nonInteractive: true,
      onPartial: handlerScript,
    });
    expect(code).toBe(0);
    expect(git(local, 'rev-parse', 'HEAD')).toBe(headBefore);
    const trackingAfter = git(local, 'rev-parse', TRACKING_UPSTREAM);
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

    git(local, 'config', 'auto-remote.upstream.reviewPaths', 'packages/gitconfig');
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

    git(local, 'config', 'auto-remote.upstream.excludePaths', 'packages/internal');
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

describe('out-of-scope commits do NOT leak patches from ancestors (v0.3.6 regression)', () => {
  test("an out-of-scope commit produces an empty patch; ancestor's patch is NOT replayed", async () => {
    const seed = join(root, 'seed');
    // Commit A (ancestor, in-scope): touches packages/.
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'pkg A v2 upstream\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'ANCESTOR: in scope');
    // Commit B (descendant, out-of-scope): only touches README.md.
    writeFileSync(join(seed, 'README.md'), 'just a readme tweak\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'docs: readme tweak');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    // Advance tracking ref PAST A so A is already "synced" from the tool's POV.
    // B is then the only commit in the range - and it's out-of-scope.
    const aSha = git(local, 'rev-parse', 'upstream/main~0^'); // parent of tip == A
    git(local, 'update-ref', TRACKING_UPSTREAM, aSha);

    const headBefore = git(local, 'rev-parse', 'HEAD');
    const code = await mirrorPull({ remote: 'upstream' });
    expect(code).toBe(0);

    // HEAD must NOT have moved. Critically: A's patch (ANCESTOR) must NOT
    // have been replayed - which is exactly what `format-patch -1 B -- packages`
    // would incorrectly do (walk back to A).
    expect(git(local, 'rev-parse', 'HEAD')).toBe(headBefore);
    const log = git(local, 'log', '--format=%s', `${headBefore}..HEAD`);
    expect(log).toBe('');
    expect(existsSync(join(local, '.git/rebase-apply'))).toBe(false);
  });

  test('simulated post-skip state: out-of-scope commit between in-scope ancestor and descendant does NOT replay the ancestor', async () => {
    const seed = join(root, 'seed');
    // P: partial commit we pretend was just skipped. Touches packages/cli/a.ts + README.
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'pkg A PRETEND-SKIPPED\n');
    writeFileSync(join(seed, 'README.md'), 'readme v1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'PRETEND-SKIPPED: must not reappear');
    const pSha = git(seed, 'rev-parse', 'HEAD');
    // O: out-of-scope (only README).
    writeFileSync(join(seed, 'README.md'), 'readme v2\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'docs: O');
    // C: clean new file in scope.
    writeFileSync(join(seed, 'packages/cli/b.ts'), 'new file\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'feat: add B (clean)');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    // Simulate state immediately after `mirror am-skip` on P: tracking ref at P,
    // HEAD untouched.
    git(local, 'update-ref', TRACKING_UPSTREAM, pSha);

    const code = await mirrorPull({ remote: 'upstream' });
    expect(code).toBe(0);

    // C should have landed. P must NOT have reappeared as a "new" partial or
    // conflict - the v0.3.5 bug regenerated P's patch via ancestor walk from O.
    const log = git(local, 'log', '--format=%s', 'HEAD').split('\n');
    expect(log).toContain('feat: add B (clean)');
    expect(log).not.toContain('PRETEND-SKIPPED: must not reappear');
    expect(existsSync(join(local, '.git/rebase-apply'))).toBe(false);
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
    git(local, 'update-ref', TRACKING_UPSTREAM, localRoot);

    // Confirm rev-list now includes upstream's root.
    const rangeOut = git(local, 'rev-list', '--reverse', `${localRoot}..upstream/main`).split('\n');
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

  /**
   * v0.5.4: a fresh clone with NO tracking ref set should full-replay the
   * mirror from its root. No `mirror bootstrap` call required.
   *
   * Pre-0.5.4 history of this test: v0.5.3 tried to fix the root problem by
   * bootstrap-at-root + prepending the root during replay. That regressed
   * the resume-past-root case (infinite loop: prepend re-fired every
   * iteration since tracking-at-root stays as-is until the root applies).
   * The cleaner redesign is that bootstrap is OPT-IN for skip-ahead; the
   * default is full-history replay from no tracking ref.
   */
  test('mirror pull with no tracking ref does a full-history replay from the mirror root', async () => {
    // Build a fresh "empty-scaffold local" that lacks the mirror's root content.
    const freshLocal = join(root, 'fresh-local');
    git(root, 'init', '-q', freshLocal);
    // Seed with an unrelated scaffold commit so local has a HEAD that's on
    // a different history line from upstream's root.
    writeFileSync(join(freshLocal, 'LOCAL-SCAFFOLD'), 'scaffold\n');
    git(freshLocal, 'add', '-A');
    git(freshLocal, 'commit', '-q', '-m', 'local: scaffold');
    git(freshLocal, 'branch', '-M', 'private');
    git(freshLocal, 'remote', 'add', 'upstream', upstream);
    git(freshLocal, 'fetch', '-q', 'upstream');

    // Configure as a mirror of upstream. NO `mirror bootstrap` call.
    git(freshLocal, 'config', 'auto-remote.upstream.syncPaths', 'packages');
    git(freshLocal, 'config', 'auto-remote.upstream.syncTargetBranch', 'private');
    git(freshLocal, 'config', 'auto-remote.upstream.syncBranch', 'main');
    git(freshLocal, 'config', 'auto-remote.upstream.pushSyncRef', 'false');

    // Pre-state assertions.
    expect(existsSync(join(freshLocal, 'packages/cli/a.ts'))).toBe(false);
    // No tracking ref set. Check via spawn since `git rev-parse --verify`
    // exits non-zero when the ref doesn't exist (throws in our `git()` helper).
    const preTrackingStatus = spawnSync(
      'git',
      ['-C', freshLocal, 'rev-parse', '--verify', '--quiet', TRACKING_UPSTREAM],
      { stdio: 'pipe' },
    ).status;
    expect(preTrackingStatus).not.toBe(0);

    // Run mirror pull.
    const savedCwd = process.cwd();
    process.chdir(freshLocal);
    try {
      const code = await mirrorPull({ remote: 'upstream' });
      expect(code).toBe(0);
    } finally {
      process.chdir(savedCwd);
    }

    // Post-state: root commit's content landed, plus children.
    expect(existsSync(join(freshLocal, 'packages/cli/a.ts'))).toBe(true);
    expect(readFileSync(join(freshLocal, 'packages/cli/a.ts'), 'utf8')).toBe('pkg A v1\n');
    expect(readFileSync(join(freshLocal, 'packages/cli/b.ts'), 'utf8')).toBe('pkg B v1\n');
    // README.md was out-of-scope (no sync match) and dropped.
    expect(existsSync(join(freshLocal, 'README.md'))).toBe(false);
    // Tracking ref advanced to latest applied.
    const trackingAfter = git(freshLocal, 'rev-parse', TRACKING_UPSTREAM);
    expect(trackingAfter.length).toBe(40);
  });
});
