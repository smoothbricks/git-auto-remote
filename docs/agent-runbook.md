# Agent runbook: resolving a git-auto-remote sync conflict

You are an LLM (or a human) handed a paused/conflicted `git-auto-remote` mirror
sync. This runbook gets you from "something is stuck" to "resolved" using only
the tool's own self-guiding output. Every command ends with a `Next:` line — when
in doubt, **run the `Next:` command**.

## 0. Orient

```bash
git-auto-remote mirror status
```

`mirror status` is a diagnostic + remediation surface. It prints, per mirror, the
tracking/remote SHAs and how far behind you are, then a **Diagnostics &
remediation** section naming each problem and the EXACT fix command:

| Problem it names | Fix it prints |
| ---------------- | ------------- |
| no mirror config | `git config auto-remote.<remote>.syncPaths "<paths>"` (or commit `auto-remote.gitconfig`) |
| no local tracking ref | `git-auto-remote mirror pull <remote>` (seeds from the remote, else full replay) |
| stale `mirror-in-progress` sentinel | `git-auto-remote mirror skip <remote>` (CI auto-heals under `--non-interactive`) |
| version skew (hooks pin an older version) | `git-auto-remote setup` (warning only — never blocks) |
| cross-direction fetch refspec | the printed `git config --unset ...` command |

If a sync is paused mid-commit, the top of `mirror status` also shows
`git am: IN PROGRESS` and/or a `review-pending` line. Resolve those before
anything else (steps below).

## 1. Understand the paused commit

A pause means one source commit needs a human/LLM decision. Inspect it WITHOUT
copying SHAs around — the tool resolves the active pause for you:

```bash
git-auto-remote mirror source   # full 'git show' of the paused SOURCE commit
git-auto-remote mirror diff     # what the source changed that did NOT land in HEAD
                                # (scoped to review/regenerate/outside paths)
git-auto-remote mirror diff --raw   # unfiltered HEAD-vs-source diff
git status                      # what is staged / unstaged / conflicted right now
```

There are three pause sub-cases (all resolved by the same two commands):

- **am-conflict** — the allowlisted (`included`) patch did not apply cleanly.
  `git status` shows conflict markers (`<<<<<<<`). You must resolve them.
- **review-pause** — `included` already landed in HEAD; the `review` paths sit in
  the worktree UNSTAGED for your inspection.
- **pure-review-pause** — the source touched ONLY review paths; no HEAD commit was
  made yet.

## 2. Resolve

### a) Conflict markers present (am-conflict)

1. Open each file `git status` lists as "both modified" / "Unmerged".
2. Reconcile the `<<<<<<< / ======= / >>>>>>>` regions. Keep the upstream intent;
   preserve any local-only adjustments. Remove ALL marker lines.
3. Stage the resolved files: `git add <file>...`
4. Resume:

```bash
git-auto-remote mirror continue
```

### b) Review paths to vet (review-pause / pure-review-pause)

The `review` paths are unstaged in the worktree. Decide, per hunk, what should
land:

```bash
git diff                 # read the proposed review change
git add -p <path>        # stage the hunks you ACCEPT
git restore <path>       # drop the hunks you REJECT
git-auto-remote mirror continue   # amend/commit the staged review, resume
```

`mirror continue` refuses if NOTHING is staged but review content is still in the
worktree (it will not silently drop the commit). Either stage what you want, or
skip explicitly (below).

### c) This commit should not cross at all

```bash
git-auto-remote mirror skip   # drop the paused source commit, advance past it, resume
```

### d) Bail out entirely

```bash
git-auto-remote mirror abort  # stop the sync; rewind tracking so the next pull retries
```

## 3. Confirm

After `continue`/`skip`, the tool re-enters `mirror pull` automatically and
processes the next commit — it may sync clean, or pause again on the next
reviewable/conflicting commit. Repeat steps 1–2 until you see an up-to-date
summary, then:

```bash
git-auto-remote mirror status   # behind: 0 commits; no diagnostics
```

## 4. CI / single-PR review flow

In CI the sync runs non-interactively via `git-auto-remote mirror ci <remote>
--review-ref refs/heads/gar-sync/<dir>` (see
`examples/github-actions/mirror-sync.yml`). When a direction needs review, the
command exits **2** and writes the reviewable state — `included` subset + review
overlay + any conflict markers — into `gar-sync/<dir>` WITHOUT advancing the
tracking ref. The workflow pushes that branch and opens/refreshes **one** PR per
direction.

To resolve from a PR as an LLM agent:

1. Check out the review branch locally: `git fetch <pr-remote> gar-sync/<dir> && git switch gar-sync/<dir>`.
2. Resolve any `<<<<<<<` markers in the diff exactly as in step 2a, commit.
3. Push the branch back (the PR updates in place; never open a second PR).
4. The consuming repo's own CI verifies the PR. A CLEAN review PR can carry GitHub
   auto-merge so it flows green automatically; a conflicting one holds the single
   PR open until resolved.

A pending review PR is **expected**, not a failure — the scheduled sync stays
green while it waits.
