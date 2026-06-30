import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPartialHandler } from '../src/lib/handler.js';

/**
 * C1-e: the partial handler must receive MIRROR_REGENERATE_PATHS (advertised in
 * cli --help but previously never set), alongside the other MIRROR_* env vars.
 */

let root: string;
let repo: string;
let capture: string;
let handler: string;
let originalCwd: string;

const ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t' };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: { ...process.env, ...ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stderr}`);
  return (r.stdout ?? '').trim();
}

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'gar-handler-'));
  repo = join(root, 'repo');
  capture = join(root, 'capture.env'); // OUTSIDE the repo, so writing it keeps the tree clean
  git(root, 'init', '-q', repo);
  writeFileSync(join(repo, 'seed.txt'), 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'seed');

  handler = join(root, 'handler.sh');
  // Dump every MIRROR_* var the handler can see; leave the worktree clean -> 'resolved'.
  writeFileSync(
    handler,
    `#!/usr/bin/env bash\n{\n  echo "REGEN=$MIRROR_REGENERATE_PATHS"\n  echo "INCLUDED=$MIRROR_INCLUDED_PATHS"\n  echo "REVIEW=$MIRROR_REVIEW_PATHS"\n  echo "OUTSIDE=$MIRROR_OUTSIDE_PATHS"\n  echo "REMOTE=$MIRROR_REMOTE"\n  echo "SHA=$MIRROR_SOURCE_SHA"\n} > "${capture}"\nexit 0\n`,
  );
  chmodSync(handler, 0o755);
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('partial handler env (C1-e)', () => {
  test('handler observes MIRROR_REGENERATE_PATHS', () => {
    const outcome = runPartialHandler(handler, {
      remote: 'public-repo',
      sourceSha: 'deadbeef',
      sourceSubject: 'feat: thing',
      includedPaths: ['packages/a.ts'],
      reviewPaths: ['tooling/x.conf'],
      regeneratePaths: ['bun.lock', 'tsconfig.json'],
      outsidePaths: ['README.md'],
    });
    expect(outcome).toBe('resolved');
    const env = readFileSync(capture, 'utf8');
    expect(env).toContain('REGEN=bun.lock\ntsconfig.json');
    expect(env).toContain('INCLUDED=packages/a.ts');
    expect(env).toContain('REVIEW=tooling/x.conf');
    expect(env).toContain('OUTSIDE=README.md');
  });
});
