import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMirrorConfig, listMirrorConfigs } from '../src/lib/mirror-config.js';

/**
 * C1-a: self-healing committed-config loading.
 *
 * A mirror must be recognizable from a committed config file (checked into the
 * worktree) even when the host's `.git/config` carries NO `[auto-remote]`
 * section. Resolution order for the committed file:
 *   1. `git config auto-remote.configFile <path>`
 *   2. repo-root `auto-remote.gitconfig`
 *   3. `tooling/auto-remote.gitconfig`
 * Standard `git config` overrides the committed file on a per-key basis.
 */

let root: string;
let repo: string;
let originalCwd: string;

const ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: { ...process.env, ...ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed:\n${r.stdout}\n${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function writeFile(rel: string, content: string): void {
  const full = join(repo, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

const SECTION = (target = 'private') =>
  `[auto-remote "public-repo"]\n\tsyncPaths = packages tooling\n\treviewPaths = tooling/workspace.gitconfig\n\tsyncTargetBranch = ${target}\n`;

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'gar-cfg-'));
  repo = join(root, 'repo');
  git(root, 'init', '-q', repo);
  writeFileSync(join(repo, 'seed.txt'), 'seed\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'seed');
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('committed mirror config (C1-a)', () => {
  test('recognizes a mirror from repo-root auto-remote.gitconfig with NO .git/config entry', () => {
    writeFile('auto-remote.gitconfig', SECTION());
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'add committed mirror config');

    // Sanity: there is genuinely no [auto-remote] in .git/config.
    const probe = spawnSync('git', ['config', '--local', '--get-regexp', '^auto-remote\\.'], { cwd: repo, encoding: 'utf8' });
    expect((probe.stdout ?? '').trim().length).toBe(0);

    const cfg = getMirrorConfig('public-repo');
    expect(cfg).not.toBeNull();
    expect(cfg?.syncPaths).toContain('packages');
    expect(cfg?.syncPaths).toContain('tooling');
    expect(cfg?.reviewPaths).toContain('tooling/workspace.gitconfig');
    expect(cfg?.syncTargetBranch).toBe('private');

    const all = listMirrorConfigs();
    expect(all.map((c) => c.remote)).toEqual(['public-repo']);
  });

  test('standard git config overrides the committed file per key', () => {
    writeFile('auto-remote.gitconfig', SECTION('private'));
    git(repo, 'config', 'auto-remote.public-repo.syncTargetBranch', 'override-branch');

    const cfg = getMirrorConfig('public-repo');
    expect(cfg?.syncTargetBranch).toBe('override-branch');
    // syncPaths still come from the committed file.
    expect(cfg?.syncPaths).toContain('packages');
  });

  test('auto-remote.configFile <path> selects a custom committed file', () => {
    writeFile('tooling/custom.gitconfig', SECTION());
    git(repo, 'config', 'auto-remote.configFile', 'tooling/custom.gitconfig');

    const cfg = getMirrorConfig('public-repo');
    expect(cfg).not.toBeNull();
    expect(cfg?.syncPaths).toContain('packages');
  });

  test('tooling/auto-remote.gitconfig is discovered when no root file and no configFile key', () => {
    writeFile('tooling/auto-remote.gitconfig', SECTION());
    const cfg = getMirrorConfig('public-repo');
    expect(cfg).not.toBeNull();
    expect(cfg?.syncPaths).toContain('packages');
  });

  test('repo-root auto-remote.gitconfig takes precedence over tooling/auto-remote.gitconfig', () => {
    writeFile('auto-remote.gitconfig', SECTION('root-branch'));
    writeFile('tooling/auto-remote.gitconfig', SECTION('tooling-branch'));
    const cfg = getMirrorConfig('public-repo');
    expect(cfg?.syncTargetBranch).toBe('root-branch');
  });

  test('a missing configFile path is a clear error, not a silent no-op', () => {
    git(repo, 'config', 'auto-remote.configFile', 'tooling/does-not-exist.gitconfig');
    expect(() => getMirrorConfig('public-repo')).toThrow(/configFile/);
    expect(() => listMirrorConfigs()).toThrow(/does-not-exist\.gitconfig/);
  });

  test('committed syncPathsFile resolves against a committed worktree path', () => {
    writeFile('auto-remote.gitconfig', `[auto-remote "public-repo"]\n\tsyncPathsFile = tooling/git-mirror-paths.txt\n\tsyncTargetBranch = private\n`);
    writeFile('tooling/git-mirror-paths.txt', '# comment\npackages\ntooling\n');
    const cfg = getMirrorConfig('public-repo');
    expect(cfg).not.toBeNull();
    expect(cfg?.syncPaths).toEqual(['packages', 'tooling']);
  });

  test('no committed file and no git config = not a mirror (null), no throw', () => {
    expect(getMirrorConfig('public-repo')).toBeNull();
    expect(listMirrorConfigs()).toEqual([]);
  });
});
