import { execFileSync, spawnSync } from 'node:child_process';
import { rewriteCommitterToAuthor } from './commit-rewrite.js';
import { closeSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { amInProgress, commitSubject, gitTry, hasUnresolvedMergeConflicts, revParse } from './git.js';
import type { ClassifiedCommit } from './classify.js';

/**
 * Apply a range of clean/out-of-scope commits via `git format-patch | git am`.
 *
 *   git format-patch --stdout <first>^..<last> -- <syncPaths>
 *      :(exclude)<excludePaths>
 *      :(exclude)<reviewPaths>
 *      :(exclude)<regeneratePaths>
 *      >  /tmp/patches.mbox
 *   git am --empty=drop --3way /tmp/patches.mbox
 *
 * Patches are written to a temp file via fd redirection — no Node buffering,
 * no maxBuffer limit, works for any patch size.
 *
 * Out-of-scope commits produce empty patches and are dropped by `--empty=drop`.
 * Paths matching `excludePaths`, `reviewPaths`, or `regeneratePaths` are
 * filtered out at patch-generation time via git's `:(exclude)` pathspec magic
 * so HEAD contains ONLY the `included` bucket. ReviewPaths go to the worktree
 * via `applyReviewToWorktree`; regeneratePaths get (re-)produced locally by
 * `regenerateCommand` after the apply succeeds.
 *
 * The range form `<first>^..<last>` anchors the walk precisely; git cannot
 * silently emit an ancestor's patch (the `-1 <sha>` footgun, see commit
 * history). Root commits (no `^` parent) use `--root <last>`.
 *
 * @returns
 *   'applied'  - entire batch applied cleanly
 *   'conflict' - git am stopped mid-range; `.git/rebase-apply` is still present
 *   'error'    - something unexpected (git missing, format-patch failure, etc.)
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

  // Generate patches to a temp file via fd — no Node buffering, no maxBuffer.
  const firstSha = commits[0].sha;
  const lastSha = commits[commits.length - 1].sha;
  const hasParent = gitTry('rev-parse', '--verify', '--quiet', `${firstSha}^`) !== null;
  const rangeArgs = hasParent ? [`${firstSha}^..${lastSha}`] : ['--root', lastSha];

  const tmpPatch = join(tmpdir(), `gar-${process.pid}-${Date.now()}.mbox`);
  let fd: number;
  try {
    fd = openSync(tmpPatch, 'w');
  } catch (e) {
    console.error(`[git-auto-remote] failed to create temp patch file: ${(e as Error).message}`);
    return 'error';
  }

  const fpResult = spawnSync('git', ['format-patch', '--stdout', ...rangeArgs, '--', ...pathspec], {
    stdio: ['ignore', fd, 'pipe'],
  });
  closeSync(fd);

  if (fpResult.status !== 0) {
    const stderr = fpResult.stderr ? fpResult.stderr.toString().trim() : '';
    console.error(
      `[git-auto-remote] format-patch failed (exit ${fpResult.status ?? '?'}, signal ${fpResult.signal ?? 'none'})${stderr ? ': ' + stderr : ''}`,
    );
    try { rmSync(tmpPatch, { force: true }); } catch { /* ignore */ }
    return 'error';
  }

  // Empty file means pathspec matched nothing across the entire range.
  try {
    const size = statSync(tmpPatch).size;
    if (size === 0) {
      rmSync(tmpPatch, { force: true });
      return 'applied';
    }
  } catch {
    // stat failed — fall through and let git am deal with it
  }

  // Capture HEAD before git am so we can rewrite just the new commits'
  // committer identities afterwards (v0.6.0 invariant: committer = author
  // across all commits this tool creates).
  const headBefore = revParse('HEAD');

  const amResult = spawnSync('git', ['am', '--empty=drop', '--3way', tmpPatch], {
    stdio: 'inherit',
  });
  try { rmSync(tmpPatch, { force: true }); } catch { /* ignore */ }

  if (amResult.status === 0) {
    if (headBefore) {
      try {
        rewriteCommitterToAuthor(headBefore, 'HEAD');
      } catch (e) {
        console.error(`[git-auto-remote] committer rewrite failed after git am: ${(e as Error).message}`);
        return 'error';
      }
    }
    return 'applied';
  }
  if (amInProgress()) return 'conflict';
  console.error(
    `[git-auto-remote] git am exited ${amResult.status ?? '?'} (signal ${amResult.signal ?? 'none'}) without leaving a conflict state.`,
  );
  return 'error';
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
 * Three-state return distinguishes behaviour for the pause message:
 *
 *   'applied'     - diff applied cleanly, worktree now has unstaged delta the
 *                   user can `git add -p` through. Also the "nothing to do"
 *                   case (empty diff).
 *
 *   'conflict'    - `git apply --3way` left conflict markers in some files.
 *                   User resolves (edits + git add) before `mirror continue`.
 *
 *   'fallback'    - `git apply --3way` REFUSED the diff entirely (base content
 *                   missing, no common ancestor blob available locally, etc.)
 *                   and wrote NOTHING. Rather than pausing with an empty
 *                   worktree (user has nothing to review), we fall back to
 *                   writing each review path's CURRENT-VERSION-AT-SOURCE blob
 *                   directly into the worktree - the user sees `git diff`
 *                   showing the full delta between local content and source's
 *                   version, and can `git add -p` the hunks they want.
 *                   Source-deletions reflect as file removals.
 *
 *   'error'       - something unexpected (git missing, IO failure, etc.).
 *
 * The empty-tree fallback for root commits uses the well-known empty-tree SHA
 * (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`).
 */
export function applyReviewToWorktree(
  sha: string,
  reviewPaths: readonly string[],
  excludePaths: readonly string[] = [],
): 'applied' | 'conflict' | 'fallback' | 'error' {
  if (reviewPaths.length === 0) return 'applied';

  const pathspec = [...reviewPaths, ...excludePaths.map((p) => `:(exclude)${p}`)];

  const hasParent = gitTry('rev-parse', '--verify', '--quiet', `${sha}^`) !== null;
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const diffArgs = hasParent
    ? ['diff', '--binary', `${sha}^..${sha}`, '--', ...pathspec]
    : ['diff', '--binary', EMPTY_TREE, sha, '--', ...pathspec];

  let diffBuf: Buffer;
  try {
    diffBuf = execFileSync('git', diffArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return 'error';
  }

  if (diffBuf.length === 0) return 'applied'; // nothing in scope

  // Primary path: `git apply --3way`. --3way implies --index (touches both
  // working tree AND index).
  const apply = spawnSync('git', ['apply', '--3way'], {
    input: diffBuf,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  const applyStatus = apply.status;

  // IMPORTANT: check conflict state BEFORE any index cleanup. `git reset
  // HEAD -- <path>` on an unmerged (stage 1/2/3) entry clears the U state
  // and reinitialises as stage 0 matching HEAD - which would hide a real
  // conflict from `hasUnresolvedMergeConflicts()`.
  if (applyStatus !== 0 && hasUnresolvedMergeConflicts()) {
    // --3way left conflict markers; leave the UU index entries alone so the
    // user's normal resolve-then-git-add workflow works as expected.
    return 'conflict';
  }

  // No unresolved merge state from here on. We want REVIEW content UNSTAGED
  // so `mirror continue` only amends when the user explicitly `git add`s.
  // Unstage ONLY the review paths - not everything in the index - because
  // v0.5.9 may have staged regenerate content BEFORE this function ran
  // (sub-case C: regen-staged-then-review-overlaid workflow). Blanket
  // `reset HEAD -- <all staged>` would wipe that regen staging.
  if (reviewPaths.length > 0) {
    gitTry('reset', 'HEAD', '--', ...reviewPaths);
  }

  if (applyStatus === 0) return 'applied';

  // Non-zero exit AND no unresolved markers: apply refused entirely (no
  // common ancestor blob or total mismatch; worktree unchanged). Fall back
  // to writing each review path's source-version blob directly to the
  // worktree so the user sees a `git diff` they can act on. Sacrifices the
  // "minimal delta" property of --3way (user sees FULL delta, not just the
  // commit's change), but strictly more information and preserves
  // interactivity - the alternative pauses with an empty worktree, leaving
  // the user nothing to review.
  const fallbackOk = writeSourceVerbatim(sha, reviewPaths);
  return fallbackOk ? 'fallback' : 'error';
}

