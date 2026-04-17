import { describe, expect, test } from 'bun:test';
import { classify, segment, type ClassifiedCommit, type PathSpec } from '../src/lib/classify.js';

const spec = (
  syncPaths: string[] = [],
  excludePaths: string[] = [],
  reviewPaths: string[] = [],
  regeneratePaths: string[] = [],
): PathSpec => ({ syncPaths, excludePaths, reviewPaths, regeneratePaths });

describe('classify', () => {
  describe('when no paths fall inside syncPaths, reviewPaths, or regeneratePaths', () => {
    test('returns out-of-scope for a commit with no changes', () => {
      expect(classify([], spec(['packages']))).toEqual({ kind: 'out-of-scope' });
    });

    test('outside-only is out-of-scope: nothing for the tool to act on', () => {
      // README.md isn't sync, exclude, review, or regenerate. With no content
      // in any actionable bucket, silently skip rather than pausing.
      expect(classify(['README.md', 'package.json'], spec(['packages']))).toEqual({
        kind: 'out-of-scope',
      });
    });
  });

  describe('when all paths are inside syncPaths', () => {
    test('returns clean with empty regenerate list', () => {
      expect(
        classify(['packages/cli/foo.ts', 'packages/mdx/bar.ts'], spec(['packages'])),
      ).toEqual({
        kind: 'clean',
        included: ['packages/cli/foo.ts', 'packages/mdx/bar.ts'],
        regenerate: [],
      });
    });

    test('a bare sync path (no slash) matches exactly', () => {
      expect(classify(['packages'], spec(['packages']))).toEqual({
        kind: 'clean',
        included: ['packages'],
        regenerate: [],
      });
    });
  });

  describe('when paths straddle syncPaths and outside', () => {
    test('returns partial with included + outside populated', () => {
      expect(
        classify(
          ['packages/cli/foo.ts', 'privpkgs/secret.ts', 'package.json'],
          spec(['packages']),
        ),
      ).toEqual({
        kind: 'partial',
        included: ['packages/cli/foo.ts'],
        review: [],
        regenerate: [],
        outside: ['privpkgs/secret.ts', 'package.json'],
      });
    });
  });

  describe('excludePaths take priority over all other buckets', () => {
    test('a path matching both sync and exclude is dropped entirely', () => {
      expect(
        classify(
          ['tooling/sync-with-public.sh'],
          spec(['tooling'], ['tooling/sync-with-public.sh']),
        ),
      ).toEqual({ kind: 'out-of-scope' });
    });

    test('exclude takes precedence even when mixed with included paths', () => {
      const result = classify(
        ['tooling/other.sh', 'tooling/sync-with-public.sh'],
        spec(['tooling'], ['tooling/sync-with-public.sh']),
      );
      expect(result).toEqual({
        kind: 'clean',
        included: ['tooling/other.sh'],
        regenerate: [],
      });
    });

    test('exclude does not cause partial classification (it is dropped, not outside)', () => {
      const result = classify(
        ['packages/x.ts', 'tooling/sync-with-public.sh'],
        spec(['packages', 'tooling'], ['tooling/sync-with-public.sh']),
      );
      expect(result).toEqual({ kind: 'clean', included: ['packages/x.ts'], regenerate: [] });
    });

    test('exclude takes priority over reviewPaths', () => {
      expect(
        classify(['secret.txt'], spec(['packages'], ['secret.txt'], ['secret.txt'])),
      ).toEqual({ kind: 'out-of-scope' });
    });

    test('exclude takes priority over regeneratePaths', () => {
      expect(
        classify(['secret.txt'], spec(['packages'], ['secret.txt'], [], ['secret.txt'])),
      ).toEqual({ kind: 'out-of-scope' });
    });
  });

  describe('reviewPaths is a first-class bucket', () => {
    test('a path in reviewPaths but NOT in syncPaths still lands in review bucket', () => {
      expect(classify(['bun.lock'], spec(['packages'], [], ['bun.lock']))).toEqual({
        kind: 'partial',
        included: [],
        review: ['bun.lock'],
        regenerate: [],
        outside: [],
      });
    });

    test('reviewPaths takes priority over syncPaths', () => {
      expect(
        classify(
          ['tooling/workspace.gitconfig'],
          spec(['tooling'], [], ['tooling/workspace.gitconfig']),
        ),
      ).toEqual({
        kind: 'partial',
        included: [],
        review: ['tooling/workspace.gitconfig'],
        regenerate: [],
        outside: [],
      });
    });

    test('reviewPaths takes priority over regeneratePaths when both match', () => {
      expect(
        classify(['foo'], spec([], [], ['foo'], ['foo'])),
      ).toEqual({
        kind: 'partial',
        included: [],
        review: ['foo'],
        regenerate: [],
        outside: [],
      });
    });
  });

  describe('regeneratePaths is a first-class bucket', () => {
    test('a path in regeneratePaths but NOT in syncPaths still lands in regenerate bucket', () => {
      // bun.lock: not in syncPaths, not in excludePaths, not in reviewPaths.
      // Configured as a regenerate path so the tool drops it from incoming patches
      // and runs `regenerateCommand` to (re-)produce a local version.
      expect(
        classify(['bun.lock'], spec(['packages'], [], [], ['bun.lock'])),
      ).toEqual({
        kind: 'clean',
        included: [],
        regenerate: ['bun.lock'],
      });
    });

    test('regeneratePaths takes priority over syncPaths', () => {
      expect(
        classify(['packages/cli/tsconfig.json'], spec(['packages'], [], [], ['packages/cli/tsconfig.json'])),
      ).toEqual({
        kind: 'clean',
        included: [],
        regenerate: ['packages/cli/tsconfig.json'],
      });
    });

    test('mixed commit: included + regenerate is still clean (auto-apply, regen runs at end)', () => {
      expect(
        classify(
          ['packages/cli/a.ts', 'bun.lock'],
          spec(['packages'], [], [], ['bun.lock']),
        ),
      ).toEqual({
        kind: 'clean',
        included: ['packages/cli/a.ts'],
        regenerate: ['bun.lock'],
      });
    });

    test('regenerate-only commit is clean (no HEAD change, regen runs)', () => {
      expect(classify(['bun.lock'], spec(['packages'], [], [], ['bun.lock']))).toEqual({
        kind: 'clean',
        included: [],
        regenerate: ['bun.lock'],
      });
    });

    test('included + review + regenerate: partial, all three surfaced', () => {
      const result = classify(
        ['packages/a.ts', 'tooling/workspace.gitconfig', 'bun.lock', 'privpkgs/x.ts'],
        spec(
          ['packages', 'tooling'],
          [],
          ['tooling/workspace.gitconfig'],
          ['bun.lock'],
        ),
      );
      expect(result).toEqual({
        kind: 'partial',
        included: ['packages/a.ts'],
        review: ['tooling/workspace.gitconfig'],
        regenerate: ['bun.lock'],
        outside: ['privpkgs/x.ts'],
      });
    });
  });

  describe('prefix matching precision', () => {
    test('does not false-match partial directory names', () => {
      expect(classify(['packages-rc/x.ts'], spec(['packages']))).toEqual({
        kind: 'out-of-scope',
      });
    });

    test('supports multiple syncPaths', () => {
      expect(
        classify(['packages/cli/a.ts', 'tooling/b.sh', 'README.md'], spec(['packages', 'tooling'])),
      ).toEqual({
        kind: 'partial',
        included: ['packages/cli/a.ts', 'tooling/b.sh'],
        review: [],
        regenerate: [],
        outside: ['README.md'],
      });
    });

    test('treats subdir pathspec strictly', () => {
      expect(classify(['tooling/direnv/a.sh'], spec(['tooling/direnv']))).toEqual({
        kind: 'clean',
        included: ['tooling/direnv/a.sh'],
        regenerate: [],
      });
      expect(classify(['tooling/other/a.sh'], spec(['tooling/direnv']))).toEqual({
        kind: 'out-of-scope',
      });
    });
  });
});

