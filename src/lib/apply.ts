import { execFileSync, spawnSync } from 'node:child_process';
import { amInProgress, commitSubject, gitTry } from './git.js';
import type { ClassifiedCommit } from './classify.js';

/**
 * Apply a range of clean/out-of-scope commits via `git format-patch | git am`.
 *
 *   git format-patch --stdout <sha>^..<sha> -- <syncPaths>
 *      :(exclude)<excludePaths>
 *      :(exclude)<reviewPaths>
 *      :(exclude)<regeneratePaths>
 *      |  git am --empty=drop --3way
 *
 * Out-of-scope commits produce empty patches and are dropped by `--empty=drop`.
 * Paths matching `excludePaths`, `reviewPaths`, or `regeneratePaths` are
 * filtered out at patch-generation time via git's `:(exclude)` pathspec magic
 * so HEAD contains ONLY the `included` bucket. ReviewPaths go to the worktree
 * via `applyReviewToWorktree`; regeneratePaths get (re-)produced locally by
 * `regenerateCommand` after the apply succeeds.
 *
 * IMPORTANT - why the range form `<sha>^..<sha>` rather than `-1 <sha>`:
 * `git format-patch -1 <sha> -- <pathspec>` walks BACKWARD through ancestors
 * when <sha> doesn't touch any file in the pathspec, and emits the first
 * ancestor that does. For a mirror-sync pipeline this is catastrophic: the
 * next out-of-scope commit after a just-skipped partial would silently
 * regenerate the skipped partial's patch and stream it back into `git am`,
 * leading to "am-skip doesn't advance, same commit keeps reappearing". The
 * range form `<sha>^..<sha>` anchors the walk to a single commit, so empty
 * patches stay empty. Root commits (no `^` parent) fall back to
 * `--root -1 <sha>` which has the same one-commit guarantee.
 *
 * After each invocation we verify the `From <sha>` header of the output
 * matches the SHA we asked for; any mismatch is treated as 'error' rather
 * than silently producing the wrong patches.
 *
 * @returns
 *   'applied'  - entire batch applied cleanly
 *   'conflict' - git am stopped mid-range; `.git/rebase-apply` is still present
 *   'error'    - something unexpected (git missing, malformed patch, SHA mismatch)
 */
