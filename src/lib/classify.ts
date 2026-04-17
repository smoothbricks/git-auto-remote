/**
 * Pure commit-classification logic used by mirror-pull to segment a commit
 * range into clean batches, out-of-scope commits, and partial commits that
 * need human (or handler) review.
 *
 * Each changed path is sorted into exactly ONE of five buckets, in priority order:
 *
 *   1. matches `excludePaths`   -> dropped entirely (invisible to the rest of the pipeline)
 *   2. matches `reviewPaths`    -> `review`     (brought to worktree unstaged at pause time)
 *   3. matches `regeneratePaths`-> `regenerate` (dropped from HEAD; a configured command
 *                                                runs after apply and the command's output
 *                                                is amended into HEAD with author+author-date
 *                                                preserved)
 *   4. matches `syncPaths`      -> `included`   (applied to HEAD by `git am`)
 *   5. none of the above        -> `outside`    (silently dropped like excludePaths, but
 *                                                surfaced in the pause message so the user
 *                                                notices)
 *
 * All three of {reviewPaths, regeneratePaths, syncPaths} are first-class and orthogonal to
 * each other. A path in reviewPaths needn't also be in syncPaths. A regeneratePath is
 * typically NOT in syncPaths (it's an artifact like bun.lock that we don't want from
 * upstream, we want the one our own regen-command produces).
 *
 * A commit's classification:
 *
 *   all of {included, review, regenerate} empty  -> out-of-scope
 *     (outside alone doesn't matter: if nothing else is in scope, the whole commit is a
 *      no-op for this tool; skip it)
 *
 *   review and outside both empty                -> clean (auto-proceed)
 *     (included and/or regenerate may be non-empty; the regen-command runs after apply)
 *
 *   otherwise                                    -> partial (pause for review;
 *                                                  three sub-cases in mirror-pull.ts)
 */

export type PathSpec = {
  syncPaths: readonly string[];
  excludePaths: readonly string[];
  reviewPaths: readonly string[];
  regeneratePaths: readonly string[];
};

export type Classification =
  | { kind: 'out-of-scope' }
  | { kind: 'clean'; included: readonly string[]; regenerate: readonly string[] }
  | {
      kind: 'partial';
      included: readonly string[];
      review: readonly string[];
      regenerate: readonly string[];
      outside: readonly string[];
    };

/**
 * @param changedPaths Paths touched by the commit (from `git diff-tree --name-only`).
 * @param spec         The auto-remote.<name>.* pathspec configuration.
 */
export function classify(changedPaths: readonly string[], spec: PathSpec): Classification {
  const included: string[] = [];
  const review: string[] = [];
  const regenerate: string[] = [];
  const outside: string[] = [];

  for (const p of changedPaths) {
    if (matchesAny(p, spec.excludePaths)) continue; // bucket 1: dropped
    if (matchesAny(p, spec.reviewPaths)) {
      review.push(p); // bucket 2
      continue;
    }
    if (matchesAny(p, spec.regeneratePaths)) {
      regenerate.push(p); // bucket 3
      continue;
    }
    if (matchesAny(p, spec.syncPaths)) {
      included.push(p); // bucket 4
      continue;
    }
    outside.push(p); // bucket 5
  }

  // If there's nothing the tool can act on (no included, no review, no regenerate),
  // the commit is out-of-scope - any `outside` content gets silently dropped along
  // with the commit. Matches the intuition "if none of this commit would land in
  // HEAD or in the worktree, don't bother the user".
  if (included.length === 0 && review.length === 0 && regenerate.length === 0) {
    return { kind: 'out-of-scope' };
  }
  // Purely in-scope commit (possibly with regenerate content): auto-apply.
  if (review.length === 0 && outside.length === 0) {
    return { kind: 'clean', included, regenerate };
  }
  return { kind: 'partial', included, review, regenerate, outside };
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

/**
 * True iff any commit in the list has regenerate-bucket content. Used by
 * mirror-pull to decide whether to invoke `regenerateCommand` after a range
 * apply (partials use the commit's own regenerate list directly).
 */
export function anyHasRegenerate(commits: readonly ClassifiedCommit[]): boolean {
  return commits.some((c) => {
    const k = c.classification.kind;
    if (k === 'clean') return c.classification.regenerate.length > 0;
    if (k === 'partial') return c.classification.regenerate.length > 0;
    return false;
  });
}

