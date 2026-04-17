import { describe, expect, test } from 'bun:test';
import { decideRouting, type Remote, validatePush } from '../src/lib/routing.js';

describe('decideRouting', () => {
  describe('when no remotes are configured', () => {
    test('returns no-remotes', () => {
      expect(decideRouting([], () => false, null)).toEqual({ kind: 'no-remotes' });
    });
  });

  describe('when all remotes share the same root set (mirrors / single upstream)', () => {
    const mirrors: Remote[] = [
      { name: 'origin', roots: ['r1'] },
      { name: 'backup', roots: ['r1'] },
    ];

    test('returns shared-history with null inherited remote', () => {
      expect(decideRouting(mirrors, () => true, null)).toEqual({
        kind: 'shared-history',
        inheritedRemote: null,
      });
    });

    test('propagates the inherited remote from previous HEAD', () => {
      expect(decideRouting(mirrors, () => true, 'backup')).toEqual({
        kind: 'shared-history',
        inheritedRemote: 'backup',
      });
    });

    test('treats a single remote as shared-history regardless of ancestry', () => {
      const single: Remote[] = [{ name: 'origin', roots: ['r1'] }];
      expect(decideRouting(single, () => false, null)).toEqual({
        kind: 'shared-history',
        inheritedRemote: null,
      });
    });
  });

  describe('when remotes have disjoint root sets (fork scenario)', () => {
    const forks: Remote[] = [
      { name: 'private', roots: ['priv-root'] },
      { name: 'public', roots: ['pub-root'] },
    ];

    test('routes to the single matching fork', () => {
      expect(decideRouting(forks, (sha) => sha === 'priv-root', null)).toEqual({
        kind: 'single-match',
        remote: 'private',
      });
    });

    test('returns no-match when HEAD does not descend from any fork', () => {
      expect(decideRouting(forks, () => false, null)).toEqual({ kind: 'no-match' });
    });

    test('refuses to route when HEAD descends from multiple forks', () => {
      expect(decideRouting(forks, () => true, null)).toEqual({
        kind: 'multi-match',
        remotes: ['private', 'public'],
      });
    });

    test('ignores the inherited remote in fork scenarios - ancestry wins', () => {
      expect(decideRouting(forks, (sha) => sha === 'pub-root', 'private')).toEqual({
        kind: 'single-match',
        remote: 'public',
      });
    });
  });

  describe('when a remote has multiple root commits', () => {
    const remotes: Remote[] = [
      { name: 'multi', roots: ['r1', 'r2'] },
      { name: 'other', roots: ['r3'] },
    ];

    test('matches if any of its roots is an ancestor', () => {
      expect(decideRouting(remotes, (sha) => sha === 'r2', null)).toEqual({
        kind: 'single-match',
        remote: 'multi',
      });
    });
  });
});

describe('validatePush', () => {
  const forks: Remote[] = [
    { name: 'private', roots: ['priv-root'] },
    { name: 'public', roots: ['pub-root'] },
  ];

  test('allows push when all refs descend from the target remote', () => {
    const result = validatePush(
      'public',
      forks,
      [{ localRef: 'refs/heads/feat', localSha: 'abc' }],
      (ancestor, _descendant) => ancestor === 'pub-root',
    );
    expect(result).toBeNull();
  });

  test('rejects push when a ref does not descend from the target remote', () => {
    const result = validatePush(
      'public',
      forks,
      [{ localRef: 'refs/heads/leak', localSha: 'abc' }],
      (ancestor, _descendant) => ancestor === 'priv-root',
    );
    expect(result).toContain("does not descend from 'public'");
    expect(result).toContain('private');
  });

  test('allows ref deletion (all-zero sha)', () => {
    const result = validatePush(
      'public',
      forks,
      [{ localRef: 'refs/heads/old', localSha: '0000000000000000000000000000000000000000' }],
      () => false,
    );
    expect(result).toBeNull();
  });

  test('is a no-op when all remotes share roots (mirror scenario)', () => {
    const mirrors: Remote[] = [
      { name: 'origin', roots: ['r1'] },
      { name: 'backup', roots: ['r1'] },
    ];
    const result = validatePush('origin', mirrors, [{ localRef: 'refs/heads/x', localSha: 'abc' }], () => false);
    expect(result).toBeNull();
  });

  test('is a no-op when target remote is unknown', () => {
    const result = validatePush('unknown', forks, [{ localRef: 'refs/heads/x', localSha: 'abc' }], () => false);
    expect(result).toBeNull();
  });

  test('is a no-op when target remote has no detected roots', () => {
    const remotes: Remote[] = [
      { name: 'nofetch', roots: [] },
      { name: 'other', roots: ['r1'] },
    ];
    const result = validatePush('nofetch', remotes, [{ localRef: 'refs/heads/x', localSha: 'abc' }], () => false);
    expect(result).toBeNull();
  });
});
