import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postApplypatch } from '../src/commands/post-applypatch.js';
import { trackingRefName } from '../src/lib/mirror-state.js';

const TRACKING_UPSTREAM = trackingRefName('upstream');

/**
 * Direct unit tests for the post-applypatch handler. We fake a `.git/rebase-apply`
 * directory and invoke the handler - this is what git would do after each patch.
 */

let repoDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  repoDir = mkdtempSync(join(tmpdir(), 'gar-post-applypatch-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  process.chdir(repoDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(repoDir, { recursive: true, force: true });
});

/** Seed a commit so we can advance refs to it. Returns its SHA. */
function seedCommit(): string {
  writeFileSync(join(repoDir, 'f.txt'), 'seed\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed'],
    { cwd: repoDir },
  );
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
}

function writeRebaseApply(sha: string, next: number, last: number): string {
  const dir = join(repoDir, '.git', 'rebase-apply');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'next'), `${next}\n`);
  writeFileSync(join(dir, 'last'), `${last}\n`);
  const patchNum = String(next - 1).padStart(4, '0');
  writeFileSync(
    join(dir, patchNum),
    `From ${sha} Mon Sep 17 00:00:00 2001\nFrom: t <t@t>\nSubject: [PATCH] x\n\n---\n`,
  );
  return dir;
}

describe('postApplypatch', () => {
  test('no-ops when sentinel is absent', () => {
    const sha = seedCommit();
    writeRebaseApply(sha, 2, 1);
    const code = postApplypatch();
    expect(code).toBe(0);
    // Tracking ref not created.
    const refList = execFileSync('git', ['for-each-ref', 'refs/git-auto-remote'], {
      cwd: repoDir,
      encoding: 'utf8',
    });
    expect(refList.trim()).toBe('');
  });

  test('updates tracking ref to From-SHA of just-applied patch', () => {
    const sha = seedCommit();
    // Set sentinel
    mkdirSync(join(repoDir, '.git/git-auto-remote'), { recursive: true });
    writeFileSync(join(repoDir, '.git/git-auto-remote/mirror-in-progress'), 'upstream');
    writeRebaseApply(sha, 2, 3); // next=2, last=3 -> we are in the middle of a 3-patch run

    const code = postApplypatch();
    expect(code).toBe(0);

    const trackingSha = execFileSync(
      'git',
      ['rev-parse', TRACKING_UPSTREAM],
      { cwd: repoDir, encoding: 'utf8' },
    ).trim();
    expect(trackingSha).toBe(sha);

    // Sentinel still present - we're not yet on the last patch.
    expect(existsSync(join(repoDir, '.git/git-auto-remote/mirror-in-progress'))).toBe(true);
  });

  test('readTrackingRef falls back to legacy single-component ref, then migrates on write', () => {
    const sha = seedCommit();
    // Simulate an old-style tracking ref from v0.3.1 or earlier.
    execFileSync('git', ['update-ref', 'refs/git-auto-remote/mirror/upstream', sha], {
      cwd: repoDir,
    });

    // First, the hook reads via getMirrorInProgress... but to exercise
    // readTrackingRef path, we piggyback on the existing "advance + clear"
    // flow: set sentinel, run hook with next=2 last=1 -> advance + clear.
    mkdirSync(join(repoDir, '.git/git-auto-remote'), { recursive: true });
    writeFileSync(join(repoDir, '.git/git-auto-remote/mirror-in-progress'), 'upstream');
    writeRebaseApply(sha, 2, 1);

    postApplypatch();

    // New ref got the value.
    const newSha = execFileSync('git', ['rev-parse', TRACKING_UPSTREAM], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    expect(newSha).toBe(sha);

    // Legacy ref is gone (migrated away). `rev-parse --verify` exits non-zero
    // when the ref is missing, so use spawnSync to tolerate that.
    const legacyCheck = Bun.spawnSync({
      cmd: ['git', 'rev-parse', '--verify', '--quiet', 'refs/git-auto-remote/mirror/upstream'],
      cwd: repoDir,
    });
    expect(legacyCheck.exitCode).not.toBe(0);
  });

  test('clears the sentinel when this is the last patch (next > last)', () => {
    const sha = seedCommit();
    mkdirSync(join(repoDir, '.git/git-auto-remote'), { recursive: true });
    writeFileSync(join(repoDir, '.git/git-auto-remote/mirror-in-progress'), 'upstream');
    // last=1, next=2 -> we just applied patch 1 of 1, the run is done.
    writeRebaseApply(sha, 2, 1);

    const code = postApplypatch();
    expect(code).toBe(0);

    // Ref still advanced.
    const trackingSha = execFileSync(
      'git',
      ['rev-parse', TRACKING_UPSTREAM],
      { cwd: repoDir, encoding: 'utf8' },
    ).trim();
    expect(trackingSha).toBe(sha);

    // Sentinel gone.
    expect(existsSync(join(repoDir, '.git/git-auto-remote/mirror-in-progress'))).toBe(false);
  });
});
