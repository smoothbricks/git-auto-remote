# git-auto-remote

Git tooling for repositories that track **multiple upstreams with disjoint histories** — for example a public/private fork split, or a monorepo that mirrors a subset of itself to an open-source repo.

Two features in one CLI, both invoked via git hooks installed by `git-auto-remote setup`:

1. **Auto-routing** — on branch checkout, detect which remote's root commit(s) the branch descends from and set `branch.<name>.pushRemote` accordingly. Pre-push hook refuses cross-history pushes.
2. **Mirror sync** — on `git pull`, cherry-pick new commits from a configured mirror remote (restricted to an allowlist of paths). Empty commits and round-tripped changes drop automatically via `git am --empty=drop`.

## Install

```bash
bunx git-auto-remote setup
```

Hooks are idempotent and chainable: if another tool has already installed a hook, `git-auto-remote` appends its block marked with `# >>> git-auto-remote <hook> >>>` sentinels. Other tools can detect our presence by grepping for the string `git-auto-remote <hook>`.

## Auto-routing (always on after `setup`)

Given a repo with multiple remotes that have disjoint root commits (e.g. `public` and `private`), checking out a new branch sets the appropriate `pushRemote`:

```bash
git switch public
git checkout -b feat/open-x       # -> pushRemote = public
git switch private
git checkout -b feat/closed-y     # -> pushRemote = private
```

Pre-push verifies the push belongs to the target remote's history; cross-fork pushes are rejected (bypass with `--no-verify` if deliberate).

Decision rules:

| Situation | Action |
|---|---|
| No remotes configured | No-op |
| All remotes share the same root set | Inherit parent branch's pushRemote |
| Remotes have disjoint roots, branch matches exactly one | Route to that remote |
| Branch matches zero remotes | No-op (silent) |
| Branch matches two or more remotes | Refuse to auto-configure, warn |

Any manually configured `branch.<name>.pushRemote` is always respected.

## Mirror sync

Opt-in per remote via git config. A remote becomes a "mirror" by setting `syncPaths`:

```bash
# In your private clone, treat the 'public' remote as a mirror of packages/:
git config auto-remote.public.syncPaths "packages"
git config auto-remote.public.syncTargetBranch "private"
git-auto-remote mirror bootstrap public <sha-whose-tree-matches-current-packages/>
```

| Config key | Meaning | Default |
|---|---|---|
| `auto-remote.<name>.syncPaths` | Space-separated pathspecs to include when cherry-picking. Presence (either here or via `syncPathsFile`) makes the remote a mirror. | *required* |
| `auto-remote.<name>.syncPathsFile` | Repo-relative path to a newline-separated file of sync paths. Supports `#` comments. Contents union with `syncPaths`. | *(none)* |
| `auto-remote.<name>.excludePaths` / `.excludePathsFile` | Pathspecs that are **never** synced, even if under `syncPaths`. Useful for repo-local-only files that live in a shared directory. Dropped silently from the commit; no pause. | *(none)* |
| `auto-remote.<name>.reviewPaths` / `.reviewPathsFile` | Pathspecs whose changes are **brought into the worktree as unstaged** at pause time so the user can `git add -p` / `git restore` / `git commit --amend --no-edit`. Orthogonal to `syncPaths` — a path may be a reviewPath without being a syncPath. Author + author-date are preserved across amends. | *(none)* |
| `auto-remote.<name>.regeneratePaths` / `.regeneratePathsFile` | Pathspecs for **derived** files (bun.lock, generated tsconfig references, etc.) that are dropped from incoming patches and regenerated locally. When a source commit touches any of these, `regenerateCommand` runs after apply and its output is amended into HEAD. | *(none)* |
| `auto-remote.<name>.regenerateCommand` | Shell command (run via `sh -c`) that produces the regenerate paths from current sources. For nix/devenv repos, wrap with the project shell so tool versions match: `devenv shell -c 'bun i'`. | *(none)* |
| `auto-remote.<name>.syncBranch` | Remote branch to pull from. | `<remote>/HEAD`, else `main` |
| `auto-remote.<name>.syncTargetBranch` | Local branch that receives replayed commits. | `<remote>` |
| `auto-remote.<name>.partialHandler` | Path to a script that resolves "partial" commits. | *(none)* |
| `auto-remote.<name>.pushSyncRef` | Push the tracking ref to the remote after each advance (for CI durability). | `true` |

