import { execFileSync, spawnSync } from 'node:child_process';
import { amInProgress, commitSubject } from './git.js';
import type { ClassifiedCommit } from './classify.js';

/**
 * Apply a range of clean/out-of-scope commits via `git format-patch | git am`.
 *
 *   git format-patch <first>^..<last> --stdout -- <syncPaths>  |  git am --empty=drop --3way
 *
 * Out-of-scope commits produce empty patches and are dropped by `--empty=drop`.
 *
 * @returns
 *   'applied'  - entire range applied cleanly
 *   'conflict' - git am stopped mid-range; `.git/rebase-apply` is still present
 *   'error'    - something unexpected (e.g. git missing, malformed patch)
 */
export function applyRange(
  commits: readonly ClassifiedCommit[],
  syncPaths: readonly string[],
): 'applied' | 'conflict' | 'error' {
  if (commits.length === 0) return 'applied';

  const first = commits[0].sha;
  const last = commits[commits.length - 1].sha;

  const formatArgs = ['format-patch', `${first}^..${last}`, '--stdout', '--', ...syncPaths];
  let patchBuf: Buffer;
  try {
    patchBuf = execFileSync('git', formatArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return 'error';
  }

  // All patches are empty (pathspec excluded everything) -> nothing to do
  if (patchBuf.length === 0) return 'applied';

  const amResult = spawnSync('git', ['am', '--empty=drop', '--3way'], {
    input: patchBuf,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  if (amResult.status === 0) return 'applied';
  // `git am` stops mid-range on conflict and leaves .git/rebase-apply/
  if (amInProgress()) return 'conflict';
  return 'error';
}

/**
 * Apply a single partial commit's in-scope changes. Same mechanism as a range
 * of length 1, but separated for clarity and for per-partial output formatting.
 */
export function applyPartial(
  sha: string,
  syncPaths: readonly string[],
): 'applied' | 'conflict' | 'error' {
  return applyRange([{ sha, classification: { kind: 'clean', included: [] } }], syncPaths);
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
