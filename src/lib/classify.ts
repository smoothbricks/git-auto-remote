/**
 * Pure commit-classification logic used by mirror-pull to segment a commit
 * range into clean batches, out-of-scope commits, and partial commits that
 * need human (or handler) review.
 *
 * A commit's paths are partitioned against the mirror's syncPaths allowlist:
 *   included = paths inside syncPaths
 *   excluded = paths outside syncPaths
 *
 *   included.length === 0                    -> out-of-scope (skip)
 *   excluded.length === 0 && included.length -> clean        (apply in range)
 *   both non-empty                           -> partial      (breaks the range)
 */

export type Classification =
  | { kind: 'out-of-scope' }
  | { kind: 'clean'; included: readonly string[] }
  | { kind: 'partial'; included: readonly string[]; excluded: readonly string[] };

/**
 * @param changedPaths  Paths touched by the commit (from `git diff-tree --name-only`).
 * @param syncPaths     The allowlist from `fork-remote.<name>.syncPaths`. Matched as a
 *                      path prefix: `syncPaths=["packages"]` matches `packages/x` and
 *                      the bare `packages` file/dir itself, but not `packages-rc`.
 */
export function classify(
  changedPaths: readonly string[],
  syncPaths: readonly string[],
): Classification {
  const included: string[] = [];
  const excluded: string[] = [];
  for (const p of changedPaths) {
    if (isInSyncPaths(p, syncPaths)) included.push(p);
    else excluded.push(p);
  }
  if (included.length === 0) return { kind: 'out-of-scope' };
  if (excluded.length === 0) return { kind: 'clean', included };
  return { kind: 'partial', included, excluded };
}

function isInSyncPaths(path: string, syncPaths: readonly string[]): boolean {
  return syncPaths.some((sp) => path === sp || path.startsWith(sp + '/'));
}

/**
 * A contiguous run of clean/out-of-scope commits that can be applied via a single
 * `git format-patch ... | git am` invocation. Out-of-scope commits produce empty
 * patches inside this range and are dropped by `git am --empty=drop`.
 */
export type RangeSegment = {
  kind: 'range';
  /** Commits in topological (oldest-first) order. */
  commits: readonly ClassifiedCommit[];
};

/** A single partial commit, which breaks any surrounding range and needs review. */
export type PartialSegment = {
  kind: 'partial';
  commit: ClassifiedCommit;
};

export type Segment = RangeSegment | PartialSegment;

export type ClassifiedCommit = {
  sha: string;
  classification: Classification;
};

/**
 * Group a sequence of classified commits into segments. Partials split the
 * sequence; consecutive clean/out-of-scope commits are batched together.
 */
export function segment(commits: readonly ClassifiedCommit[]): readonly Segment[] {
  const segments: Segment[] = [];
  let batch: ClassifiedCommit[] = [];

  const flush = () => {
    if (batch.length > 0) {
      segments.push({ kind: 'range', commits: batch });
      batch = [];
    }
  };

  for (const c of commits) {
    if (c.classification.kind === 'partial') {
      flush();
      segments.push({ kind: 'partial', commit: c });
    } else {
      batch.push(c);
    }
  }
  flush();
  return segments;
}