describe('segment', () => {
  const clean = (sha: string): ClassifiedCommit => ({
    sha,
    classification: { kind: 'clean', included: ['packages/x.ts'], regenerate: [] },
  });
  const out = (sha: string): ClassifiedCommit => ({
    sha,
    classification: { kind: 'out-of-scope' },
  });
  const partial = (sha: string): ClassifiedCommit => ({
    sha,
    classification: {
      kind: 'partial',
      included: ['packages/x.ts'],
      review: [],
      regenerate: [],
      outside: ['README.md'],
    },
  });

  test('empty input produces no segments', () => {
    expect(segment([])).toEqual([]);
  });

  test('a run of clean commits becomes one range', () => {
    const result = segment([clean('a'), clean('b'), clean('c')]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('range');
  });

  test('out-of-scope commits are absorbed into a surrounding range', () => {
    const result = segment([clean('a'), out('b'), clean('c')]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('range');
    if (result[0].kind === 'range') expect(result[0].commits).toHaveLength(3);
  });

  test('a single partial splits the range', () => {
    const result = segment([clean('a'), partial('b'), clean('c')]);
    expect(result).toHaveLength(3);
    expect(result[0].kind).toBe('range');
    expect(result[1].kind).toBe('partial');
    expect(result[2].kind).toBe('range');
  });

  test('leading partial produces no preceding range', () => {
    const result = segment([partial('a'), clean('b')]);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('partial');
    expect(result[1].kind).toBe('range');
  });

  test('adjacent partials produce back-to-back partial segments', () => {
    const result = segment([partial('a'), partial('b')]);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('partial');
    expect(result[1].kind).toBe('partial');
  });

  test('trailing partial is emitted as its own segment', () => {
    const result = segment([clean('a'), clean('b'), partial('c')]);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('range');
    expect(result[1].kind).toBe('partial');
  });
});