### Per-commit classification

Each changed path in a mirror commit is sorted into exactly ONE bucket, in priority order:

1. matches `excludePaths` → **dropped entirely** (never in HEAD, never in worktree, not reported)
2. matches `reviewPaths` → **review** (overlaid to the worktree unstaged at pause time)
3. matches `regeneratePaths` → **regenerate** (dropped from HEAD; `regenerateCommand` runs after apply and the output is amended into HEAD)
4. matches `syncPaths` → **included** (applied to HEAD by `git am`, author + author-date preserved)
5. none of the above → **outside** (silently dropped, reported in the pause message so you notice)

All three of `reviewPaths`, `regeneratePaths`, `syncPaths` are first-class and independent. Canonical use of `regeneratePaths`: `bun.lock` — when upstream bumps it, we drop their version from the patch and run `bun i` locally to produce our own (matches our package state, avoids binary-file merge pain). Canonical use of `reviewPaths`: `tooling/workspace.gitconfig` — sensitive shared config that deserves a human glance before landing.

| Classification | When | Action |
|---|---|---|
| **Out-of-scope** | `included`, `review`, and `regenerate` all empty | commit skipped, tracking ref advances |
| **Clean** | `review` and `outside` both empty (may have `included` and/or `regenerate`) | batched `git am`; if `regenerate` non-empty, command runs + amends last commit |
| **Partial** | `review` or `outside` non-empty | breaks the batch; paused for review |

A batched run of clean + out-of-scope commits is applied via a single `git format-patch ... | git am --empty=drop --3way`.

### Partial commit review (interactive)

When a partial is encountered, the tool:

1. Applies the `included` subset to HEAD via `git am` (author + author-date preserved).
2. Overlays the `review` subset into the worktree as **unstaged** modifications (via `git apply --3way`).
3. Pauses for review.

```
[mirror public] Partial: feat: shared lib + private glue (abc1234)
  Review (in worktree, unstaged): tooling/workspace.gitconfig
  Regenerate (auto-produced):     bun.lock
  Outside sync scope (dropped):   privpkgs/foo.ts

  Review:    git diff                       # see unstaged review content
  Stage:     git add -p                     # pick hunks into the commit
  Discard:   git restore <paths>            # drop review hunks
  Continue:  git-auto-remote mirror continue public
  Skip:      git-auto-remote mirror skip public
```

Lines with empty lists are omitted.

- `mirror continue <remote>` — if you staged any review hunks, amends HEAD with them (author + author-date preserved by `--amend --no-edit`); any leftover unstaged review content is discarded. Resumes the sync from there.
- `mirror skip <remote>` — discards the worktree overlay and resets HEAD past the partial commit. Tracking ref already points past the source SHA, so the next pull resumes past it too.

Both commands are unified across three pause sub-cases:

- **am-conflict** — the `included` patch wouldn't apply cleanly; resolve conflicts in the normal `git am` way, then `mirror continue`
- **review-pause** — `included` landed (with regenerated output if `regenerateCommand` ran); `review` awaits in the worktree
- **pure-review-pause** — the source touched ONLY review paths, no HEAD commit was made; staging + `mirror continue` creates a fresh commit preserving the source's author/email/date/message

### Regenerate (derived files like bun.lock)

For files that are deterministic from other sources (lockfiles, generated type references, etc.), `regeneratePaths` + `regenerateCommand` drops the upstream version from the patch and produces a local version. Trigger: a source commit touched one of `regeneratePaths`. Behavior: after the patch applies, the command runs (via `sh -c`); any changes it produces inside `regeneratePaths` are staged and amended into HEAD with `--amend --no-edit` (author + author-date preserved). Changes outside `regeneratePaths` are NOT amended and surface as dirty worktree (the tool treats them as a config error but completes the apply).

