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
git config fork-remote.public.syncPaths "packages"
git config fork-remote.public.syncTargetBranch "private"
git-auto-remote mirror bootstrap public <sha-whose-tree-matches-current-packages/>
```

| Config key | Meaning | Default |
|---|---|---|
| `fork-remote.<name>.syncPaths` | Space-separated pathspecs to include when cherry-picking. Presence makes the remote a mirror. | *required* |
| `fork-remote.<name>.syncBranch` | Remote branch to pull from. | `<remote>/HEAD`, else `main` |
| `fork-remote.<name>.syncTargetBranch` | Local branch that receives replayed commits. | `<remote>` |
| `fork-remote.<name>.partialHandler` | Path to a script that resolves "partial" commits. | *(none)* |
| `fork-remote.<name>.pushSyncRef` | Push the tracking ref to the remote after each advance (for CI durability). | `true` |

### Per-commit classification

Each mirror commit is classified by comparing its changed paths against `syncPaths`:

| Changed paths | Classification | Action |
|---|---|---|
| all inside `syncPaths` | **Clean** | included in a batched `git am` run |
| all outside `syncPaths` | **Out-of-scope** | empty patch, dropped |
| mix of both | **Partial** | breaks the batch; applied alone; paused for review |

A batched run of clean + out-of-scope commits is applied via a single `git format-patch ... | git am --empty=drop --3way`.

### Partial commit review (interactive)

When a partial is encountered, its in-scope changes are applied as a commit and the tool pauses:

```
[mirror public] Partial: feat: shared lib + private glue (abc1234)
  Excluded paths: package.json, privpkgs/foo.ts
  Review:    git show HEAD
  Amend:     git commit --amend    (optionally include excluded content)
  Continue:  git-auto-remote mirror continue public
  Skip:      git-auto-remote mirror skip public
```

- `mirror continue <remote>` — resume with whatever amendments you made
- `mirror skip <remote>` — drop the partial (resets HEAD~1) and resume past it

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
git config fork-remote.public.partialHandler /path/to/handler.sh
```

The handler is invoked with the partial's subset already applied to HEAD. It may amend HEAD, leave it as-is, or signal skip/punt via exit code:

| Exit code | Meaning | Tool response |
|---|---|---|
| 0 | Resolved; HEAD is the answer | Continue sync |
| 2 | Skip this commit | `git reset --hard HEAD~1`; ref advances past; continue |
| any other | Punt (can't decide) | Interactive: pause for human. Non-interactive: rewind HEAD + ref, exit 2 |

Handler receives the following env vars:

```
MIRROR_REMOTE            public
MIRROR_SOURCE_SHA        abc1234...
MIRROR_SOURCE_SUBJECT    feat: shared lib + private glue
MIRROR_INCLUDED_PATHS    newline-separated
MIRROR_EXCLUDED_PATHS    newline-separated
```

And positional args: `<remote> <source-sha>`. Full source diff available via `git show $MIRROR_SOURCE_SHA`.

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
git-auto-remote mirror continue [<remote>]
git-auto-remote mirror skip [<remote>]
```

## Bypassing auto-routing on push

If you really need to push across histories, bypass the pre-push safety net with `git push --no-verify`.

## Requirements

Git ≥ 2.34 (for `git am --empty=drop`). `setup` checks the version and refuses if too old.
