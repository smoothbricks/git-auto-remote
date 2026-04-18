import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postApplypatch } from '../src/commands/post-applypatch.js';
import { getMirrorInProgress, trackingRefName } from '../src/lib/mirror-state.js';

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

/**
 * Write a fake `.git/rebase-apply/` matching the state git leaves when it
 * fires post-applypatch AFTER applying the patch numbered `next` but BEFORE
 * bumping the counter. The patch file is placed at `<next>` zero-padded to 4.
 */
function writeRebaseApply(sha: string, next: number, last: number): string {
  const dir = join(repoDir, '.git', 'rebase-apply');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'next'), `${next}\n`);
  writeFileSync(join(dir, 'last'), `${last}\n`);
  const patchNum = String(next).padStart(4, '0');
  writeFileSync(
    join(dir, patchNum),
    `From ${sha} Mon Sep 17 00:00:00 2001\nFrom: t <t@t>\nSubject: [PATCH] x\n\n---\n`,
  );
  return dir;
}

describe('postApplypatch', () => {
  test('no-ops when sentinel is absent', () => {
    const sha = seedCommit();
    writeRebaseApply(sha, 1, 1);
    const code = postApplypatch();
    expect(code).toBe(0);
    // Tracking ref not created.
    const refList = execFileSync('git', ['for-each-ref', 'refs/git-auto-remote'], {
      cwd: repoDir,
      encoding: 'utf8',
    });
    expect(refList.trim()).toBe('');
  });

  test('updates tracking ref to From-SHA of just-applied patch (mid-run)', () => {
    const sha = seedCommit();
    mkdirSync(join(repoDir, '.git/git-auto-remote'), { recursive: true });
    writeFileSync(join(repoDir, '.git/git-auto-remote/mirror-in-progress'), 'upstream');
    // Mid-run of a 3-patch am: git just applied patch 2, next=2 (not yet bumped), last=3.
    writeRebaseApply(sha, 2, 3);

    const code = postApplypatch();
    expect(code).toBe(0);

    const trackingSha = execFileSync('git', ['rev-parse', TRACKING_UPSTREAM], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    expect(trackingSha).toBe(sha);

    // Sentinel still present - we're not yet on the last patch (next=2 < last=3).
    expect(existsSync(join(repoDir, '.git/git-auto-remote/mirror-in-progress'))).toBe(true);
  });

  test('readTrackingRef falls back to legacy single-component ref, then migrates on write', () => {
    const sha = seedCommit();
    // Simulate an old-style tracking ref from v0.3.1 or earlier.
    execFileSync('git', ['update-ref', 'refs/git-auto-remote/mirror/upstream', sha], {
      cwd: repoDir,
    });

    mkdirSync(join(repoDir, '.git/git-auto-remote'), { recursive: true });
    writeFileSync(join(repoDir, '.git/git-auto-remote/mirror-in-progress'), 'upstream');
    // Single-patch am: next=1, last=1 -> hook both advances ref and clears sentinel.
    writeRebaseApply(sha, 1, 1);

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

  test('clears the sentinel when this is the last patch (next == last)', () => {
    const sha = seedCommit();
    mkdirSync(join(repoDir, '.git/git-auto-remote'), { recursive: true });
    writeFileSync(join(repoDir, '.git/git-auto-remote/mirror-in-progress'), 'upstream');
    // Single-patch am at hook time: next=1 (just applied, not yet bumped), last=1.
    writeRebaseApply(sha, 1, 1);

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

  // v0.7.0 CRIT-3/MEDIUM-4 validation hardening tests (see 2026-04-18-audit.md)
  describe('validation failures clear sentinel defensively (CRIT-3)', () => {
    test('malformed rebase-apply/next emits warning + clears sentinel (T2-PAP-01)', () => {
      const sha = seedCommit();
      mkdirSync(join(repoDir, '.git/git-auto-remote'), { recursive: true });
      writeFileSync(join(repoDir, '.git/git-auto-remote/mirror-in-progress'), 'upstream');

      const dir = join(repoDir, '.git', 'rebase-apply');
      mkdirSync(dir, { recursive: true });
      // Write malformed "next" file (not a valid number)
      writeFileSync(join(dir, 'next'), 'abc\n');
      writeFileSync(join(dir, 'last'), '1\n');
      const patchNum = String(1).padStart(4, '0');
      writeFileSync(
        join(dir, patchNum),
        `From ${sha} Mon Sep 17 00:00:00 2001\nFrom: t <t@t>\nSubject: [PATCH] x\n\n---\n`,
      );

      const code = postApplypatch();
      expect(code).toBe(0);
      // Sentinel cleared defensively since we can't make progress
      expect(getMirrorInProgress()).toBeNull();
    });

    test('missing rebase-apply/last emits warning + clears sentinel (T2-PAP-02)', () => {
      const sha = seedCommit();
      mkdirSync(join(repoDir, '.git/git-auto-remote'), { recursive: true });
      writeFileSync(join(repoDir, '.git/git-auto-remote/mirror-in-progress'), 'upstream');

      const dir = join(repoDir, '.git', 'rebase-apply');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'next'), '1\n');
      // Intentionally NOT writing 'last' file to simulate corruption
      const patchNum = String(1).padStart(4, '0');
      writeFileSync(
        join(dir, patchNum),
        `From ${sha} Mon Sep 17 00:00:00 2001\nFrom: t <t@t>\nSubject: [PATCH] x\n\n---\n`,
      );

      const code = postApplypatch();
      expect(code).toBe(0);
      // Tracking ref should still be updated (patch was valid)
      const trackingSha = execFileSync('git', ['rev-parse', TRACKING_UPSTREAM], {
        cwd: repoDir,
        encoding: 'utf8',
      }).trim();
      expect(trackingSha).toBe(sha);
      // Sentinel cleared because we can't determine if this is the last patch
      expect(getMirrorInProgress()).toBeNull();
    });

    test('patch file first line lacks From <40hex> emits warning (T2-PAP-03)', () => {
      mkdirSync(join(repoDir, '.git/git-auto-remote'), { recursive: true });
      writeFileSync(join(repoDir, '.git/git-auto-remote/mirror-in-progress'), 'upstream');

      const dir = join(repoDir, '.git', 'rebase-apply');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'next'), '1\n');
      writeFileSync(join(dir, 'last'), '1\n');
      // Write patch file WITHOUT proper From header
      writeFileSync(
        join(dir, '0001'),
        'Subject: Bad patch header\nFrom: t <t@t>\n\nThis patch lacks a proper From line\n',
      );

      const code = postApplypatch();
      expect(code).toBe(0);
      // Sentinel cleared defensively since we can't extract SHA to update tracking
      expect(getMirrorInProgress()).toBeNull();
    });

    test('next > last (impossible-but-defensive) clears sentinel (T2-PAP-06)', () => {
      const sha = seedCommit();
      mkdirSync(join(repoDir, '.git/git-auto-remote'), { recursive: true });
      writeFileSync(join(repoDir, '.git/git-auto-remote/mirror-in-progress'), 'upstream');

      const dir = join(repoDir, '.git', 'rebase-apply');
      mkdirSync(dir, { recursive: true });
      // Impossible state: next > last (shouldn't happen but we handle defensively)
      writeFileSync(join(dir, 'next'), '5\n');
      writeFileSync(join(dir, 'last'), '3\n');
      const patchNum = String(5).padStart(4, '0');
      writeFileSync(
        join(dir, patchNum),
        `From ${sha} Mon Sep 17 00:00:00 2001\nFrom: t <t@t>\nSubject: [PATCH] x\n\n---\n`,
      );

      const code = postApplypatch();
      expect(code).toBe(0);
      // Tracking should still advance
      const trackingSha = execFileSync('git', ['rev-parse', TRACKING_UPSTREAM], {
        cwd: repoDir,
        encoding: 'utf8',
      }).trim();
      expect(trackingSha).toBe(sha);
      // Sentinel cleared because next >= last (defensive >= choice)
      expect(getMirrorInProgress()).toBeNull();
    });
  });
});