/**
 * For each of `paths`, overwrite the working-tree entry with the source
 * commit's version (or delete it if the source doesn't contain that path).
 * Does NOT touch the index - all changes show up as unstaged.
 *
 * Used as the fallback for `applyReviewToWorktree` when `git apply --3way`
 * refuses a diff entirely (no common ancestor, base mismatch).
 *
 * Returns false if any path's write fails; true otherwise.
 */
function writeSourceVerbatim(sha: string, paths: readonly string[]): boolean {
  for (const path of paths) {
    const existsAtSource = (() => {
      try {
        execFileSync('git', ['cat-file', '-e', `${sha}:${path}`], {
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    })();

    if (existsAtSource) {
      let content: Buffer;
      try {
        content = execFileSync('git', ['show', `${sha}:${path}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        return false;
      }
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      } catch {
        return false;
      }
    } else {
      // Source doesn't contain this path - treat as deletion. Remove from
      // worktree if it exists locally. Missing-file errors are fine (the
      // file already not being there matches the source's "no such path").
      try {
        rmSync(path, { force: true });
      } catch {
        // swallow: best-effort, not fatal
      }
    }
  }
  return true;
}

/**
 * Pre-announce the commits about to be applied in this range. Printed before
 * `git am` runs so the user sees the plan. Out-of-scope commits are shown as
 * "Skipping:" (they produce empty patches dropped by `--empty=drop`).
 * In-scope commits are shown as "Will apply:" to distinguish from git am's
 * own "Applying:" lines that appear as each patch lands.
 */
export function printApplyingLines(commits: readonly ClassifiedCommit[], remote: string): void {
  for (const c of commits) {
    const subject = commitSubject(c.sha);
    const shortSha = c.sha.slice(0, 8);
    if (c.classification.kind === 'out-of-scope') {
      console.error(`[mirror ${remote}] Skipping:    ${shortSha}  ${subject}  (out of scope)`);
    } else {
      console.error(`[mirror ${remote}] Will apply:  ${shortSha}  ${subject}`);
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
