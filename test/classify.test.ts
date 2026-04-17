import { describe, expect, test } from 'bun:test';
import { classify, segment, type ClassifiedCommit, type PathSpec } from '../src/lib/classify.js';

const spec = (
  syncPaths: string[] = [],
  excludePaths: string[] = [],
  reviewPaths: string[] = [],
): PathSpec => ({ syncPaths, excludePaths, reviewPaths });

describe('classify', () => {
  describe('when no paths fall inside syncPaths', () => {
    test('returns out-of-scope', () => {
      expect(classify(['README.md', 'package.json'], spec(['packages']))).toEqual({
        kind: 'out-of-scope',
      });
    });

    test('returns out-of-scope for a commit with no changes', () => {
      expect(classify([], spec(['packages']))).toEqual({ kind: 'out-of-scope' });
    });
  });

  describe('when all paths are inside syncPaths', () => {
    test('returns clean', () => {
      expect(
        classify(['packages/cli/foo.ts', 'packages/mdx/bar.ts'], spec(['packages'])),
      ).toEqual({
        kind: 'clean',
        included: ['packages/cli/foo.ts', 'packages/mdx/bar.ts'],
      });
    });

    test('a bare sync path (no slash) matches exactly', () => {
      expect(classify(['packages'], spec(['packages']))).toEqual({
        kind: 'clean',
        included: ['packages'],
      });
    });
  });

  describe('when paths straddle syncPaths and outside', () => {
    test('returns partial with both lists populated and empty reviewRequired', () => {
      expect(
        classify(
          ['packages/cli/foo.ts', 'privpkgs/secret.ts', 'package.json'],
          spec(['packages']),
        ),
      ).toEqual({
        kind: 'partial',
        included: ['packages/cli/foo.ts'],
        excluded: ['privpkgs/secret.ts', 'package.json'],
        reviewRequired: [],
      });
    });
  });

  describe('excludePaths', () => {
    test('a path matching both sync and exclude is dropped entirely', () => {
      // tooling/sync-with-public.sh lives under 'tooling' (sync) but is
      // explicitly excluded - a commit touching only it is out-of-scope.
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
      });
    });

    test('exclude does not cause partial classification (it is dropped, not excluded)', () => {
      // Regression: an excluded path must not show up in `excluded[]`, otherwise
      // every commit touching it + a synced path would be a spurious partial.
      const result = classify(
        ['packages/x.ts', 'tooling/sync-with-public.sh'],
        spec(['packages', 'tooling'], ['tooling/sync-with-public.sh']),
      );
      expect(result).toEqual({ kind: 'clean', included: ['packages/x.ts'] });
    });
  });

  describe('reviewPaths', () => {
    test('a clean-looking commit that touches a reviewPath is classified partial', () => {
      expect(
        classify(
          ['tooling/workspace.gitconfig'],
          spec(['tooling'], [], ['tooling/workspace.gitconfig']),
        ),
      ).toEqual({
        kind: 'partial',
        included: ['tooling/workspace.gitconfig'],
        excluded: [],
        reviewRequired: ['tooling/workspace.gitconfig'],
      });
    });

    test('reviewPath contributions show up in reviewRequired list', () => {
      const result = classify(
        ['packages/a.ts', 'tooling/workspace.gitconfig'],
        spec(['packages', 'tooling'], [], ['tooling/workspace.gitconfig']),
      );
      expect(result).toEqual({
        kind: 'partial',
        included: ['packages/a.ts', 'tooling/workspace.gitconfig'],
        excluded: [],
        reviewRequired: ['tooling/workspace.gitconfig'],
      });
    });

    test('reviewRequired can coexist with excluded paths in one commit', () => {
      expect(
        classify(
          ['packages/a.ts', 'tooling/workspace.gitconfig', 'privpkgs/x.ts'],
          spec(['packages', 'tooling'], [], ['tooling/workspace.gitconfig']),
        ),
      ).toEqual({
        kind: 'partial',
        included: ['packages/a.ts', 'tooling/workspace.gitconfig'],
        excluded: ['privpkgs/x.ts'],
        reviewRequired: ['tooling/workspace.gitconfig'],
      });
    });
  });

  describe('prefix matching precision', () => {
    test('does not false-match partial directory names', () => {
      expect(classify(['packages-rc/x.ts'], spec(['packages']))).toEqual({ kind: 'out-of-scope' });
    });

    test('supports multiple syncPaths', () => {
      expect(
        classify(['packages/cli/a.ts', 'tooling/b.sh', 'README.md'], spec(['packages', 'tooling'])),
      ).toEqual({
        kind: 'partial',
        included: ['packages/cli/a.ts', 'tooling/b.sh'],
        excluded: ['README.md'],
        reviewRequired: [],
      });
    });

    test('treats subdir pathspec strictly', () => {
      expect(classify(['tooling/direnv/a.sh'], spec(['tooling/direnv']))).toEqual({
        kind: 'clean',
        included: ['tooling/direnv/a.sh'],
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
    classification: { kind: 'clean', included: ['packages/x.ts'] },
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
      excluded: ['README.md'],
      reviewRequired: [],
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

  test('adjacent partials produce back-to-back partial segments with no empty range between', () => {
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
