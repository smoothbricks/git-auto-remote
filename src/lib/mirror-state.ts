import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitDir, gitTry } from './git.js';

const STATE_SUBDIR = 'git-auto-remote';
const IN_PROGRESS_FILE = 'mirror-in-progress';
const REVIEW_PENDING_FILE = 'review-pending';
const PENDING_COMMIT_FILE = 'pending-commit';

function stateDir(): string {
  const dir = join(gitDir(), STATE_SUBDIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Sentinel file set before launching `git am` as part of a mirror sync. The
 * post-applypatch hook uses this to tell "our am" apart from a user's unrelated
 * `git am` invocation (which must be left alone).
 */
export function setMirrorInProgress(remote: string): void {
  writeFileSync(join(stateDir(), IN_PROGRESS_FILE), remote);
}

export function getMirrorInProgress(): string | null {
  const p = join(stateDir(), IN_PROGRESS_FILE);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8').trim() || null;
}

export function clearMirrorInProgress(): void {
  const p = join(stateDir(), IN_PROGRESS_FILE);
  if (existsSync(p)) rmSync(p);
}

/**
 * State recorded when a partial commit pause is active. The `phase` drives
 * how `mirror continue` / `mirror skip` transition out of the pause:
 *
 *   am-in-progress    - `git am` stopped in the middle of the included-subset
 *                       patch with conflicts; user resolves + `mirror continue`
 *                       runs `git am --continue`. If this source also had review
 *                       paths, continue then transitions to `review-pause`.
 *   review-pause      - included subset landed in HEAD (via `git am`, so author
 *                       and author-date preserved); review subset sits in the
 *                       worktree unstaged via `git apply --3way`. Continue =
 *                       `git commit --amend --no-edit` if index was touched.
 *                       Skip = discard worktree + `git reset --hard HEAD~1`.
 *   pure-review-pause - source touched ONLY review paths; no HEAD commit was
 *                       made (included bucket was empty). Review content is
 *                       in worktree unstaged and the source's author/date/msg
 *                       are stored alongside (see pending-commit). Continue =
 *                       create a fresh commit preserving author+author-date if
 *                       the user staged anything; else no-op. Skip = discard
 *                       worktree. Both advance tracking past the source SHA.
 */
export type ReviewPendingPhase = 'am-in-progress' | 'review-pause' | 'pure-review-pause';

export type ReviewPendingState = {
  remote: string;
  sourceSha: string;
  subject: string;
  included: readonly string[];
  review: readonly string[];
  regenerate: readonly string[];
  outside: readonly string[];
  phase: ReviewPendingPhase;
};

export function setReviewPending(state: ReviewPendingState): void {
  writeFileSync(join(stateDir(), REVIEW_PENDING_FILE), JSON.stringify(state, null, 2));
}

/**
 * Read the review-pending state. Tolerant to state written by pre-0.3.7 versions
 * (which used `excluded` / `reviewRequired` fields and no `phase`): missing fields
 * are returned as empty arrays and an absent `phase` defaults to `review-pause`.
 */
export function getReviewPending(): ReviewPendingState | null {
  const p = join(stateDir(), REVIEW_PENDING_FILE);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    return {
      remote: String(raw.remote ?? ''),
      sourceSha: String(raw.sourceSha ?? ''),
      subject: String(raw.subject ?? ''),
      included: asStringArray(raw.included),
      review: asStringArray(raw.review ?? raw.reviewRequired),
      regenerate: asStringArray(raw.regenerate),
      outside: asStringArray(raw.outside ?? raw.excluded),
      phase: isPhase(raw.phase) ? raw.phase : 'review-pause',
    };
  } catch {
    return null;
  }
}

function asStringArray(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function isPhase(v: unknown): v is ReviewPendingPhase {
  return v === 'am-in-progress' || v === 'review-pause' || v === 'pure-review-pause';
}

export function clearReviewPending(): void {
  const p = join(stateDir(), REVIEW_PENDING_FILE);
  if (existsSync(p)) rmSync(p);
}

/**
 * Metadata for a pure-review-pause commit that has not yet been made. Read by
 * `mirror continue` (sub-case C) to preserve author name/email/date and the
 * original commit message when the user stages review content and proceeds.
 */
export type PendingCommit = {
  remote: string;
  sourceSha: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  message: string;
};

export function setPendingCommit(p: PendingCommit): void {
  writeFileSync(join(stateDir(), PENDING_COMMIT_FILE), JSON.stringify(p, null, 2));
}

export function getPendingCommit(): PendingCommit | null {
  const p = join(stateDir(), PENDING_COMMIT_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PendingCommit;
  } catch {
    return null;
  }
}

export function clearPendingCommit(): void {
  const p = join(stateDir(), PENDING_COMMIT_FILE);
  if (existsSync(p)) rmSync(p);
}

/**
 * Tracking ref for "last commit of <remote>/<branch> that has been replayed
 * into this clone". Lives under a dedicated namespace, with a trailing
 * `last-synced` component so short-name resolution (e.g. `git log <remote>`)
 * does NOT pick up this ref as a candidate - otherwise a tracking ref named
 * after a remote that also has a local branch of the same name (e.g. the
 * 'private' branch on a 'private' remote) triggers "refname is ambiguous"
 * warnings on every git invocation.
 */
export function trackingRefName(remote: string): string {
  return `refs/git-auto-remote/mirror/${remote}/last-synced`;
}

/** Legacy (v0.3.1 and earlier) ref location, kept so we can migrate. */
function legacyTrackingRefName(remote: string): string {
  return `refs/git-auto-remote/mirror/${remote}`;
}

export function readTrackingRef(remote: string): string | null {
  // Check the new location first; fall back to the legacy single-component
  // location so existing clones continue to work until the next write.
  const fromNew = gitTry('rev-parse', '--verify', '--quiet', trackingRefName(remote));
  if (fromNew) return fromNew;
  return gitTry('rev-parse', '--verify', '--quiet', legacyTrackingRefName(remote));
}

export function updateTrackingRef(remote: string, sha: string): void {
  // Migration: if the legacy ref exists, delete it FIRST. Git treats refs as
  // files, so `refs/X/Y/Z` cannot coexist with `refs/X/Y` as a ref - creating
  // the new name would fail with "cannot lock ref" otherwise.
  gitTry('update-ref', '-d', legacyTrackingRefName(remote));
  git('update-ref', trackingRefName(remote), sha);
}

export function deleteTrackingRef(remote: string): void {
  gitTry('update-ref', '-d', trackingRefName(remote));
  gitTry('update-ref', '-d', legacyTrackingRefName(remote));
}
