import { spawnSync } from 'node:child_process';
import { applyReviewToWorktree } from '../lib/apply.js';
import { amInProgress, gitTry, hasStagedChanges, hasUnresolvedMergeConflicts, workingTreeDirty } from '../lib/git.js';
import { getMirrorConfig } from '../lib/mirror-config.js';
import {
  clearMirrorInProgress,
  clearPendingCommit,
  clearReviewPending,
  getMirrorInProgress,
  getPendingCommit,
  getReviewPending,
  type ReviewPendingState,
  setReviewPending,
} from '../lib/mirror-state.js';
import { mirrorPull } from './mirror-pull.js';

/**
 * Unified resume command. Works across all three partial-pause sub-cases and
 * the plain-range `git am` conflict case:
 *
 *   - `git am` in progress (plain range OR phase 'am-in-progress'):
 *       runs `git am --continue`. If the pending-review state says this source
 *       also had review content, transitions to phase 'review-pause' (overlays
 *       review diff to worktree) and pauses again.
 *
 *   - phase 'review-pause':
 *       amends HEAD with any staged review content (author + author-date
 *       preserved by --no-edit, committer date is updated to now - inherent
 *       to git, not fixable), discards any unstaged review leftovers, and
 *       resumes `mirror pull` from where the tracking ref now sits.
 *
 *   - phase 'pure-review-pause':
 *       creates a fresh commit using the source's author/email/date/message
 *       if the index has staged content, else no-op commit-wise. Discards
 *       unstaged review leftovers and resumes.
 */
export async function mirrorContinue(remoteArg?: string): Promise<number> {
  // --- am conflict path (plain range OR phase 'am-in-progress' partial) ---
  if (amInProgress()) {
    return continueAm(remoteArg);
  }

  // --- review-pause / pure-review-pause ---
  const review = getReviewPending();
  if (!review) {
    console.error(`[git-auto-remote] Nothing to continue (no active sync pause).`);
    return 1;
  }
  const remote = remoteArg ?? review.remote;
  if (remote !== review.remote) {
    console.error(`[git-auto-remote] Pending review is for '${review.remote}', not '${remote}'.`);
    return 1;
  }

  if (review.phase === 'review-pause') {
    return continueReviewPause(remote, review.review);
  }
  if (review.phase === 'pure-review-pause') {
    return continuePureReviewPause(remote, review.review);
  }
  // phase === 'am-in-progress' but amInProgress() returned false: an earlier
  // `git am --continue` must have finished without going through our wrapper
  // (e.g. user ran it by hand). Treat as if we just transitioned; fall through
  // to the post-am transition logic.
  return postAmTransition(remote, review);
}

/**
 * Run `git am --continue`. After successful completion, decide whether to
 * transition into a review-pause (if the source also had review paths) or
 * simply auto-resume the next `mirror pull` iteration.
 */
