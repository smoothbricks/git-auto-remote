import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Regression coverage for the per-subcommand help system added in v0.6.2.
 *
 * Pre-v0.6.2 (and pre-amend): every `--help` invocation printed a single
 * monolithic USAGE string, so `mirror status --help` showed the same content
 * as `--help` alone - no subcommand-specific flag documentation. Worse, the
 * monolithic USAGE didn't list `--remotes` (added in v0.6.2 itself) until a
 * follow-up. This test locks in:
 *
 *   1. Per-subcommand help is reachable via `<command> [<sub>] --help`
 *   2. Help text for each entry actually mentions the subcommand's flags
 *   3. `mirror` (no sub) prints the mirror overview, not the global one
 *   4. Unknown flags are rejected (strict mode), not silently swallowed
 *
 * Tests run the CLI as a subprocess so the dispatch pipeline is exercised
 * end-to-end.
 *
 * The CLI is dispatched by commander, whose help formatting differs from the
 * hand-rolled help from earlier drafts:
 *   - Section headers are `Usage:`, `Options:`, `Commands:`, `Arguments:`
 *     (NOT "Flags:" / "Subcommands:" / "Positional:")
 *   - Unknown-option errors are `error: unknown option '--<name>'`
 *   - Unknown-command errors are `error: unknown command '<name>'`
 * These assertions verify the underlying contract (flag is documented, typo
 * is rejected, etc.) rather than the exact cosmetic framing.
 */

const CLI = join(__dirname, '..', 'src', 'cli.ts');

function run(...args: string[]): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: r.status ?? -1,
  };
}

describe('global --help', () => {
  test('no args prints global overview, exit 0', () => {
    const { stdout, status } = run();
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: git-auto-remote');
    expect(stdout).toContain('Commands:');
    // Both core and mirror commands appear in the top-level command list
    expect(stdout).toContain('setup');
    expect(stdout).toContain('mirror');
  });

  test('--help prints global overview, exit 0', () => {
    const { stdout, status } = run('--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: git-auto-remote');
  });

  test('-h prints global overview, exit 0', () => {
    const { stdout, status } = run('-h');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: git-auto-remote');
  });
});

describe('mirror subcommand help', () => {
  test('mirror (no sub) prints mirror overview not global, exit 0', () => {
    const { stdout, status } = run('mirror');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: git-auto-remote mirror');
    expect(stdout).toContain('Commands:');
    expect(stdout).toContain('bootstrap');
    expect(stdout).toContain('pull');
    // Must NOT be the global overview: top-level-only commands like `setup`,
    // `detect`, `uninstall` should not appear in the mirror subcommand list.
    expect(stdout).not.toContain('setup');
    expect(stdout).not.toContain('post-checkout');
  });

  test('mirror --help prints mirror overview, exit 0', () => {
    const { stdout, status } = run('mirror', '--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: git-auto-remote mirror');
  });

  test('mirror status --help shows --remotes flag with description', () => {
    const { stdout, status } = run('mirror', 'status', '--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: git-auto-remote mirror status');
    expect(stdout).toContain('--remotes');
    // Description includes drift legend in `addHelpText('after', ...)` block
    expect(stdout).toContain('matches local');
    expect(stdout).toContain('differs from local');
    expect(stdout).toContain('ls-remote');
  });

  test('mirror pull --help shows all its flags', () => {
    const { stdout, status } = run('mirror', 'pull', '--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: git-auto-remote mirror pull');
    expect(stdout).toContain('--non-interactive');
    expect(stdout).toContain('--on-partial');
    // Mentions the env vars passed to the handler
    expect(stdout).toContain('MIRROR_SOURCE_SHA');
  });

  test('mirror bootstrap --help shows --force + security caveat', () => {
    const { stdout, status } = run('mirror', 'bootstrap', '--help');
    expect(status).toBe(0);
    expect(stdout).toContain('--force');
    expect(stdout).toContain('SECURITY');
  });

  test('mirror diff --help shows --raw', () => {
    const { stdout, status } = run('mirror', 'diff', '--help');
    expect(status).toBe(0);
    expect(stdout).toContain('--raw');
  });

  test('mirror foobar prints unknown-command error, exit 1', () => {
    const { stderr, status } = run('mirror', 'foobar');
    expect(status).toBe(1);
    // Commander's standard unknown-subcommand error format
    expect(stderr).toContain("unknown command 'foobar'");
  });
});

describe('non-mirror subcommand help', () => {
  test('setup --help shows --quiet', () => {
    const { stdout, status } = run('setup', '--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: git-auto-remote setup');
    expect(stdout).toContain('--quiet');
  });

  test('status --help does not advertise any tool-specific flags', () => {
    const { stdout, status } = run('status', '--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: git-auto-remote status');
    // Only the built-in --help option should be present; --quiet, --force, etc.
    // must not leak from sibling subcommands.
    expect(stdout).not.toContain('--quiet');
    expect(stdout).not.toContain('--force');
    expect(stdout).not.toContain('--non-interactive');
  });

  test('detect --help shows the [ref] positional', () => {
    const { stdout, status } = run('detect', '--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: git-auto-remote detect');
    expect(stdout).toContain('ref');
  });

  test('uninstall --help shows the marker-block removal description', () => {
    const { stdout, status } = run('uninstall', '--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: git-auto-remote uninstall');
    expect(stdout).toContain('marker block');
  });
});

describe('strict flag parsing (v0.6.2)', () => {
  test('unknown flag --remote (typo for --remotes) is rejected, exit 1', () => {
    const { stderr, status } = run('mirror', 'status', '--remote');
    expect(status).toBe(1);
    // Commander's standard unknown-option error format
    expect(stderr).toContain("unknown option '--remote'");
    // Commander auto-suggests the closest valid option
    expect(stderr).toContain('--remotes');
  });

  test('unknown flag --bogus is rejected, exit 1', () => {
    const { stderr, status } = run('mirror', 'list', '--bogus');
    expect(status).toBe(1);
    expect(stderr).toContain("unknown option '--bogus'");
  });
});
