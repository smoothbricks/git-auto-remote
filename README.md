# git-auto-remote

Automatically route `git push`/`pull` to the correct remote based on **branch ancestry**.

Useful when a single local repo tracks multiple upstreams with unrelated histories — for example a `public/private` fork split, or vendored code with its own upstream. Prevents you from accidentally pushing commits to the wrong remote.

## How it works

1. A `post-checkout` hook inspects the current branch and compares which remote's root commit(s) it descends from.
2. If exactly one remote matches, it configures `branch.<name>.pushRemote` to that remote.
3. A `pre-push` hook verifies the push actually belongs to the target remote's history. If not, the push is refused.

The decision rules:

| Situation | Action |
|---|---|
| No remotes configured | No-op |
| All remotes share the same root set (mirrors) | Inherit parent branch's pushRemote |
| Remotes have disjoint roots, branch matches exactly one | Route to that remote |
| Branch matches zero remotes | No-op (silent) |
| Branch matches two or more remotes | Refuse to auto-configure, print warning |

Any manually configured `branch.<name>.pushRemote` is always respected — the hook never overrides.

## Install

```bash
bunx git-auto-remote setup
```

Hooks are idempotent and **chainable**: if you already have a `post-checkout` or `pre-push` hook from another tool, our snippet is appended below yours (marked by `# >>> git-auto-remote <hook> >>>` / `# <<< ... <<<` markers). Other tools that want to coexist can look for the string `git-auto-remote <hook>` in the hook file.

## Commands

```
git-auto-remote setup [--quiet]   Install hooks (idempotent)
git-auto-remote status            Show remotes, their roots, current routing
git-auto-remote detect [ref]      Debug ancestry analysis for a ref
git-auto-remote uninstall         Remove our blocks from installed hooks
```

## Bypassing

If you *really* need to push across histories (e.g. deliberately merging a fork), the pre-push hook can be bypassed with:

```bash
git push --no-verify
```