async function continueAm(remoteArg?: string): Promise<number> {
  const sentinelRemote = getMirrorInProgress();
  const remote = sentinelRemote ?? remoteArg;
  if (!remote) {
    console.error(`[git-auto-remote] 'git am' is in progress but no mirror sentinel set and no remote given.`);
    console.error(`Usage: git-auto-remote mirror continue <remote>`);
    return 1;
  }
  if (remoteArg && sentinelRemote && sentinelRemote !== remoteArg) {
    console.error(`[git-auto-remote] sentinel says am is for '${sentinelRemote}', not '${remoteArg}'.`);
    return 1;
  }

  // Pre-check A: unresolved merge conflicts present. `git am --continue`
  // would refuse with its own error; surface a cleaner message pointing at
  // the resolution workflow rather than running git and seeing its output.
  if (hasUnresolvedMergeConflicts()) {
    console.error(`[mirror ${remote}] There are still unresolved merge conflicts.`);
    console.error(`[mirror ${remote}]   Edit the files, 'git add' the resolutions, then re-run 'mirror continue'.`);
    console.error(`[mirror ${remote}]   Check conflicted files:  git diff --name-only --diff-filter=U`);
    return 1;
  }

  // Pre-check B: am stopped structurally (no merge markers, nothing staged).
  // `git am --continue` would fail with "no changes - did you forget to use
  // 'git add'?" which misleads the user into hunting for nonexistent
  // conflicts. Redirect them to `mirror skip`.
  if (!hasStagedChanges()) {
    console.error(`[mirror ${remote}] 'git am' is in progress but there are no conflict markers to resolve`);
    console.error(`[mirror ${remote}]   and nothing is staged. The patch likely references content missing`);
    console.error(`[mirror ${remote}]   from HEAD (rename source, mode change, etc.). Recover with:`);
    console.error(`    git-auto-remote mirror skip ${remote}   # drop this commit, continue replay`);
    console.error(`    git am --show-current-patch=diff          # inspect the failing patch`);
    console.error(`    git am --abort                            # bail out entirely`);
    return 1;
  }

  // `git am --continue` fires post-applypatch which advances the tracking ref.
  const r = spawnSync('git', ['am', '--continue'], { stdio: 'inherit' });
  if ((r.status ?? 0) !== 0) {
    // Continue failed (likely unresolved merge markers). Leave state alone.
    return r.status ?? 1;
  }

  // More patches in the stream with their own conflicts? Stop here.
  if (amInProgress()) {
    console.error(
      `[mirror ${remote}] am still in progress on another patch; resolve + 'mirror continue', or 'mirror skip'.`,
    );
    return 0;
  }

  clearMirrorInProgress();

  // If there's a review-pending marker at phase 'am-in-progress', transition
  // to 'review-pause' (this source had review content to overlay on top of
  // the just-applied included subset).
  const review = getReviewPending();
  if (review && review.phase === 'am-in-progress' && review.remote === remote) {
    return postAmTransition(remote, review);
  }

  return mirrorPull({ remote });
}

/**
 * Transition from am-in-progress to review-pause: overlay the review subset to
 * the working tree unstaged and pause for the user to stage/discard.
 */
async function postAmTransition(remote: string, reviewState: ReviewPendingState): Promise<number> {
  if (reviewState.review.length === 0) {
    // No review content to overlay; just resume.
    clearReviewPending();
    return mirrorPull({ remote });
  }
  const mirror = getMirrorConfig(remote);
  const excludePaths = mirror?.excludePaths ?? [];
  const overlay = applyReviewToWorktree(reviewState.sourceSha, reviewState.review, excludePaths);
  if (overlay === 'error') {
    console.error(
      `[mirror ${remote}]   (failed to overlay review paths; inspect with: git show ${reviewState.sourceSha.slice(0, 8)})`,
    );
  } else if (overlay === 'conflict') {
    console.error(`[mirror ${remote}]   (some review-path hunks left conflict markers; resolve before continuing)`);
  } else if (overlay === 'fallback') {
    console.error(`[mirror ${remote}]   (review-path diff did not apply cleanly - worktree now has source's`);
    console.error(`[mirror ${remote}]    version verbatim. 'git diff' shows the FULL local->source delta for`);
    console.error(`[mirror ${remote}]    each review path, not just this commit's change. Stage what you want.)`);
  }
  setReviewPending({ ...reviewState, phase: 'review-pause' });
  const short = reviewState.sourceSha.slice(0, 8);
  // Header: matches printPartialHeader format in mirror-pull.ts ('<sha>  <subject>').
  console.error(`[mirror ${remote}] Partial:  ${short}  ${reviewState.subject}`);
  if (reviewState.review.length > 0) {
    console.error(`  Review (in worktree, unstaged): ${reviewState.review.join(', ')}`);
  }
  if (reviewState.regenerate.length > 0) {
    console.error(`  Regenerate (auto-produced):     ${reviewState.regenerate.join(', ')}`);
  }
  if (reviewState.outside.length > 0) {
    console.error(`  Outside sync scope (dropped):   ${reviewState.outside.join(', ')}`);
  }
  // Footer: matches printPartialFooter format.
  console.error(``);
  console.error(`  Source:   ${short}  ${reviewState.subject}`);
  console.error(``);
  if (reviewState.review.length > 0) {
    console.error(`  Review:   git diff                              # see unstaged review content`);
    console.error(`  Stage:    git add -p                            # pick hunks into the commit`);
    console.error(`  Discard:  git restore <paths>                   # drop review hunks`);
  }
  console.error(`  Dropped:  git-auto-remote mirror diff ${remote}       # source-vs-HEAD, sync-domain scoped`);
  console.error(`  Show:     git-auto-remote mirror source ${remote}     # full 'git show' of the source commit`);
  console.error(``);
  console.error(`  Continue: git-auto-remote mirror continue ${remote}`);
  console.error(`  Skip:     git-auto-remote mirror skip ${remote}`);
  return 0;
}

