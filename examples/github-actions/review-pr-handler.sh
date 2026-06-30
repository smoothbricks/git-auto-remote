#!/usr/bin/env bash
# Reference git-auto-remote --on-partial handler (v0.8.0+).
#
# PREFER `mirror ci --review-ref <ref>` (v0.8.0): for the standard single-PR
# review flow you do NOT need a handler at all - `mirror ci` assembles the
# reviewable ref and leaves the tracking ref untouched for you. Use THIS handler
# only when you need custom per-partial logic (e.g. an LLM that resolves some
# conflicts inline and punts the rest).
#
# CONTRACT (see README "Scripted partial resolution"):
#   Invoked as:  handler.sh <remote> <source-sha>
#   Pre-state:   HEAD = the `included` subset applied; review paths sit UNSTAGED
#                in the worktree; outside paths are already dropped.
#   Env:         MIRROR_REMOTE, MIRROR_SOURCE_SHA, MIRROR_SOURCE_SUBJECT,
#                MIRROR_INCLUDED_PATHS, MIRROR_REVIEW_PATHS,
#                MIRROR_REGENERATE_PATHS, MIRROR_OUTSIDE_PATHS
#   Exit:        0 = resolved (HEAD is the answer; sync continues)
#                2 = skip this commit (gar resets HEAD~1, advances past, continues)
#                other = punt (non-interactive: gar rewinds HEAD + ref, exits 2)
#
# This reference handler captures the reviewable state (included subset + review
# overlay) into a stable ref `refs/gar-review/<remote>` WITHOUT moving HEAD
# (commit-tree, not commit), then PUNTS - so gar rewinds its partial HEAD commit
# and leaves the tracking ref intact. The workflow then pushes
# refs/gar-review/<remote> to the PR-hosting remote and opens/refreshes one PR.

set -euo pipefail

remote="${MIRROR_REMOTE:-${1:?remote arg required}}"
source_sha="${MIRROR_SOURCE_SHA:-${2:?source-sha arg required}}"
review_ref="refs/gar-review/${remote}"

# Stage the included subset (already in HEAD) plus the review overlay.
git add -A

tree="$(git write-tree)"

# Preserve the source commit's identity + message on the assembled commit.
GIT_AUTHOR_NAME="$(git show -s --format=%an "$source_sha")"
GIT_AUTHOR_EMAIL="$(git show -s --format=%ae "$source_sha")"
GIT_AUTHOR_DATE="$(git show -s --format=%aI "$source_sha")"
GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_AUTHOR_DATE
export GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_COMMITTER_DATE

commit="$(git commit-tree "$tree" -p HEAD -m "$(git show -s --format=%B "$source_sha")")"
git update-ref "$review_ref" "$commit"

echo "[review-pr-handler] assembled review state for ${remote} at ${commit} -> ${review_ref}" >&2
echo "[review-pr-handler] punting so gar leaves the tracking ref intact; push ${review_ref} and open one PR." >&2

# Punt: any code other than 0/2. gar rewinds HEAD + ref and exits 2 in CI.
exit 3
