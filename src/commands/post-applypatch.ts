import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitDir } from '../lib/git.js';
import { clearMirrorInProgress, getMirrorInProgress, updateTrackingRef } from '../lib/mirror-state.js';

/**
 * Git's `post-applypatch` hook runs after each patch `git am` successfully applies.
 * We use it to advance `refs/git-auto-remote/mirror/<remote>` to the source SHA of
 * the just-applied patch. This makes sync state recoverable if `git am` conflicts
 * mid-range (the user resolves, `--continue`s, and the hook continues advancing).
 *
 * Gated by the `mirror-in-progress` sentinel so unrelated user-initiated `git am`
 * invocations are left alone.
 */
export function postApplypatch(): number {
  const remote = getMirrorInProgress();
  if (!remote) return 0; // not our invocation

  const applyDir = join(gitDir(), 'rebase-apply');
  if (!existsSync(applyDir)) return 0;

  const nextPath = join(applyDir, 'next');
  if (!existsSync(nextPath)) return 0;
  const next = Number.parseInt(readFileSync(nextPath, 'utf8').trim(), 10);
  if (!Number.isFinite(next) || next < 1) return 0;

  // Git fires post-applypatch AFTER the apply/commit but BEFORE bumping the
  // "next" counter, so at hook time `next` holds the patch that was just
  // applied (verified empirically with next=last=1 for a single-patch run).
  const justApplied = next;
  const patchFile = join(applyDir, String(justApplied).padStart(4, '0'));
  if (!existsSync(patchFile)) return 0;

  // First line of a format-patch output: "From <sha> Mon Sep 17 00:00:00 2001"
  const firstLine = readFileSync(patchFile, 'utf8').split('\n', 1)[0];
  const match = firstLine.match(/^From\s+([0-9a-f]{40})\s+/);
  if (!match) return 0;

  try {
    updateTrackingRef(remote, match[1]);
  } catch {
    // Best-effort: never fail the hook and stop the am run.
  }

  // If this patch IS the last one of the run, clear the sentinel. At hook
  // time `next` is the just-applied patch number (see above), so `next == last`
  // means we just applied the final patch.
  const lastPath = join(applyDir, 'last');
  if (existsSync(lastPath)) {
    const last = Number.parseInt(readFileSync(lastPath, 'utf8').trim(), 10);
    if (Number.isFinite(last) && next >= last) {
      try {
        clearMirrorInProgress();
      } catch {
        // ignore
      }
    }
  }

  return 0;
}