/**
 * sub-case B resume: HEAD is the included-subset commit with the source's
 * author + author-date. If the user staged any review content, amend HEAD
 * to roll it in (--no-edit preserves author + author-date + message; committer
 * date is refreshed by git). Then discard unstaged review leftovers and
 * resume the sync.
 */
async function continueReviewPause(remote: string, reviewPaths: readonly string[]): Promise<number> {
  if (hasStagedChanges()) {
    // Amend HEAD: --no-edit keeps author name/email, author-date, and the
    // commit message; committer date is unavoidably refreshed by git.
    const r = spawnSync('git', ['commit', '--amend', '--no-edit'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if ((r.status ?? 0) !== 0) {
      console.error(`[mirror ${remote}] git commit --amend failed; leaving pause state intact.`);
      return r.status ?? 1;
    }
  }
  discardReviewPaths(reviewPaths);
  // If anything else (non-review) is dirty, bail out so the user notices.
  if (workingTreeDirty()) {
    console.error(
      `[mirror ${remote}] Working tree still has changes outside review paths; commit or stash before continuing.`,
    );
    return 1;
  }
  clearReviewPending();
  return mirrorPull({ remote });
}

/**
 * sub-case C resume: there is no HEAD commit to amend. If the user staged any
 * review content, create a fresh commit with the source's author/date/message
 * (via GIT_AUTHOR_* env vars). Otherwise no-op (Q2a: silent skip-equivalent).
 * Tracking ref was already advanced to source SHA when the pause was entered.
 */
async function continuePureReviewPause(remote: string, reviewPaths: readonly string[]): Promise<number> {
  const pending = getPendingCommit();
  if (hasStagedChanges()) {
    if (!pending) {
      console.error(
        `[mirror ${remote}] Pure-review pause is active but pending-commit metadata is missing; refusing to guess author/date.`,
      );
      return 1;
    }
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: pending.authorName,
      GIT_AUTHOR_EMAIL: pending.authorEmail,
      GIT_AUTHOR_DATE: pending.authorDate,
    };
    const r = spawnSync('git', ['commit', '-q', '-m', pending.message], {
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if ((r.status ?? 0) !== 0) {
      console.error(`[mirror ${remote}] git commit (preserved metadata) failed; leaving pause state intact.`);
      return r.status ?? 1;
    }
  }
  discardReviewPaths(reviewPaths);
  if (workingTreeDirty()) {
    console.error(
      `[mirror ${remote}] Working tree still has changes outside review paths; commit or stash before continuing.`,
    );
    return 1;
  }
  clearPendingCommit();
  clearReviewPending();
  return mirrorPull({ remote });
}

/**
 * Revert a list of reviewPaths to HEAD state (or remove them if they don't
 * exist in HEAD). Covers: unstaged modifications, untracked files that `git
 * apply` created, and stray deletions. Errors are swallowed because some paths
 * may not need resetting (e.g. already clean).
 */
function discardReviewPaths(paths: readonly string[]): void {
  if (paths.length === 0) return;
  // restore resets staged + unstaged to HEAD for tracked paths, and deletes
  // paths that don't exist in HEAD. Swallow errors: paths that are already
  // clean or that restore can't process are fine.
  gitTry('restore', '--staged', '--worktree', '--source=HEAD', '--', ...paths);
  // Remove any untracked files/dirs that `git apply` created.
  gitTry('clean', '-fd', '--', ...paths);
}
