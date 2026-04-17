/**
 * Pure commit-classification logic used by mirror-pull to segment a commit
 * range into clean batches, out-of-scope commits, and partial commits that
 * need human (or handler) review.
 *
 * Each changed path is sorted into exactly ONE of four buckets, in priority order:
 *
 *   1. matches `excludePaths`  -> dropped entirely (invisible to the rest of the pipeline)
 *   2. matches `reviewPaths`   -> `review`   (brought to worktree unstaged at pause time)
 *   3. matches `syncPaths`     -> `included` (applied to HEAD by `git am`)
 *   4. none of the above       -> `outside`  (the "you forgot about this" bucket; dropped
 *                                              from HEAD and worktree, but surfaced in the
 *                                              pause message so the user can see it)
 *
 * `reviewPaths` is first-class and independent of `syncPaths`: a path may be a reviewPath
 * WITHOUT also being a syncPath (e.g. bun.lock configured to review but never auto-applied).
 *
 * A commit's classification:
 *
 *   included and review both empty    -> out-of-scope (nothing for the tool to do;
 *                                        any `outside` content gets silently dropped
 *                                        with the commit itself)
 *   only `included` non-empty         -> clean (auto-apply)
 *   otherwise                         -> partial (pause for review; three sub-cases
 *                                        distinguished at runtime by mirror-pull.ts)
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
      review: readonly string[];
      outside: readonly string[];
    };

/**
 * @param changedPaths Paths touched by the commit (from `git diff-tree --name-only`).
 * @param spec         The fork-remote.<name>.* pathspec configuration.
 */
export function classify(changedPaths: readonly string[], spec: PathSpec): Classification {
  const included: string[] = [];
  const review: string[] = [];
  const outside: string[] = [];

  for (const p of changedPaths) {
    if (matchesAny(p, spec.excludePaths)) continue; // bucket 1: dropped
    if (matchesAny(p, spec.reviewPaths)) {
      review.push(p); // bucket 2: review
      continue;
    }
    if (matchesAny(p, spec.syncPaths)) {
      included.push(p); // bucket 3: included
      continue;
    }
    outside.push(p); // bucket 4: outside
  }

  // If there's nothing the tool can actually act on (no included, no review),
  // the commit is out-of-scope - any `outside` content gets silently dropped
  // along with the commit. This matches the intuition "if none of this commit
  // would land in HEAD or in the worktree, don't bother the user".
  if (included.length === 0 && review.length === 0) {
    return { kind: 'out-of-scope' };
  }
  // Purely in-scope commit: auto-apply.
  if (review.length === 0 && outside.length === 0) {
    return { kind: 'clean', included };
  }
  return { kind: 'partial', included, review, outside };
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
