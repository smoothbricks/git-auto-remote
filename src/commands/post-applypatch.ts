import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitDir } from '../lib/git.js';
import { clearMirrorInProgress, getMirrorInProgress, updateTrackingRef } from '../lib/mirror-state.js';

// v0.7.0 CRIT-3/MEDIUM-4 (see 2026-04-18-audit.md): Validation failures must
// clear the sentinel defensively to prevent stuck-state. We emit stderr warnings
// so operators can diagnose hook misconfiguration or git state corruption.

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
  if (!existsSync(applyDir)) {
    // v0.7.0 CRIT-3 (see 2026-04-18-audit.md): missing rebase-apply means we
    // can't make progress; clear sentinel defensively to avoid stuck state.
    console.error('[post-applypatch] rebase-apply directory missing, clearing sentinel');
    try { clearMirrorInProgress(); } catch { /* ignore */ }
    return 0;
  }

  const nextPath = join(applyDir, 'next');
  if (!existsSync(nextPath)) {
    // v0.7.0 CRIT-3 (see 2026-04-18-audit.md): missing next file means we can't
    // identify which patch was applied; clear sentinel defensively.
    console.error('[post-applypatch] rebase-apply/next missing, clearing sentinel');
    try { clearMirrorInProgress(); } catch { /* ignore */ }
    return 0;
  }
  const next = Number.parseInt(readFileSync(nextPath, 'utf8').trim(), 10);
  if (!Number.isFinite(next) || next < 1) {
    // v0.7.0 CRIT-3 (see 2026-04-18-audit.md): malformed next counter prevents
    // progress tracking; clear sentinel defensively.
    console.error('[post-applypatch] rebase-apply/next malformed, clearing sentinel');
    try { clearMirrorInProgress(); } catch { /* ignore */ }
    return 0;
  }

  // Git fires post-applypatch AFTER the apply/commit but BEFORE bumping the
  // "next" counter, so at hook time `next` holds the patch that was just
  // applied (verified empirically with next=last=1 for a single-patch run).
  const justApplied = next;
  const patchFile = join(applyDir, String(justApplied).padStart(4, '0'));
  if (!existsSync(patchFile)) {
    // v0.7.0 CRIT-3 (see 2026-04-18-audit.md): missing patch file means we can't
    // extract the source SHA; clear sentinel defensively.
    console.error('[post-applypatch] patch file missing, clearing sentinel');
    try { clearMirrorInProgress(); } catch { /* ignore */ }
    return 0;
  }

  // First line of a format-patch output: "From <sha> Mon Sep 17 00:00:00 2001"
  const firstLine = readFileSync(patchFile, 'utf8').split('\n', 1)[0];
  const match = firstLine.match(/^From\s+([0-9a-f]{40})\s+/);
  if (!match) {
    // v0.7.0 CRIT-3 (see 2026-04-18-audit.md): malformed From header prevents
    // SHA extraction; clear sentinel defensively to avoid stuck state.
    console.error('[post-applypatch] patch lacks From <sha> header, clearing sentinel');
    try { clearMirrorInProgress(); } catch { /* ignore */ }
    return 0;
  }

  try {
    updateTrackingRef(remote, match[1]);
  } catch {
    // Best-effort: never fail the hook and stop the am run.
  }

  // If this patch IS the last one of the run, clear the sentinel. At hook
  // time `next` is the just-applied patch number (see above), so `next == last`
  // means we just applied the final patch.
  // v0.7.0 MEDIUM-4 (see 2026-04-18-audit.md): We use `>=` defensively. In normal
  // git operation `next > last` should never happen, but if git state becomes
  // corrupted (user intervention, abort/retry races), we still clear the sentinel
  // to prevent stuck-state. The `>` case is "impossible-but-defensive".
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
  } else {
    // v0.7.0 CRIT-3 (see 2026-04-18-audit.md): missing last file means we can't
    // determine if this is the final patch; clear sentinel defensively.
    console.error('[post-applypatch] rebase-apply/last missing, clearing sentinel');
    try { clearMirrorInProgress(); } catch { /* ignore */ }
  }

  return 0;
}
