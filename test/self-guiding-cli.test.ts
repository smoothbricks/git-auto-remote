import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * C1-h: self-guiding CLI. Asserts the two halves of the contract:
 *
 *   1. Every subcommand, on a terminal path, emits a trailing `Next:` line that
 *      names the exact command to run next (agents grep the `Next:` prefix).
 *   2. Every subcommand's `--help` carries a worked example, and the program
 *      `--help` carries a 'typical agent workflow' block.
 *
 * Plus: `mirror status` is a diagnostic + remediation surface (names a problem
 * and prints its exact fix).
 *
 * Runs the CLI as a subprocess (like help-dispatch.test.ts) so the dispatch +
 * asAction guidance pipeline is exercised end-to-end.
 */

const CLI = join(__dirname, '..', 'src', 'cli.ts');
const ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t' };

function cli(cwd: string, ...args: string[]): { stdout: string; stderr: string; status: number; all: string } {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { stdout, stderr, status: r.status ?? -1, all: stdout + stderr };
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, env: { ...process.env, ...ENV }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'gar-guide-'));
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'f.txt'), 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('self-guiding --help (C1-h)', () => {
  test("program --help carries a 'typical agent workflow' block", () => {
    const { stdout, status } = cli(repo, '--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Typical agent workflow');
    expect(stdout).toContain('git-auto-remote mirror ci');
  });

  const helpExamples: string[][] = [
    ['setup'],
    ['status'],
    ['detect'],
    ['uninstall'],
    ['mirror', 'list'],
    ['mirror', 'ci'],
    ['mirror', 'continue'],
    ['mirror', 'skip'],
    ['mirror', 'abort'],
    ['mirror', 'diff'],
    ['mirror', 'source'],
  ];
  for (const cmd of helpExamples) {
    test(`'${cmd.join(' ')} --help' shows a worked Example`, () => {
      const { stdout, status } = cli(repo, ...cmd, '--help');
      expect(status).toBe(0);
      expect(stdout).toContain('Example');
    });
  }
});

describe('trailing Next: line on every command (C1-h)', () => {
  const commands: string[][] = [
    ['setup'],
    ['status'],
    ['detect'],
    ['uninstall'],
    ['mirror', 'status'],
    ['mirror', 'list'],
    ['mirror', 'pull', 'upstream'],
    ['mirror', 'ci', 'no-such-remote'],
    ['mirror', 'bootstrap', 'upstream', 'HEAD'],
    ['mirror', 'continue'],
    ['mirror', 'skip'],
    ['mirror', 'abort'],
    ['mirror', 'diff'],
    ['mirror', 'source'],
  ];
  for (const cmd of commands) {
    test(`'${cmd.join(' ')}' prints a Next: line`, () => {
      const { all } = cli(repo, ...cmd);
      expect(all).toMatch(/Next: \S/);
    });
  }
});

describe('mirror status diagnostic + remediation (C1-h)', () => {
  test('no config: names the gap and prints the exact configure command', () => {
    const { stdout, stderr, status } = cli(repo, 'mirror', 'status');
    expect(status).toBe(0);
    expect(stdout).toContain('No mirrors configured');
    // Remediation + Next go to stderr.
    expect(stderr).toContain('auto-remote.<remote>.syncPaths');
    expect(stderr).toMatch(/Next: .*syncPaths/);
  });

  test('configured mirror without a tracking ref: names the problem + exact fix', () => {
    // Configure a mirror but never bootstrap/seed its tracking ref.
    git(repo, 'config', 'auto-remote.upstream.syncPaths', 'packages');
    git(repo, 'config', 'auto-remote.upstream.syncTargetBranch', 'main');

    const { stdout, stderr, status } = cli(repo, 'mirror', 'status', 'upstream');
    expect(status).toBe(0);
    // The status table still renders on stdout.
    expect(stdout).toContain('tracking:');
    // Remediation (stderr) names the problem and the exact fix command.
    expect(stderr).toContain('Diagnostics & remediation');
    expect(stderr).toContain("'upstream': no local tracking ref");
    expect(stderr).toContain('git-auto-remote mirror pull upstream');
    expect(stderr).toMatch(/Next: /);
  });
});