export function applyRange(
  commits: readonly ClassifiedCommit[],
  syncPaths: readonly string[],
  excludePaths: readonly string[] = [],
  reviewPaths: readonly string[] = [],
  regeneratePaths: readonly string[] = [],
): 'applied' | 'conflict' | 'error' {
  if (commits.length === 0) return 'applied';

  const pathspec = [
    ...syncPaths,
    ...excludePaths.map((p) => `:(exclude)${p}`),
    ...reviewPaths.map((p) => `:(exclude)${p}`),
    ...regeneratePaths.map((p) => `:(exclude)${p}`),
  ];

  const chunks: Buffer[] = [];
  for (const c of commits) {
    const chunk = formatPatchExact(c.sha, pathspec);
    if (chunk === null) return 'error';
    chunks.push(chunk);
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

/**
 * Emit exactly ONE commit's patch, filtered by pathspec, without letting git's
 * pathspec-walking behavior emit an ancestor's patch when the commit itself
 * doesn't touch the pathspec.
 *
 * Returns null on git error (propagated as 'error' by the caller) or on the
 * safety-check failure (From SHA in output does not match the input SHA).
 * An empty Buffer is a valid successful return value (commit didn't touch
 * anything in pathspec).
 */
function formatPatchExact(sha: string, pathspec: readonly string[]): Buffer | null {
  const hasParent = gitTry('rev-parse', '--verify', '--quiet', `${sha}^`) !== null;
  const revArgs = hasParent ? [`${sha}^..${sha}`] : ['--root', '-1', sha];

  let buf: Buffer;
  try {
    buf = execFileSync('git', ['format-patch', '--stdout', ...revArgs, '--', ...pathspec], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }

  if (buf.length === 0) return buf; // empty == commit had nothing in scope, fine.

  // Safety check: the patch's "From <sha>" header must match what we asked
  // for. If it doesn't, git has walked to an ancestor somehow and we refuse
  // to blindly pass the wrong patches into `git am`.
  const firstLine = buf.toString('utf8', 0, Math.min(buf.length, 256)).split('\n', 1)[0];
  const m = firstLine.match(/^From\s+([0-9a-f]{40})\s+/);
  if (!m || m[1] !== sha) {
    console.error(
      `[git-auto-remote] format-patch safety: asked for ${sha.slice(0, 8)} but got ${m ? m[1].slice(0, 8) : 'no From header'} - refusing to pass mismatched patches to git am.`,
    );
    return null;
  }
  return buf;
}

/** Apply a single partial commit's in-scope (`included`) changes to HEAD. */
export function applyPartial(
  sha: string,
  syncPaths: readonly string[],
  excludePaths: readonly string[] = [],
  reviewPaths: readonly string[] = [],
  regeneratePaths: readonly string[] = [],
): 'applied' | 'conflict' | 'error' {
  return applyRange(
    [{ sha, classification: { kind: 'clean', included: [], regenerate: [] } }],
    syncPaths,
    excludePaths,
    reviewPaths,
    regeneratePaths,
  );
}

/**
 * Apply the `review`-bucket subset of a partial commit to the working tree as
 * UNSTAGED changes. Invoked after `applyPartial` lands the `included` subset
 * into HEAD, before pausing for human review. User can then `git add -p` /
 * `git restore` / `git commit --amend --no-edit` interactively.
 *
 * Conflict resolution follows `git apply --3way` semantics: if a review-path
 * hunk cannot be applied cleanly, conflict markers are left in the file and
 * the user resolves them before `mirror continue`.
 *
 * The empty-tree fallback for root commits uses the well-known empty-tree SHA
 * (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`).
 *
 * @returns
 *   'applied'  - diff applied cleanly, or was empty (nothing to do)
 *   'conflict' - some hunks left conflict markers in worktree files
 *   'error'    - git reported a failure we couldn't classify as conflict
 */
export function applyReviewToWorktree(
  sha: string,
  reviewPaths: readonly string[],
  excludePaths: readonly string[] = [],
): 'applied' | 'conflict' | 'error' {
  if (reviewPaths.length === 0) return 'applied';

  const pathspec = [...reviewPaths, ...excludePaths.map((p) => `:(exclude)${p}`)];

  const hasParent = gitTry('rev-parse', '--verify', '--quiet', `${sha}^`) !== null;
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const diffArgs = hasParent
    ? ['diff', '--binary', `${sha}^..${sha}`, '--', ...pathspec]
    : ['diff', '--binary', EMPTY_TREE, sha, '--', ...pathspec];

  let diffBuf: Buffer;
  try {
    diffBuf = execFileSync('git', diffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return 'error';
  }

  if (diffBuf.length === 0) return 'applied'; // nothing in scope

  // `git apply --3way` writes to the worktree AND the index (--3way implies
  // --index). We want review content UNSTAGED so `mirror continue` only
  // amends when the user explicitly `git add`s - so we unstage everything
  // `--3way` just touched. Use execFileSync with the list of pathspecs to
  // be precise.
  const apply = spawnSync('git', ['apply', '--3way'], {
    input: diffBuf,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  const applyStatus = apply.status;

  // Unstage any paths --3way may have staged. Use `git reset HEAD -- <paths>`
  // (rather than the reviewPaths pathspecs, which could be directories) by
  // discovering what's actually staged and resetting those entries. Safe even
  // if there's nothing staged.
  const stagedOut = gitTry('diff', '--cached', '--name-only');
  if (stagedOut) {
    const stagedPaths = stagedOut.split('\n').filter((p) => p.length > 0);
    if (stagedPaths.length > 0) {
      gitTry('reset', 'HEAD', '--', ...stagedPaths);
    }
  }

  if (applyStatus === 0) return 'applied';
  return 'conflict';
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
