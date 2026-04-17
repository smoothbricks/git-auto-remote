import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
    gitcfg('fork-remote.public.syncPaths', 'packages');
    const config = getMirrorConfig('public');
    expect(config).not.toBeNull();
    expect(config?.remote).toBe('public');
    expect(config?.syncPaths).toEqual(['packages']);
    expect(config?.syncTargetBranch).toBe('public'); // default = remote name
    expect(config?.syncBranch).toBe('main'); // default when no remote HEAD
    expect(config?.partialHandler).toBeNull();
    expect(config?.pushSyncRef).toBe(true); // default
  });

  test('reads explicit values for all keys', () => {
    gitcfg('fork-remote.public.syncPaths', 'packages tooling');
    gitcfg('fork-remote.public.syncBranch', 'release');
    gitcfg('fork-remote.public.syncTargetBranch', 'private');
    gitcfg('fork-remote.public.partialHandler', '/path/to/handler.sh');
    gitcfg('fork-remote.public.pushSyncRef', 'false');

    const config = getMirrorConfig('public');
    expect(config?.syncPaths).toEqual(['packages', 'tooling']);
    expect(config?.syncBranch).toBe('release');
    expect(config?.syncTargetBranch).toBe('private');
    expect(config?.partialHandler).toBe('/path/to/handler.sh');
    expect(config?.pushSyncRef).toBe(false);
  });

  test('splits syncPaths on whitespace', () => {
    gitcfg('fork-remote.public.syncPaths', '  packages\ttooling  ');
    expect(getMirrorConfig('public')?.syncPaths).toEqual(['packages', 'tooling']);
  });
});

describe('listMirrorConfigs', () => {
  test('returns empty list when no mirrors are configured', () => {
    expect(listMirrorConfigs()).toEqual([]);
  });

  test('discovers mirrors by presence of syncPaths key', () => {
    gitcfg('fork-remote.public.syncPaths', 'packages');
    gitcfg('fork-remote.vendor.syncPaths', 'vendor');
    // Noise: a fork-remote.* config unrelated to mirroring
    gitcfg('fork-remote.public.somethingElse', 'x');

    const configs = listMirrorConfigs();
    const names = configs.map((c) => c.remote).sort();
    expect(names).toEqual(['public', 'vendor']);
  });

  test('skips remotes with empty syncPaths (no-op config)', () => {
    gitcfg('fork-remote.public.syncPaths', 'packages');
    gitcfg('fork-remote.quiet.syncPaths', '   ');
    const names = listMirrorConfigs().map((c) => c.remote);
    expect(names).toEqual(['public']);
  });
});
