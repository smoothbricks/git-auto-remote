# P3-INTEGRATE Integration Notes

**Agent**: P3-INTEGRATE
**Branch**: v0.7.0-integration
**Baseline**: 2ee5e6f (P0-BOOTSTRAP done)

## State at HALT

Current tip: **6b73dd6** (T2-PAP applied).

Cherry-picks completed cleanly (in prescribed order):

| Order | T-ID     | Source SHA                                 | Result SHA | Status |
|-------|----------|--------------------------------------------|------------|--------|
| 1     | T1-NB    | 6115e839b4bf833acf3355385e846f3bb02b50cd   | e7a33f0    | OK     |
| 2     | T1-NH    | af1376f9d6e922d6fe28f909352b0da9545eb245   | aeec400    | OK     |
| 3     | T1-SKEW  | 4a1607f                                    | f2432d9    | OK     |
| 4     | T2-HOOKS | 776934b                                    | 2f1ae34    | OK     |
| 5     | T2-MCONT | 081e0c56c6336646017024ad2e93ba20dd4a35be   | 7df11a7    | OK     |
| 6     | T2-MSKIP | f969c94                                    | c3869a5    | OK     |
| 7     | T2-PAP   | e8209b8                                    | 6b73dd6    | OK     |

Cherry-picks attempted and aborted:

| Order | T-ID    | Source SHA | Conflict                                                    |
|-------|---------|------------|-------------------------------------------------------------|
| 8     | T2-MDIFF| 02ba745    | TASK_LOG.md, test/mirror-diff.integration.test.ts           |

## Root cause

**T2-PAP (e8209b8) is a bundle commit**, not an atomic post-applypatch fix.
`git show e8209b8 --stat` reveals it touches:

- `src/commands/mirror-diff.ts` (identical content to T2-MDIFF)
- `src/commands/mirror-skip.ts` (identical content to T2-MSKIP)
- `src/commands/post-applypatch.ts` (the actual T2-PAP work)
- `test/mirror-diff.integration.test.ts` (contains T2-MDIFF test AND T2-MSRC test)
- `test/mirror-skip.integration.test.ts` (contains T2-MSKIP tests)
- `test/mirror-status.integration.test.ts` (contains T2-MSTAT tests)
- `test/post-applypatch.test.ts` (the actual T2-PAP test work)

Diff verification:
- `git show 02ba745 -- src/commands/mirror-diff.ts` is byte-identical to the same
  hunks in `git show e8209b8 -- src/commands/mirror-diff.ts`.
- `git show 02ba745 -- test/mirror-diff.integration.test.ts` is a strict prefix
  of what T2-PAP added (T2-PAP additionally appends the T2-MSRC describe block).

## Implications for remaining cherry-picks

Because T2-PAP pre-bundles their content, the following batches will **all produce
no-op conflicts** (same content already applied):

- **T2-MDIFF** (02ba745): src/mirror-diff.ts + test/mirror-diff.integration.test.ts — already in T2-PAP
- **T2-MSRC** (e0fd249): src/mirror-source.ts (NEW work, not in T2-PAP) + test/mirror-diff.integration.test.ts (MSRC test block IS in T2-PAP)
- **T2-MSTAT** (3a93ddf): src/mirror-status.ts + test/mirror-status.integration.test.ts — already in T2-PAP

Verified by `git diff <bundle> <batch> -- <path>`:
- T2-PAP already includes T2-MDIFF source+test changes verbatim
- T2-PAP already includes T2-MSRC test block (but NOT src/mirror-source.ts changes)
- T2-PAP already includes T2-MSTAT source+test changes verbatim
- T2-PAP already includes T2-MSKIP source+test changes verbatim (T2-MSKIP separately applied above cleanly because T2-MSKIP came BEFORE T2-PAP in prescribed order)

Note: T2-MSKIP (f969c94) applied cleanly at step 6 because it came before T2-PAP.
T2-PAP's copy of the same changes then applied cleanly on top (git noticed the
file already matched the target state). The remaining MDIFF/MSRC/MSTAT batches
come AFTER T2-PAP in the prescribed order, so they now conflict.

## Recommended resolutions (maintainer call)

Option A: **Skip the redundant batches** with `git cherry-pick --skip`
- T2-MDIFF (02ba745): full skip (all content in T2-PAP)
- T2-MSRC (e0fd249): partial — the src/mirror-source.ts changes are NEW work
  not in T2-PAP; the test additions ARE in T2-PAP. Resolution: accept `--theirs`
  for src/mirror-source.ts, accept `--ours` for test/mirror-diff.integration.test.ts
- T2-MSTAT (3a93ddf): full skip

Option B: **Re-base** T2-PAP to contain only its own post-applypatch work
and re-run the whole cherry-pick sequence. Clean but requires rewriting
the T2-PAP batch.

Option C (recommended): For each conflicting cherry-pick, `git checkout --ours`
the conflicted files (HEAD already contains the target content from T2-PAP),
`git add`, `git cherry-pick --continue`. This produces empty-or-near-empty
commits that cleanly record the T-ID lineage without duplicating content.
For T2-MSRC, the src/mirror-source.ts changes are genuinely new and apply
without conflict (only the test file conflicts; resolve test with `--ours`).

## Remaining batches after MDIFF/MSRC/MSTAT resolution

- T2-MCFG (6835dbc): test-only (test/mirror-config...). Should apply cleanly.
- T2-REGEN (831d43f): test-only (test/regenerate...). Should apply cleanly.
- T2-MPULL (ef3591e): the big one. Per audit task: on test/version-skew.test.ts
  conflict, prefer `--theirs` (MPULL's implementation-side test).

## State preserved

- Backup ref `refs/backups/integration-before-reset` points at the pre-reset
  tip `0f6ab9b` (which had direct commits of T2-PAP/T2-MSKIP/T2-HOOKS variants
  before my reset to baseline).
- TASK_LOG.md modifications still stashed (`git stash list`).

## Pre-existing check failures (not caused by P3-INTEGRATE)

`bun run check` on the partial integration (at 6b73dd6) reports two TS6133
"declared but never read" errors that are inherited from the Phase 1 batches
themselves (not introduced by cherry-picking):

```
test/hooks-entrypoint.integration.test.ts(13,7): error TS6133: 'TRACKING_REMOTE2' is declared but its value is never read.
test/mirror-bootstrap.integration.test.ts(3,46): error TS6133: 'readFileSync' is declared but its value is never read.
```

These must be fixed on top of the integration branch before `bun run check` can
be green. They are **independent of the MDIFF conflict**; they are latent
defects in the T1-NH (af1376f) and T1-NB (6115e83) batches that a post-Phase-2
cleanup pass needs to address. Recommended: spawn a small fix-up batch agent
after the MDIFF/MSRC/MSTAT decision lands.

## What P3-INTEGRATE will NOT do without guidance

- Resolve conflicts by choosing --ours/--theirs without explicit maintainer
  approval (task instructions: "On conflict: HALT immediately").
- Modify package.json (Phase 4 owns version bump).
- Merge (only cherry-pick allowed).
