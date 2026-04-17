import { describe, expect, test } from 'bun:test';
import { splitPassthroughArgs } from '../src/lib/cli-args.js';

/**
 * Regression guard for CLI arg parsing of `mirror diff` / `mirror source`.
 *
 * Earlier versions (v0.5.5) ran these subcommands through node's parseArgs
 * with strict:false, which ATE unknown flags (like `--stat` or `--raw`) by
 * placing them in `values` rather than leaving them in positionals. User-
 * visible symptom: `mirror diff --stat` silently dropped `--stat`, producing
 * a full unified diff instead of the requested stat summary, and the user
 * was forced to type `mirror diff -- --stat` (extra `--`) to work around it.
 *
 * v0.5.6 fix: special-case `mirror diff` and `mirror source` in cli.ts
 * BEFORE parseArgs, using `splitPassthroughArgs` to cleanly split off an
 * optional remote positional from a raw passthrough tail.
 */
describe('splitPassthroughArgs', () => {
  describe('no args', () => {
    test('empty → no remote, empty extraArgs', () => {
      expect(splitPassthroughArgs([])).toEqual({
        remote: undefined,
        extraArgs: [],
      });
    });
  });

  describe('remote only', () => {
    test('single non-dash positional is treated as the remote', () => {
      expect(splitPassthroughArgs(['private'])).toEqual({
        remote: 'private',
        extraArgs: [],
      });
    });
  });

  describe('flags only (no remote)', () => {
    test('`--stat` reaches mirrorDiff as extraArgs', () => {
      // Regression: this MUST NOT lose `--stat` to parseArgs.
      expect(splitPassthroughArgs(['--stat'])).toEqual({
        remote: undefined,
        extraArgs: ['--stat'],
      });
    });

    test('`--raw` reaches mirrorDiff as extraArgs', () => {
      expect(splitPassthroughArgs(['--raw'])).toEqual({
        remote: undefined,
        extraArgs: ['--raw'],
      });
    });

    test('multiple flags pass through in order', () => {
      expect(splitPassthroughArgs(['--raw', '--stat', '--name-only'])).toEqual({
        remote: undefined,
        extraArgs: ['--raw', '--stat', '--name-only'],
      });
    });
  });

  describe('remote + flags', () => {
    test('`private --stat` → remote=private, extraArgs=[--stat]', () => {
      expect(splitPassthroughArgs(['private', '--stat'])).toEqual({
        remote: 'private',
        extraArgs: ['--stat'],
      });
    });

    test('`private --raw --name-only`', () => {
      expect(splitPassthroughArgs(['private', '--raw', '--name-only'])).toEqual({
        remote: 'private',
        extraArgs: ['--raw', '--name-only'],
      });
    });
  });

  describe('edge cases', () => {
    test('dashless arg after a flag stays in extraArgs (not pulled out as remote)', () => {
      // Only the FIRST arg can be the remote. Anything after a flag is raw.
      expect(splitPassthroughArgs(['--stat', 'maybe-a-path'])).toEqual({
        remote: undefined,
        extraArgs: ['--stat', 'maybe-a-path'],
      });
    });

    test('git-style `-- <pathspec>` passes through intact', () => {
      // User explicitly uses `--` to separate git-diff flags from pathspec.
      expect(splitPassthroughArgs(['private', '--', 'some/path'])).toEqual({
        remote: 'private',
        extraArgs: ['--', 'some/path'],
      });
    });

    test('`-- --stat` (the v0.5.5 workaround) still works', () => {
      expect(splitPassthroughArgs(['--', '--stat'])).toEqual({
        remote: undefined,
        extraArgs: ['--', '--stat'],
      });
    });

    test('remote name that accidentally starts with dash is NOT extracted', () => {
      // Defensive: if someone names a git remote `-weird`, we still treat it
      // as a flag. Matches the heuristic used everywhere in the tool.
      expect(splitPassthroughArgs(['-weird'])).toEqual({
        remote: undefined,
        extraArgs: ['-weird'],
      });
    });
  });
});
