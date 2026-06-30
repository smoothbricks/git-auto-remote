# AGENTS.md — git-auto-remote

Workspace-level conventions: see `~/Dev/AGENTS.md`. This file documents tool-internal concepts and the release/test discipline specific to git-auto-remote.

The tool is published to npm as `git-auto-remote`. Conloca (and any future dual-remote project) consumes it via `bunx git-auto-remote@<exact-version> <subcmd>`. Source layout: `src/commands/<subcmd>.ts` (one file per CLI subcommand), `src/lib/*.ts` (shared building blocks), `test/*.ts` (Vitest).

## Core concepts

### Mirror direction and tracking refs

A "mirror" replays commits from a SOURCE remote into the local target branch using `git format-patch | git am`. Per direction, the most recently processed source SHA is stored in `refs/git-auto-remote/mirror/<source-remote>/last-synced`. This is the only durable state — losing it means the next pull restarts from scratch.

These refs MUST be pushed same-direction only:

- `refs/git-auto-remote/mirror/<remote-A>/*` is pushed only to `<remote-A>`.
- Cross-direction push leaks the source-remote's full object closure to the destination.
- `mirror status` warns if it sees a cross-direction refspec in local config (added in v0.6.2).
- The tool's own fetches use a narrow explicit refspec so external `git fetch` config can't clobber tracking refs (added in v0.6.2/v0.6.3).

### Path classification

Every cross-boundary commit is classified per-path against the consumer's `[auto-remote "<remote>"]` config. Buckets in priority order:

1. `excludePaths` — stripped silently.
2. `reviewPaths` — land unstaged; human resolves with `mirror continue` or `mirror skip`.
3. `regeneratePaths` — dropped from the patch; `regenerateCommand` reproduces.
4. `syncPaths` (the allowlist) — applied verbatim.
5. `outside` — anything not in the allowlist; never crosses.

### Pause state

When `mirror pull` hits a `reviewPaths` change or conflict, it writes `.git/git-auto-remote/review-pending` (JSON: `remote`, `sourceSha`, `subject`, `included`, `review`, `regenerate`, `outside`, `phase`). Resume:

- `mirror continue` — accept whatever is currently staged and proceed; runs `regenerateCommand`, amends, advances tracking ref.
- `mirror skip` — abandon the source commit; advance tracking ref past it as if it never happened.
- `mirror diff` — show what the source changed that hasn't landed in the staged result.
- `mirror source` — `git show` the full source commit.

After resume, the loop re-enters `mirror pull` automatically and processes the next commit.

## Critical invariants (regression guard)

- `mirror skip` MUST always `updateTrackingRef(remote, review.sourceSha)` on every code path, or it loops forever on the same commit (v0.6.3 fix; CRIT-1 in v0.7.0 audit).
- `mirror continue` MUST do the same on every path (v0.7.0 fix).
- After `git am` lands, `postAmTransition` MUST verify HEAD's tree contains the included-paths subset of the source commit (v0.7.0 fix; CRIT-2).
- `mirror pull` MUST refuse to start if `MERGE_HEAD` exists (v0.7.0). On a stale in-progress sentinel it refuses interactively but **auto-heals** under `--non-interactive` (v0.8.0/C1-d). On installed-hook-pin disagreement with the running tool version it **warns (not refuses)** and proceeds - blocking a CI sync because a cached hook pins an older version would be worse than the (compatible) state-file risk; refresh hooks with `git-auto-remote setup` (v0.8.0/C1-i; test: `test/version-skew.test.ts`).

## Files worth knowing

