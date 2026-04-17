/**
 * Pure commit-classification logic used by mirror-pull to segment a commit
 * range into clean batches, out-of-scope commits, and partial commits that
 * need human (or handler) review.
 *
 * Each changed path falls into one of three buckets:
 *
 *   excludePaths (highest priority) -> dropped entirely: not included, not excluded.
 *                                      Never makes it into the patch.
 *   syncPaths                       -> included
 *   neither                         -> excluded (leaks private content if synced)
 *
 * A commit's classification:
 *
 *   no included paths                                       -> out-of-scope
 *   all included, none excluded, no review-required         -> clean
 *   otherwise (any excluded OR any review-required included) -> partial
 *
 * `reviewPaths` is a subset of paths within `included` whose changes should
 * always trigger a review pause, even when no excluded paths are touched.
 * Useful for shared files that are sensitive (e.g. workspace git config).
 */

export type PathSpec = {
  syncPaths: readonly string[];
  excludePaths: readonly string[];
  reviewPaths: readonly string[];
};

export type Classification =
  | { kind: 'out-of-scope' }
  | { kind: 'clean'; included: readonly string[] }
  | {
      kind: 'partial';
      included: readonly string[];
      excluded: readonly string[];
      reviewRequired: readonly string[];
    };

/**
 * @param changedPaths Paths touched by the commit (from `git diff-tree --name-only`).
 * @param spec         The fork-remote.<name>.* pathspec configuration.
 */
export function classify(changedPaths: readonly string[], spec: PathSpec): Classification {
  const included: string[] = [];
  const excluded: string[] = [];
  for (const p of changedPaths) {
    if (matchesAny(p, spec.excludePaths)) continue; // dropped entirely
    if (matchesAny(p, spec.syncPaths)) included.push(p);
    else excluded.push(p);
  }

  if (included.length === 0) return { kind: 'out-of-scope' };

  const reviewRequired = included.filter((p) => matchesAny(p, spec.reviewPaths));
  if (excluded.length === 0 && reviewRequired.length === 0) {
    return { kind: 'clean', included };
  }
  return { kind: 'partial', included, excluded, reviewRequired };
}

/** Path-prefix match: `path === spec` or `path` begins with `spec + '/'`. */
function matchesAny(path: string, specs: readonly string[]): boolean {
  return specs.some((s) => path === s || path.startsWith(s + '/'));
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
