import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookStatus, installHook, uninstallHook } from '../src/lib/hooks.js';

/**
 * Integration tests: create a real temporary git repo, cd into it, run installer.
 * The hook installer talks to `git rev-parse --git-dir`, so we need a real repo.
 */

let repoDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  repoDir = mkdtempSync(join(tmpdir(), 'git-auto-remote-test-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  process.chdir(repoDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(repoDir, { recursive: true, force: true });
});

describe('installHook', () => {
  describe('when the hook file does not exist', () => {
    test('creates a new hook file with our snippet', () => {
      const result = installHook('post-checkout');
      expect(result.kind).toBe('installed');

      const content = readFileSync(join(repoDir, '.git/hooks/post-checkout'), 'utf8');
      expect(content).toContain('#!/usr/bin/env bash');
      expect(content).toContain('git-auto-remote post-checkout');
      // Start marker is formatted as `>>> git-auto-remote <hook> <version> >>>`.
      expect(content).toMatch(/>>> git-auto-remote post-checkout\s+\S+ >>>/);
      // bunx call is version-pinned so hooks run the installer's version line.
      expect(content).toMatch(/bunx --bun git-auto-remote@\d+\.\d+\.x post-checkout/);
    });

    test('makes the hook file executable', () => {
      installHook('post-checkout');
      const mode = require('node:fs').statSync(join(repoDir, '.git/hooks/post-checkout')).mode;
      // eslint-disable-next-line no-bitwise
      expect(mode & 0o111).not.toBe(0);
    });
  });

  describe('when the hook file already contains our snippet', () => {
    test('does not modify the file and reports already-present', () => {
      installHook('pre-push');
      const before = readFileSync(join(repoDir, '.git/hooks/pre-push'), 'utf8');
      const result = installHook('pre-push');
      expect(result.kind).toBe('already-present');
      const after = readFileSync(join(repoDir, '.git/hooks/pre-push'), 'utf8');
      expect(after).toBe(before);
    });

    test('replaces an older-generation block in place and reports updated', () => {
      // Simulate a hook installed by a previous version (no version suffix in
      // marker, unpinned bunx call).
      const old = [
        '#!/usr/bin/env bash',
        '',
        '# >>> git-auto-remote post-checkout >>>',
        '# Managed by git-auto-remote.',
        'bunx --bun git-auto-remote post-checkout "$@" || true',
        '# <<< git-auto-remote post-checkout <<<',
        '',
      ].join('\n');
      writeFileSync(join(repoDir, '.git/hooks/post-checkout'), old, { mode: 0o755 });

      const result = installHook('post-checkout');
      expect(result.kind).toBe('updated');

      const after = readFileSync(join(repoDir, '.git/hooks/post-checkout'), 'utf8');
      // Old marker gone, new (versioned, pinned) snippet in its place.
      expect(after).not.toContain('git-auto-remote post-checkout "$@"');
      expect(after).toMatch(/bunx --bun git-auto-remote@\d+\.\d+\.x post-checkout/);
      expect(after).toContain('#!/usr/bin/env bash');
    });
  });

  describe('when a foreign hook file already exists', () => {
    test('appends our snippet, preserving the original content', () => {
      const original = '#!/usr/bin/env bash\n# some existing tool\necho "hello"\n';
      writeFileSync(join(repoDir, '.git/hooks/post-checkout'), original, { mode: 0o755 });

      const result = installHook('post-checkout');
      expect(result.kind).toBe('appended');

      const content = readFileSync(join(repoDir, '.git/hooks/post-checkout'), 'utf8');
      expect(content).toContain('echo "hello"');
      expect(content).toContain('git-auto-remote post-checkout');
      // Original content comes before our snippet
      expect(content.indexOf('echo "hello"')).toBeLessThan(content.indexOf('git-auto-remote'));
    });
  });

  describe('different exit behaviors per hook', () => {
    test('post-checkout uses "|| true" so failures never block checkouts', () => {
      installHook('post-checkout');
      const content = readFileSync(join(repoDir, '.git/hooks/post-checkout'), 'utf8');
      expect(content).toContain('|| true');
    });

    test('pre-push uses "|| exit $?" so it can block unsafe pushes', () => {
      installHook('pre-push');
      const content = readFileSync(join(repoDir, '.git/hooks/pre-push'), 'utf8');
      expect(content).toContain('|| exit $?');
    });
  });
});

describe('hookStatus', () => {
  test('reports absent when the file does not exist', () => {
    expect(hookStatus('post-checkout')).toBe('absent');
  });

  test('reports present-ours after installation', () => {
    installHook('post-checkout');
    expect(hookStatus('post-checkout')).toBe('present-ours');
  });

  test('reports present-foreign when a non-ours hook exists', () => {
    writeFileSync(join(repoDir, '.git/hooks/post-checkout'), '#!/bin/sh\necho hi\n');
    expect(hookStatus('post-checkout')).toBe('present-foreign');
  });
});

describe('uninstallHook', () => {
  test('removes our block while preserving foreign content', () => {
    const original = '#!/usr/bin/env bash\necho "keep me"\n';
    writeFileSync(join(repoDir, '.git/hooks/pre-push'), original, { mode: 0o755 });
    installHook('pre-push');

    const result = uninstallHook('pre-push');
    expect(result.kind).toBe('removed');

    const content = readFileSync(join(repoDir, '.git/hooks/pre-push'), 'utf8');
    expect(content).toContain('echo "keep me"');
    expect(content).not.toContain('git-auto-remote');
  });

  test('leaves just the shebang when only our block was present', () => {
    installHook('post-checkout');
    uninstallHook('post-checkout');
    const content = readFileSync(join(repoDir, '.git/hooks/post-checkout'), 'utf8');
    expect(content).toContain('#!/usr/bin/env bash');
    expect(content).not.toContain('git-auto-remote');
  });

  test('reports file-missing when the hook file does not exist', () => {
    const result = uninstallHook('pre-push');
    expect(result.kind).toBe('file-missing');
  });

  test('reports not-present when the hook exists without our block', () => {
    writeFileSync(join(repoDir, '.git/hooks/pre-push'), '#!/bin/sh\n');
    const result = uninstallHook('pre-push');
    expect(result.kind).toBe('not-present');
    expect(existsSync(join(repoDir, '.git/hooks/pre-push'))).toBe(true);
  });
});