- `src/commands/mirror-pull.ts` — the orchestrator. Loops through unsynced source commits, classifies, applies, pauses-or-advances.
- `src/commands/mirror-skip.ts` / `mirror-continue.ts` — the two pause-resolution paths. Both must update the tracking ref.
- `src/lib/apply.ts` — `git am` invocation + `postAmTransition` (HEAD-contains-subset verification).
- `src/lib/classify.ts` — path bucket classification.
- `src/lib/mirror-state.ts` — reads/writes `review-pending` and tracking refs.
- `src/lib/mirror-config.ts` — parses `[auto-remote "<remote>"]` sections.
- `src/lib/hooks.ts` + `src/commands/setup.ts` — hook installation; pin verification.
- `src/commands/post-applypatch.ts` etc. — git hook entry points.
- `src/cli.ts` — commander dispatch (auto-aligned help, strict flags; v0.6.2+).

## Release discipline

- Semver: pre-1.0, breaking behaviour changes allowed in minor bumps.
- The user publishes to npm manually via `npm publish` after commit + tag. **Agents must not `git push` or `npm publish`.**
- Bumping: edit `package.json` `version`, commit `chore: bump to vX.Y.Z`, tag `vX.Y.Z`. The user handles the rest.
- Each release should have a corresponding test that would have caught the bug being fixed. The user has been burned by ship-then-break cycles; TDD discipline is mandatory:
  1. Write the failing test first.
  2. Verify the diagnostic matches the actual bug.
  3. Implement the fix.
  4. Verify green.
- Audit-driven releases (e.g. v0.7.0): work in throwaway worktrees `/tmp/gar-<batch>/`, integrate, then squash audit artifacts out of `main` before tagging.

## Recent release line

- `v0.5.x` — classification edge cases (mirror diff scope, regenerate bucket, empty-review auto-apply, sub-case routing).
- `v0.6.0` — committer = author across replayed commits.
- `v0.6.1` — dropped `ensureMirrorRefspec` auto-add (silent fast-forward via fetch clobber).
- `v0.6.2` — commander CLI + per-subcommand `--help` + strict flag parsing + cross-direction-leak warnings.
- `v0.6.3` — `mirror skip` always advances tracking ref (CRIT-1 of audit).
- `v0.7.0` — full audit-driven hardening: continue paths (CRIT-1), HEAD-contains-included-subset verification (CRIT-2), merge-in-progress + stale-sentinel + version-skew guards on `mirror pull`, hook entry-point integration tests.
- `v0.7.2` — `mirror continue` now refuses when nothing is staged (was silent skip-equivalent / "Q2a"). Pre-v0.7.2 a continue with unstaged review leftovers silently advanced tracking past the source commit, dropping it - reproduced as a Conloca data-loss report (2026-05-02). New contract: stage what you want or `mirror skip` explicitly.
- `v0.8.0` — self-healing, agent-usable, CI-ready. C1-a committed-config loading (read `auto-remote.gitconfig` merged under `git config`); C1-b tracking-ref auto-seeding on fresh clones (`--no-seed-tracking`); C1-c `--force-with-lease` tracking-ref push; C1-d stale-sentinel + tracking self-heal under `--non-interactive`; C1-e `MIRROR_REGENERATE_PATHS` set for handlers; C1-f `mirror pull --review-ref` single-PR review flow; C1-g `mirror ci` one-shot self-healing CI sync command; C1-h self-guiding CLI (`Next:` trailers on every command, per-subcommand `--help` examples, program 'typical agent workflow', `mirror status` diagnostic+remediation); C1-i version-skew reconciled to warn-not-refuse. Docs: README CI/self-healing/single-PR sections, `examples/{auto-remote.gitconfig,github-actions/mirror-sync.yml,github-actions/review-pr-handler.sh}`, `docs/agent-runbook.md`.

## Test harness

- Vitest. Many tests use throwaway git fixtures under `/tmp/gar-<test-name>-<random>/` containing `local/`, `seed/`, `upstream.git/`. These are scratch dirs, NOT git worktrees of this repo — safe to `rm -rf /tmp/gar-*` between sessions.
- Real git worktrees of this repo (visible in `git worktree list`) are different and must be removed via `git worktree remove`.
