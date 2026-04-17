import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMirrorConfig, listMirrorConfigs } from '../src/lib/mirror-config.js';

/**
 * Integration tests: we can't meaningfully unit-test getMirrorConfig without
 * mocking all of git, and the whole point is "this reads git config correctly",
 * so drive a real temporary repo.
 */

let repoDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  repoDir = mkdtempSync(join(tmpdir(), 'gar-mirror-config-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  process.chdir(repoDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(repoDir, { recursive: true, force: true });
});

const gitcfg = (key: string, value: string) =>
  execFileSync('git', ['config', key, value], { cwd: repoDir });

describe('getMirrorConfig', () => {
  test('returns null when syncPaths is not set', () => {
    expect(getMirrorConfig('public')).toBeNull();
  });

  test('applies defaults when only syncPaths is set', () => {
    gitcfg('auto-remote.public.syncPaths', 'packages');
    const config = getMirrorConfig('public');
    expect(config).not.toBeNull();
    expect(config?.remote).toBe('public');
    expect(config?.syncPaths).toEqual(['packages']);
    expect(config?.excludePaths).toEqual([]);
    expect(config?.reviewPaths).toEqual([]);
    expect(config?.syncTargetBranch).toBe('public'); // default = remote name
    expect(config?.syncBranch).toBe('main'); // default when no remote HEAD
    expect(config?.partialHandler).toBeNull();
    expect(config?.pushSyncRef).toBe(true); // default
  });

  test('reads explicit values for all keys', () => {
    gitcfg('auto-remote.public.syncPaths', 'packages tooling');
    gitcfg('auto-remote.public.excludePaths', 'tooling/sync-with-public.sh');
    gitcfg('auto-remote.public.reviewPaths', 'tooling/workspace.gitconfig');
    gitcfg('auto-remote.public.syncBranch', 'release');
    gitcfg('auto-remote.public.syncTargetBranch', 'private');
    gitcfg('auto-remote.public.partialHandler', '/path/to/handler.sh');
    gitcfg('auto-remote.public.pushSyncRef', 'false');

    const config = getMirrorConfig('public');
    expect(config?.syncPaths).toEqual(['packages', 'tooling']);
    expect(config?.excludePaths).toEqual(['tooling/sync-with-public.sh']);
    expect(config?.reviewPaths).toEqual(['tooling/workspace.gitconfig']);
    expect(config?.syncBranch).toBe('release');
    expect(config?.syncTargetBranch).toBe('private');
    expect(config?.partialHandler).toBe('/path/to/handler.sh');
    expect(config?.pushSyncRef).toBe(false);
  });

  test('splits syncPaths on whitespace', () => {
    gitcfg('auto-remote.public.syncPaths', '  packages\ttooling  ');
    expect(getMirrorConfig('public')?.syncPaths).toEqual(['packages', 'tooling']);
  });
});

describe('getMirrorConfig with *File keys', () => {
  test('loads syncPaths from a file, skipping blanks and # comments', () => {
    mkdirSync(join(repoDir, 'tooling'), { recursive: true });
    writeFileSync(
      join(repoDir, 'tooling/paths.txt'),
      [
        '# Shared paths',
        'packages',
        '',
        'tooling  # inline comment',
        '.gitignore',
        '   ',
      ].join('\n'),
    );
    gitcfg('auto-remote.public.syncPathsFile', 'tooling/paths.txt');

    expect(getMirrorConfig('public')?.syncPaths).toEqual(['packages', 'tooling', '.gitignore']);
  });

  test('unions inline syncPaths with syncPathsFile contents', () => {
    writeFileSync(join(repoDir, 'paths.txt'), 'packages\ntooling\n');
    gitcfg('auto-remote.public.syncPaths', 'docs CHANGELOG.md');
    gitcfg('auto-remote.public.syncPathsFile', 'paths.txt');
    expect(getMirrorConfig('public')?.syncPaths).toEqual([
      'docs',
      'CHANGELOG.md',
      'packages',
      'tooling',
    ]);
  });

  test('supports excludePathsFile and reviewPathsFile the same way', () => {
    writeFileSync(join(repoDir, 'sync.txt'), 'tooling\npackages\n');
    writeFileSync(join(repoDir, 'exclude.txt'), 'tooling/sync-with-public.sh\n');
    writeFileSync(join(repoDir, 'review.txt'), 'tooling/workspace.gitconfig\n');
    gitcfg('auto-remote.public.syncPathsFile', 'sync.txt');
    gitcfg('auto-remote.public.excludePathsFile', 'exclude.txt');
    gitcfg('auto-remote.public.reviewPathsFile', 'review.txt');

    const config = getMirrorConfig('public');
    expect(config?.syncPaths).toEqual(['tooling', 'packages']);
    expect(config?.excludePaths).toEqual(['tooling/sync-with-public.sh']);
    expect(config?.reviewPaths).toEqual(['tooling/workspace.gitconfig']);
  });

  test('throws (error surfaces) when syncPathsFile points at a missing file', () => {
    gitcfg('auto-remote.public.syncPathsFile', 'nope.txt');
    expect(() => getMirrorConfig('public')).toThrow();
  });
});

describe('listMirrorConfigs', () => {
  test('returns empty list when no mirrors are configured', () => {
    expect(listMirrorConfigs()).toEqual([]);
  });

  test('discovers mirrors by presence of syncPaths key', () => {
    gitcfg('auto-remote.public.syncPaths', 'packages');
    gitcfg('auto-remote.vendor.syncPaths', 'vendor');
    // Noise: a auto-remote.* config unrelated to mirroring
    gitcfg('auto-remote.public.somethingElse', 'x');

    const configs = listMirrorConfigs();
    const names = configs.map((c) => c.remote).sort();
    expect(names).toEqual(['public', 'vendor']);
  });

  test('skips remotes with empty syncPaths (no-op config)', () => {
    gitcfg('auto-remote.public.syncPaths', 'packages');
    gitcfg('auto-remote.quiet.syncPaths', '   ');
    const names = listMirrorConfigs().map((c) => c.remote);
    expect(names).toEqual(['public']);
  });

  test('also discovers mirrors that only set syncPathsFile', () => {
    writeFileSync(join(repoDir, 'paths.txt'), 'packages\n');
    gitcfg('auto-remote.public.syncPaths', 'packages');
    gitcfg('auto-remote.filed.syncPathsFile', 'paths.txt');
    const names = listMirrorConfigs().map((c) => c.remote).sort();
    expect(names).toEqual(['filed', 'public']);
  });
});
