import { describe, expect, test } from 'bun:test';
import { classify, segment, type ClassifiedCommit } from '../src/lib/classify.js';

describe('classify', () => {
  describe('when no paths fall inside syncPaths', () => {
    test('returns out-of-scope', () => {
      expect(classify(['README.md', 'package.json'], ['packages'])).toEqual({ kind: 'out-of-scope' });
    });

    test('returns out-of-scope for a commit with no changes', () => {
      expect(classify([], ['packages'])).toEqual({ kind: 'out-of-scope' });
    });
  });

  describe('when all paths are inside syncPaths', () => {
    test('returns clean', () => {
      expect(classify(['packages/cli/foo.ts', 'packages/mdx/bar.ts'], ['packages'])).toEqual({
        kind: 'clean',
        included: ['packages/cli/foo.ts', 'packages/mdx/bar.ts'],
      });
    });

    test('a bare sync path (no slash) matches exactly', () => {
      // A file exactly named "packages" at root - edge case, but we should match it
      expect(classify(['packages'], ['packages'])).toEqual({
        kind: 'clean',
        included: ['packages'],
      });
    });
  });

  describe('when paths straddle syncPaths and outside', () => {
    test('returns partial with both lists populated', () => {
      expect(
        classify(
          ['packages/cli/foo.ts', 'privpkgs/secret.ts', 'package.json'],
          ['packages'],
        ),
      ).toEqual({
        kind: 'partial',
        included: ['packages/cli/foo.ts'],
        excluded: ['privpkgs/secret.ts', 'package.json'],
      });
    });
  });

  describe('prefix matching precision', () => {
    test('does not false-match partial directory names', () => {
      // "packages-rc/x" must NOT match syncPaths=["packages"]
      expect(classify(['packages-rc/x.ts'], ['packages'])).toEqual({
        kind: 'out-of-scope',
      });
    });

    test('supports multiple syncPaths', () => {
      expect(
        classify(['packages/cli/a.ts', 'tooling/b.sh', 'README.md'], ['packages', 'tooling']),
      ).toEqual({
        kind: 'partial',
        included: ['packages/cli/a.ts', 'tooling/b.sh'],
        excluded: ['README.md'],
      });
    });

    test('treats subdir pathspec strictly', () => {
      expect(classify(['tooling/direnv/a.sh'], ['tooling/direnv'])).toEqual({
        kind: 'clean',
        included: ['tooling/direnv/a.sh'],
      });
      expect(classify(['tooling/other/a.sh'], ['tooling/direnv'])).toEqual({
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
    classification: { kind: 'partial', included: ['packages/x.ts'], excluded: ['README.md'] },
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
    // out-of-scope commits produce empty patches; git am --empty=drop handles them.
    // So from the segmenter's perspective, they just stay in the range.
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
