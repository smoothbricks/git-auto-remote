import { execFileSync, spawnSync } from 'node:child_process';
import { amInProgress, commitSubject } from './git.js';
import type { ClassifiedCommit } from './classify.js';

/**
 * Apply a range of clean/out-of-scope commits via `git format-patch | git am`.
 *
 *   git format-patch --stdout <sha1> <sha2> ... -- <syncPaths> :(exclude)...  |  git am --empty=drop --3way
 *
 * Out-of-scope commits produce empty patches and are dropped by `--empty=drop`.
 * Paths matching `excludePaths` are filtered out at the patch-generation stage
 * via git's `:(exclude)` pathspec magic.
 *
 * Unlike the range form `first^..last`, passing explicit SHAs works even when
 * `first` is a root commit (no `^` parent), which is essential for replaying
 * a full history on first-time bootstrap.
 *
 * @returns
 *   'applied'  - entire batch applied cleanly
 *   'conflict' - git am stopped mid-range; `.git/rebase-apply` is still present
 *   'error'    - something unexpected (e.g. git missing, malformed patch)
 */
export function applyRange(
  commits: readonly ClassifiedCommit[],
  syncPaths: readonly string[],
  excludePaths: readonly string[] = [],
): 'applied' | 'conflict' | 'error' {
  if (commits.length === 0) return 'applied';

  const pathspec = [...syncPaths, ...excludePaths.map((p) => `:(exclude)${p}`)];

  // Generate one patch per commit. We can't pass all SHAs in a single
  // `format-patch --stdout <shas>` because that form treats each argument as
  // "emit patches from upstream default up to this SHA" rather than "just this
  // SHA". `-1 <sha>` reliably emits exactly one patch and works for root
  // commits (where `<sha>^..<sha>` would fail).
  const chunks: Buffer[] = [];
  for (const c of commits) {
    try {
      chunks.push(
        execFileSync('git', ['format-patch', '-1', '--stdout', c.sha, '--', ...pathspec], {
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    } catch {
      return 'error';
    }
  }
  const patchBuf = Buffer.concat(chunks);

  // All patches empty (pathspec matched nothing) -> nothing to do.
  if (patchBuf.length === 0) return 'applied';

  const amResult = spawnSync('git', ['am', '--empty=drop', '--3way'], {
    input: patchBuf,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  if (amResult.status === 0) return 'applied';
  if (amInProgress()) return 'conflict';
  return 'error';
}

/** Apply a single partial commit's in-scope changes. */
export function applyPartial(
  sha: string,
  syncPaths: readonly string[],
  excludePaths: readonly string[] = [],
): 'applied' | 'conflict' | 'error' {
  return applyRange(
    [{ sha, classification: { kind: 'clean', included: [] } }],
    syncPaths,
    excludePaths,
  );
}

/** Pretty-print "Applying: <subject>" lines, mimicking `git am`'s own output. */
export function printApplyingLines(commits: readonly ClassifiedCommit[], remote: string): void {
  for (const c of commits) {
    const subject = commitSubject(c.sha);
    if (c.classification.kind === 'out-of-scope') {
      console.error(`[mirror ${remote}] Skipping (out of scope): ${subject}`);
    } else {
      console.error(`[mirror ${remote}] Applying: ${subject}`);
    }
  }
}

export function printSegmentSummary(
  remote: string,
  applied: number,
  skipped: number,
  stopReason: 'done' | 'partial' | 'conflict',
): void {
  const parts = [`applied ${applied}`];
  if (skipped > 0) parts.push(`skipped ${skipped} out-of-scope`);
  if (stopReason === 'done') parts.push('up-to-date');
  if (stopReason === 'partial') parts.push('stopped at partial (review required)');
  if (stopReason === 'conflict') parts.push('stopped at conflict');
  console.error(`[mirror ${remote}] ${parts.join(', ')}`);
}
