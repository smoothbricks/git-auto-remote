import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirrorPull } from '../src/commands/mirror-pull.js';
import { installHook } from '../src/lib/hooks.js';
import { trackingRefName } from '../src/lib/mirror-state.js';

/**
 * Regression guard for the pause-message format (v0.5.5). Captures the
 * stderr output of `mirror pull` pausing on a partial, asserts the specific
 * strings a user sees. This locks in:
 *
 *   - Header format: `[mirror X] Partial:  <sha8>  <subject>`
 *     (short sha leads, two-space gutter, NOT suffix-parens).
 *   - Footer includes a source-commit recap line (sha + subject).
 *   - Footer hints point at `mirror diff` and `mirror source` subcommands
 *     (NOT `git show HEAD`, NOT `git diff HEAD <sha>` raw).
 *   - SHA width is 8 chars throughout.
 *   - The `Dropped:` and `Show:` labels use the subcommand forms.
 *
 * One regression test in ONE place makes format changes intentional - any
 * diff to the message strings blows this test up until the test is updated
 * alongside, forcing reviewer to notice the format shift.
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

function commitInto(cwd: string, path: string, content: string, message: string): string {
  const full = join(cwd, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** Run a function while capturing console.error calls. */
function captureStderr<T>(fn: () => T | Promise<T>): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  const restore = () => {
    console.error = original;
  };
  return Promise.resolve()
    .then(() => fn())
    .then((result) => {
      restore();
      return { result, output: lines.join('\n') };
    })
    .catch((err) => {
      restore();
      throw err;
    });
}

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'gar-fmt-'));
  upstream = join(root, 'upstream.git');
  local = join(root, 'local');

  git(root, 'init', '--bare', '-q', upstream);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', seed);
  commitInto(seed, 'packages/cli/a.ts', 'v1\n', 'pkg: add A');
  commitInto(seed, '.dummy-marker', 'x\n', 'marker');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', upstream);
  git(seed, 'push', '-q', 'origin', 'main');

  git(root, 'init', '-q', local);
  commitInto(local, 'packages/cli/a.ts', 'v1\n', 'local: add A');
  git(local, 'branch', '-M', 'private');
  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'fetch', '-q', 'upstream');

  git(local, 'config', 'auto-remote.upstream.syncPaths', 'packages');
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

describe('pause message format (v0.5.5 regression guard)', () => {
  test('partial-pause header + footer match the consistent format contract', async () => {
    // Push a commit with both included AND outside-scope content so it
    // classifies as partial.
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2 upstream\n');
    writeFileSync(join(seed, 'package.json'), '{"name":"outside"}\n'); // outside
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'feat: bump A and touch outside');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    const sourceSha = git(seed, 'rev-parse', 'HEAD');
    const shortSha = sourceSha.slice(0, 8);

    const { output } = await captureStderr(() => mirrorPull({ remote: 'upstream' }));

    // --- Header contract ---
    // `[mirror upstream] Partial:  <sha8>  <subject>` (two spaces around sha).
    expect(output).toContain(`[mirror upstream] Partial:  ${shortSha}  feat: bump A and touch outside`);
    // Outside bucket line uses the right label.
    expect(output).toContain('Outside sync scope (dropped):   package.json');

    // --- Footer contract ---
    // Source recap mid-footer (matches header's sha+subject).
    expect(output).toContain(`Source:   ${shortSha}  feat: bump A and touch outside`);
    // Subcommand-based Diff and Show lines (NOT raw git diff/git show).
    expect(output).toContain('Diff:     git-auto-remote mirror diff');
    expect(output).toContain('Show:     git-auto-remote mirror source');
    // Resume commands - v0.5.6: remote arg DROPPED from displayed commands
    // since during a pause only one remote can be paused at a time.
    expect(output).toContain('Continue: git-auto-remote mirror continue');
    expect(output).toContain('Skip:     git-auto-remote mirror skip');
    // v0.5.6 regression guards: the displayed commands MUST NOT include the
    // remote name as a positional (only one active pause -> remote is
    // unambiguous, forcing the user to type it was noise).
    expect(output).not.toMatch(/mirror continue upstream/);
    expect(output).not.toMatch(/mirror skip upstream/);
    expect(output).not.toMatch(/mirror diff upstream/);
    expect(output).not.toMatch(/mirror source upstream/);
    // Older obsolete hints must not reappear either.
    expect(output).not.toContain('git show HEAD');
    expect(output).not.toMatch(/git diff HEAD [0-9a-f]{8}/);
    // Parenthesized suffix form for sha (pre-v0.5.5) must not reappear.
    expect(output).not.toMatch(/Partial: .* \([0-9a-f]{8}\)/);
  });

  test('applying/skipping lines use short-sha prefix with two-space gutter', async () => {
    // Push two clean commits (in syncPaths) and one out-of-scope commit.
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'pkg: bump A');
    writeFileSync(join(seed, 'UNRELATED.md'), 'out-of-scope\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'docs: unrelated');
    writeFileSync(join(seed, 'packages/cli/b.ts'), 'new b\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'pkg: add B');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    const { output } = await captureStderr(() => mirrorPull({ remote: 'upstream' }));

    // Applying lines: `[mirror X] Applying: <sha8>  <subject>`
    expect(output).toMatch(/\[mirror upstream\] Applying: [0-9a-f]{8}  pkg: bump A/);
    expect(output).toMatch(/\[mirror upstream\] Applying: [0-9a-f]{8}  pkg: add B/);
    // Skipping out-of-scope line.
    expect(output).toMatch(/\[mirror upstream\] Skipping: [0-9a-f]{8}  docs: unrelated  \(out of scope\)/);
  });
});
