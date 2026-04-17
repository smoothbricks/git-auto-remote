import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitDir, gitTry } from './git.js';

const STATE_SUBDIR = 'git-auto-remote';
const IN_PROGRESS_FILE = 'mirror-in-progress';
const REVIEW_PENDING_FILE = 'review-pending';

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
 * State recorded when a partial commit has been applied and the tool paused
 * for human review. Subsequent `mirror continue`/`mirror skip` read this.
 */
export type ReviewPendingState = {
  remote: string;
  sourceSha: string;
  subject: string;
  included: readonly string[];
  excluded: readonly string[];
};

export function setReviewPending(state: ReviewPendingState): void {
  writeFileSync(join(stateDir(), REVIEW_PENDING_FILE), JSON.stringify(state, null, 2));
}

export function getReviewPending(): ReviewPendingState | null {
  const p = join(stateDir(), REVIEW_PENDING_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function clearReviewPending(): void {
  const p = join(stateDir(), REVIEW_PENDING_FILE);
  if (existsSync(p)) rmSync(p);
}

/**
 * Tracking ref for "last commit of <remote>/<branch> that has been replayed
 * into this clone". Lives under a dedicated namespace so it never collides
 * with normal branches/tags.
 */
export function trackingRefName(remote: string): string {
  return `refs/git-auto-remote/mirror/${remote}`;
}

export function readTrackingRef(remote: string): string | null {
  return gitTry('rev-parse', '--verify', '--quiet', trackingRefName(remote));
}

export function updateTrackingRef(remote: string, sha: string): void {
  git('update-ref', trackingRefName(remote), sha);
}

export function deleteTrackingRef(remote: string): void {
  gitTry('update-ref', '-d', trackingRefName(remote));
}