Example config for a bun-based repo:
```ini
[auto-remote "public"]
	regeneratePaths   = bun.lock
	regenerateCommand = devenv shell -c 'bun i --frozen-lockfile=false'
```

The `devenv shell` wrapper ensures `bun` resolves to the project-pinned version regardless of the PATH git inherited (GUI clients, post-applypatch during a bare-terminal `git am --continue`, CI without the dev env activated).

### Non-interactive mode (CI)

`mirror pull --non-interactive` never pauses for a human:

| Situation | Behavior | Exit code |
|---|---|---|
| Up to date | no-op | 0 |
| Only clean commits | all applied | 0 |
| Partial encountered, no handler | nothing applied, ref unchanged (so CI surfaces it again) | 2 |
| Conflict in a clean commit | `git am --abort`, exit | 2 |

### Scripted partial resolution (`--on-partial`)

Provide a command that decides what to do with partials. Useful for LLM-in-CI setups:

```bash
git-auto-remote mirror pull --non-interactive --on-partial ./ci/llm-amend.sh public
```

Or configure it permanently:

```bash
git config auto-remote.public.partialHandler /path/to/handler.sh
```

The handler is invoked with the partial's subset already applied to HEAD. It may amend HEAD, leave it as-is, or signal skip/punt via exit code:

| Exit code | Meaning | Tool response |
|---|---|---|
| 0 | Resolved; HEAD is the answer | Continue sync |
| 2 | Skip this commit | `git reset --hard HEAD~1`; ref advances past; continue |
| any other | Punt (can't decide) | Interactive: pause for human. Non-interactive: rewind HEAD + ref, exit 2 |

Handler receives the following env vars:

```
MIRROR_REMOTE           public
MIRROR_SOURCE_SHA       abc1234...
MIRROR_SOURCE_SUBJECT   feat: shared lib + private glue
MIRROR_INCLUDED_PATHS   newline-separated (already in HEAD)
MIRROR_REVIEW_PATHS     newline-separated (in worktree, unstaged)
MIRROR_OUTSIDE_PATHS    newline-separated (dropped, not in HEAD or worktree)
```

And positional args: `<remote> <source-sha>`. Full source diff available via `git show $MIRROR_SOURCE_SHA`. The handler is invoked with HEAD at the `included` subset (or unchanged for pure-review-only sources) and review paths as unstaged worktree changes, so typical operations are `git add -p && git commit --amend --no-edit` or `git restore`.

### Tracking-ref durability

The last-synced position per mirror is stored under `refs/git-auto-remote/mirror/<remote>`. With `pushSyncRef=true` (default), the ref is pushed to the remote after each advance — so CI clones (which start with a fresh `.git/`) pick up the state automatically. `setup` also adds a fetch refspec (`+refs/git-auto-remote/mirror/*:...`) to each mirror's remote config.

## Commands

```
git-auto-remote setup [--quiet]           Install hooks
git-auto-remote status                    Auto-routing status
git-auto-remote detect [ref]              Ancestry analysis
git-auto-remote uninstall                 Remove hook blocks

git-auto-remote mirror list               Show configured mirrors
git-auto-remote mirror status [<remote>]  Show sync state
git-auto-remote mirror bootstrap <remote> <sha> [--force]
git-auto-remote mirror pull [<remote>] [--non-interactive] [--on-partial <cmd>]
git-auto-remote mirror continue [<remote>]     # resolve any pause sub-case
git-auto-remote mirror skip [<remote>]         # skip the paused commit
```

## Bypassing auto-routing on push

If you really need to push across histories, bypass the pre-push safety net with `git push --no-verify`.

## Requirements

Git ≥ 2.34 (for `git am --empty=drop`). `setup` checks the version and refuses if too old.
