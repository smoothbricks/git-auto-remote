# git-auto-remote test-suite audit (HEAD = 7c68de8, v0.6.3)

## Executive summary

The v0.6.3 `mirror skip` fix correctly re-asserts the tracking ref in every
skip path, and both integration tests for that fix are strict (delete the
ref, run skip, assert ref equals sourceSha). **The same pattern exists
verbatim on the `mirror continue` paths and is not fixed there.** Three
continue paths (`continueReviewPause`, `continuePureReviewPause`,
`continueAm`, `postAmTransition`) all trust prior tracking state and
tail-call `mirrorPull`, which re-fetches — any fetch-refspec or
external-perturbation clobber between pause and continue will either
re-play the just-continued commit or silently skip a range. No test
exercises continue under the perturbation that drove v0.6.3. That is the
next bug-class in waiting.

Secondary gaps: `post-checkout`, `pre-push`, and `post-merge` hook entry
points have **zero** direct tests (only their pure dependency `validatePush`
/ `decideRouting` are unit-tested). The `post-applypatch` parser has no
test for its defensive branches (malformed `next`, missing patch file,
garbage `From ` header) even though a hook that silently no-ops on
corrupted state is the same failure mode as v0.6.3. Config parsing of
`syncPathsFile` has happy-path tests but CRLF / absolute-path / outside-
worktree cases are unexercised. Several integration assertions lean on
`not.toContain` against a single aggregate capture buffer, which makes
them vulnerable to spurious-pass regressions.

## Phase 1 catalog (commands × contracts × tests)

| Command                                      | Contract (user-visible)                            | Preconditions                                             | Postconditions                                                                 | Happy-path test                                                  | Perturbation/edge tests                                                                                                              |
| -------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `setup`                                      | Install 4 hooks idempotently                       | git ≥ required version                                    | Each hook has marker block                                                     | `hooks.test.ts:28`                                               | Foreign content, version upgrade covered; **gap**: hook file not writable, `.git` is a file (worktree)                               |
| `status`                                     | Show routing + hook state                          | —                                                         | No mutation                                                                    | —                                                                | **no test**                                                                                                                          |
| `detect [ref]`                               | Ancestry analysis                                  | ref resolvable                                            | No mutation                                                                    | —                                                                | **no test** (only `decideRouting` unit tests)                                                                                        |
| `uninstall`                                  | Remove our block only                              | —                                                         | Foreign content preserved                                                      | `hooks.test.ts:135`                                              | Adequate                                                                                                                             |
| `mirror list`                                | List configs                                       | —                                                         | No mutation                                                                    | —                                                                | **no test**                                                                                                                          |
| `mirror status [remote] [--remotes]`         | Summarize mirror drift                             | —                                                         | No mutation; network call iff `--remotes`                                      | `mirror-status.integration.test.ts` covers all `--remotes` cases | **gap**: drift semantics when tracking ref is disjoint-history / force-push (says "unknown")                                         |
| `mirror bootstrap <remote> <sha> [--force]`  | Set tracking ref                                   | remote configured                                         | `refs/git-auto-remote/mirror/<remote>/last-synced` at sha; legacy ref migrated | —                                                                | **no test file** for bootstrap itself (covered only incidentally by test setup)                                                      |
| `mirror pull` (non-interactive / on-partial) | Apply in-range commits or pause                    | on syncTargetBranch, clean tree, no am, no review-pending | Tracking advances exactly to last applied SHA; no marker if nothing paused     | `mirror-pull.integration.test.ts` (extensive)                    | Good; some spurious-pass risks called out below                                                                                      |
| `mirror continue [remote]`                   | Resume from any pause                              | matching pause marker OR am-in-progress                   | Tracking at/past sourceSha; markers cleared; pull tail-resumes                 | `mirror-resume.integration.test.ts:106,287,403`                  | **CRITICAL gap**: no test with tracking ref deleted/rewound between pause and continue (v0.6.3 analog on continue path — see CRIT-1) |
| `mirror skip [remote]`                       | Drop paused source, resume                         | matching pause OR am                                      | Tracking past sourceSha; HEAD reset where applicable                           | `mirror-skip.integration.test.ts` (v0.6.3 defect A)              | **Good.** The three perturbation tests are the exemplar — replicate elsewhere                                                        |
| `mirror diff [--raw] [-- git-args]`          | Scoped HEAD↔source diff                            | active pause                                              | No mutation                                                                    | `mirror-diff.integration.test.ts` (v0.5.7 scope)                 | **gap**: mismatch between `review.sourceSha` in marker and local object DB (e.g. post-GC) unhandled                                  |
| `mirror source`                              | `git show` of source commit                        | active pause                                              | No mutation                                                                    | `mirror-diff.integration.test.ts:425,430`                        | **gap**: `sourceSha` garbage-collected / not in DB path                                                                              |
| Hook `post-applypatch`                       | Advance tracking per patch, clear sentinel on last | sentinel set                                              | Tracking = From-SHA of this patch                                              | `post-applypatch.test.ts` (3 cases)                              | **gap**: malformed `From ` header, corrupted `next`, patch file absent (code paths exist, untested)                                  |
| Hook `post-checkout`                         | Auto-route new branch                              | —                                                         | `branch.<X>.pushRemote` set per routing decision                               | **no test**                                                      | —                                                                                                                                    |
| Hook `pre-push`                              | Refuse cross-history push                          | —                                                         | Non-zero exit on violation                                                     | **no test** (only `validatePush` unit tests)                     | —                                                                                                                                    |
| Hook `post-merge`                            | Run mirror pull, never fail outer pull             | on a mirror target branch                                 | Tracking advances; errors swallowed                                            | **no test**                                                      | —                                                                                                                                    |

## Findings by risk bucket

### CRIT-1 — `mirror continue` trusts prior tracking-ref state; v0.6.3 class bug on continue paths

- **Code path**: `src/commands/mirror-continue.ts:209-241` (`continueReviewPause`), `:249-287` (`continuePureReviewPause`), `:81-144` (`continueAm`), `:150-199` (`postAmTransition`). None of these call `updateTrackingRef(remote, reviewState.sourceSha)` before the tail-call to `mirrorPull({ remote })`.
- **Existing test**: `mirror-resume.integration.test.ts:342-367,455-476` exercise continue happy paths. Zero tests delete, rewind, or force-clobber the tracking ref between pause and continue.
- **Failure mode**: Exact symmetry with the v0.6.3 skip bug. Between a `mirror pull` that paused and the user typing `mirror continue`, ANY of the following moves the tracking ref backward from `sourceSha`:
  - A manual `git update-ref -d refs/git-auto-remote/mirror/upstream/last-synced`.
  - A `git fetch upstream` run by the user / an editor / a pre-commit hook while a misconfigured `+refs/git-auto-remote/mirror/*:...` refspec is present (exactly the defect-B scenario of v0.6.3 — the narrow-fetch fix in `mirror pull` helps the fetch _inside_ the tool, but any out-of-band fetch re-clobbers).
  - A second `git-auto-remote mirror pull` kicked off by `post-merge` while the first is paused (direnv reload, parallel editor).
    Result: `mirrorPull` re-enumerates from the rewound tracking point, re-encounters the just-continued commit, and either re-pauses on it (infinite-loop variant) or re-applies it as a duplicate commit on top of the one continue just created. Sub-case C.2 (review + regen) is the worst shape — `continue` synthesizes a new commit, then `mirrorPull` from rewound tracking classifies the same source as a sub-case-C partial, re-runs regen, and pauses _again_ on the same thing the user just continued past.
- **Reproduction** (reuse the v0.6.3 skip test scaffolding):
  ```
  # set up sub-case B partial, mirrorPull pauses at sourceSha
  git -C local update-ref -d refs/git-auto-remote/mirror/upstream/last-synced
  git -C local add packages/reviewed   # stage review
  git-auto-remote mirror continue upstream
  # expect: tracking = sourceSha, HEAD has one amended commit past
  # actual (pre-fix): tracking is wherever `mirrorPull`'s re-fetch left it
  #   (likely upstream/main tip via explicit narrow refspec — but if the
  #    user also has the legacy refspec AND ran any plain `git fetch` in
  #    between, tracking is clobbered back to whatever bare upstream has
  #    at the mirror ref, potentially well behind sourceSha).
  ```
- **Suggested test**: In `mirror-resume.integration.test.ts`, for each of the three pause phases, add a test that deletes `TRACKING` between `mirrorPull` and `mirrorContinue`, then asserts `git rev-parse TRACKING` equals `sourceSha` after continue, AND that the subject of the just-continued commit does not appear twice in `git log`. Also add the misconfigured-fetch-refspec variant (copy the `skip` test at `mirror-skip.integration.test.ts:218-260`, swap `mirrorSkip` for `mirrorContinue`). Fix: each continue branch calls `updateTrackingRef(remote, review.sourceSha)` before `return mirrorPull(...)`, mirroring the v0.6.3 skip fix.

### CRIT-2 — `postAmTransition` re-reads review state but never verifies HEAD actually contains the just-applied included subset

- **Code path**: `src/commands/mirror-continue.ts:150-199`. Reached via two paths: (a) `continueAm` after `git am --continue` succeeds with a lingering `am-in-progress` marker; (b) fall-through at `:73` when `amInProgress()` returned false but the marker says `am-in-progress`. In both, the function overlays the review diff on worktree and sets `phase: 'review-pause'` WITHOUT verifying HEAD's tree actually matches `sourceSha`'s included subset.
- **Existing test**: None. `mirror-resume.integration.test.ts:106-169` exercises the `am --continue` path but only when review is empty; no test exercises the `postAmTransition` handoff for a commit that had both a conflict AND review content.
- **Failure mode**: If the user resolves the conflict _incorrectly_ — e.g. they `git reset --hard HEAD~1` to escape the am, or `git am --abort` fires the hook in a weird order — HEAD is no longer at the included subset. The transition then overlays review-path content against a wrong HEAD, silently producing a review-pause with reviewPaths showing wildly incorrect drift. User stages and continues, creating a broken amended commit.
- **Reproduction**:
  ```
  # set up sub-case A partial with review, am conflicts
  git -C local am --abort         # bypass mirror continue
  # marker still says phase: am-in-progress, but am is no longer running
  git-auto-remote mirror continue upstream
  # falls into postAmTransition; applies review diff against wrong HEAD
  ```
- **Suggested test**: After a sub-case-A pause, simulate a bypass (`git am --abort` directly), then run `mirror continue`. Expect: tool detects HEAD does not contain the included subset and either re-enters conflict resolution or returns 1 with an explanatory message — NOT a silent review-pause on an inconsistent HEAD.

### CRIT-3 — `post-applypatch` silently no-ops on corrupted or missing `.git/rebase-apply` state; tracking stops advancing mid-range with no signal

- **Code path**: `src/commands/post-applypatch.ts:18-37`. Every validation failure (missing `rebase-apply`, non-numeric `next`, missing patch file, unmatched `From ` regex) is `return 0`.
- **Existing test**: `post-applypatch.test.ts:62-93` covers the happy paths and one "sentinel absent" case. No test asserts that a malformed patch file, a patch whose first line isn't `From <40hex> ...`, or a `next` of 0 leaves SOME user-visible signal.
- **Failure mode**: During a multi-patch `git am`, if one patch's header gets mangled (git itself has historically done this with non-ASCII author names; format-patch + git-am bug reports exist), the hook silently no-ops on that patch, tracking stays at the _previous_ patch's SHA, and the sentinel stays set. Later patches in the same run that succeed WILL advance tracking past the missing patch. End state: tracking at last successful patch, but mirror-pull's post-loop `updateTrackingRef(mirror.remote, seg.commits[seg.commits.length - 1].sha)` on `applyRange` success covers for range apply — not for `applyPartial` (single patch) where the hook is the only advance mechanism and `mirror-pull.ts:403-405` only explicit-advances AFTER `applyPartial` returned 'applied' (belt-and-suspenders). So the silent-no-op is papered over in most cases — but the `clearMirrorInProgress` branch (`post-applypatch.ts:49-58`) can't be reached if `last` file is missing, leaving the sentinel dangling. The next `mirror pull` will then hit `amInProgress() === false` but sentinel set, which no code path currently handles cleanly (it's treated as "our am" in `continueAm`/`skipAm` — but there IS no am to continue).
- **Reproduction**:
  ```
  # start a sub-case A conflict, sentinel set, rebase-apply present
  rm .git/rebase-apply/last         # user accidentally cleans
  # resolve and run git am --continue directly (bypass mirror continue)
  # post-applypatch fires, can't parse last, returns 0 without clearing sentinel
  # sentinel is now stuck. Next mirror pull: amInProgress()=false,
  # getMirrorInProgress()='upstream' — no code checks this combo.
  ```
- **Suggested test**: Set sentinel, write a malformed `rebase-apply/next` (e.g. `"abc"` or `"0"`), call `postApplypatch()`, assert the hook did NOT modify tracking AND either cleared the sentinel OR emitted a stderr warning. Also: unit test for the stuck-sentinel state — `mirror pull` invoked with sentinel set + no am in progress should either clean up and proceed or fail with a clear message.

### CRIT-4 — `mirror pull`'s "all patches empty" early-return advances nothing; subsequent pull re-enumerates the same range

- **Code path**: `src/lib/apply.ts:67-69`. When every commit in a clean range produces an empty patch (all changes filtered by `:(exclude)` pathspec), `applyRange` returns `'applied'` with `patchBuf.length === 0`. `git am` is never invoked, `post-applypatch` never fires, and **the code in `mirror-pull.ts:231` does `updateTrackingRef(mirror.remote, seg.commits[seg.commits.length - 1].sha)` unconditionally after `applied`**, so tracking _does_ advance correctly. But the classifier guarantees no range-segment commit classifies as `out-of-scope` (those become separate `out-of-scope` commits absorbed into the range); so in practice all-empty-patch ranges happen only when excludePaths/reviewPaths filter EVERY included path. In that case tracking advances to the final commit's SHA — which is correct — but the "Applying: … / Skipping:" announcements printed by `printApplyingLines` are misleading: the user sees "Applying: X" for commits that produced no patch and landed nothing.
- **Existing test**: None exercises "range of clean commits where every commit's included subset is filtered to empty after exclude". The test at `mirror-pull.integration.test.ts:823-834` covers exclude dropping ONE commit's content, not an entire range.
- **Failure mode**: Cosmetic in the current code — tracking is correct. Fragile because the invariant depends on `updateTrackingRef` at `:231` running AFTER `applyRange` returned `'applied'`. Any future refactor that moves the explicit advance inside `if (patchBuf.length > 0)` (a reasonable-looking optimization) would silently regress to "tracking never advances, next pull enumerates the same commits forever". This is the EXACT shape of v0.6.3 (loop on prior-trust).
- **Reproduction**:
  ```
  # configure excludePaths to cover every path touched by next 3 upstream commits
  # mirror pull prints "Applying: a" × 3, advances tracking, returns 0
  # Run again: up-to-date, exit 0. Good.
  # Now imagine refactor: applyRange early-returns without the tracking-advance
  # upstream behind same state — INFINITE LOOP.
  ```
- **Suggested test**: A "fully-filtered range" test that pushes 3 in-scope-but-excluded commits and verifies (a) tracking advances to the third's SHA, (b) a second `mirrorPull` is a no-op (`up to date`). This locks in the invariant so a future optimization can't break it silently.

### HIGH-1 — No direct test for `post-checkout`, `pre-push`, or `post-merge`

- **Code path**: `src/commands/post-checkout.ts`, `src/commands/pre-push.ts`, `src/commands/post-merge.ts`. Each reads real git state, mutates config / fires other subsystems.
- **Existing test**: Only the pure dependencies (`routing.test.ts` for `decideRouting` / `validatePush`) have coverage. There is no test for:
  - `post-checkout` on detached HEAD → should no-op (exists but untested).
  - `post-checkout` when `branch.<X>.pushRemote` is already set → should no-op (`post-checkout.ts:18`).
  - `pre-push` reading stdin format correctly — especially the deletion case (`0000…`).
  - `pre-push` when the remote isn't in `collectRemotes()` (unknown remote name) — `validatePush` returns null, exit 0; untested at the integration level.
  - `pre-push` when a push refspec includes `refs/git-auto-remote/mirror/*` — is the tracking ref being pushed correctly validated (or exempted)? The code checks ancestry on ANY ref; pushing a tracking ref that points at an upstream SHA to that same upstream will pass (ancestor of its own root) but pushing to a different remote will fail. This is intentional per the SECURITY section, but there's no test that asserts it.
  - `post-merge` failure isolation — `mirror-pull.ts` can throw; `post-merge` catches and logs. Untested; a regression that propagates the throw would fail the user's outer `git pull` silently.
- **Failure mode**: Any regression to hook wiring (argv ordering, stdin format, detached-HEAD handling) goes uncaught.
- **Suggested test**: A new `hooks-entrypoint.integration.test.ts` that invokes `postCheckout(['prev','new','1'])`, `prePush(['remote','url'])` with stdin feeding, and `postMerge()` against a real temp repo, asserting the side effects. Include a detached-HEAD case and a deletion-push case.

### HIGH-2 — Continue/skip "phase mismatch" branches are unreachable-by-test

- **Code path**: `mirror-skip.ts:82-92` (`am-in-progress` phase but no am running), `mirror-continue.ts:69-73` (same).
- **Existing test**: None.
- **Failure mode**: Both branches comment-justify themselves ("the user bypassed our wrapper") but silently do a `reset --hard HEAD~1`. If the user had ALREADY created an extra commit on top (e.g. they ran `git am --continue` by hand, got into phase `review-pause`-like state, made a commit, THEN invoked `mirror skip`), the reset drops a real user commit. No test asserts the safety posture of this branch.
- **Suggested test**: Manipulate state to set a `phase: 'am-in-progress'` marker while no am is in progress, invoke `mirror skip`, assert either safe recovery or explicit refusal (not silent data loss).

### HIGH-3 — Fetch-refspec clobber immunity is tested only for the tool's OWN fetch

- **Code path**: `mirror-pull.ts:136-141` (explicit narrow refspec on `git fetch`).
- **Existing test**: `mirror-pull.integration.test.ts:1011-1183` covers the tool's fetch not being clobbered. **No test** covers the case where an unrelated `git fetch` (user, hook, editor plugin) runs between `mirror pull` completion and the next invocation AND has the misconfigured refspec — the tool's immunity is only while it's running. This is what CRIT-1 depends on during a pause window.
- **Failure mode**: Users assume v0.6.3 means "misconfigured refspecs are harmless"; in fact they're harmless only inside `mirror pull`'s fetch. A background `git fetch` during a pause still clobbers tracking.
- **Suggested test**: Reproduce the scenario: pause on sub-case B, externally run `git fetch upstream` (honoring the bad refspec), run `mirror continue`, assert either the tracking ref is re-asserted (after CRIT-1 fix) or document the behavior explicitly. Also: a warning at setup time (or `mirror status`) when the bad refspec is detected in `remote.<X>.fetch`.

### HIGH-4 — Hooks call a pinned `bunx git-auto-remote@<VERSION>`; no test for version-skew behavior

- **Code path**: `src/lib/hooks.ts:37-44`. Snippet runs `bunx --bun git-auto-remote@${VERSION}`.
- **Existing test**: `hooks.test.ts:38-43` asserts the pinning regex but not the behavior when `VERSION` differs from the installed tool.
- **Failure mode**: User upgrades `git-auto-remote` but never re-runs `setup`; hooks now invoke an older version via bunx. Tracking ref semantics, sentinel filenames, and marker format differ. Since state files (`mirror-in-progress`, `review-pending`) have migrated contents across versions (see `mirror-state.ts:79-97` tolerance layer), mismatched hook↔CLI pairs can leave state in a shape neither side understands. The tolerance layer handles _reading_ old state; it doesn't help when the old version WRITES state the new version doesn't expect.
- **Suggested test**: Install hook at version N, write a state file at version N's shape, run a hook that was installed at version M, assert clear error rather than silent corruption. (Or: always run `setup` idempotently at the top of `mirrorPull`; the docs say setup is required but nothing enforces it.)

### HIGH-5 — `continueReviewPause` "nothing staged" silent no-op loses user's failed-stage intent

- **Code path**: `mirror-continue.ts:210-241`. If `hasStagedChanges()` is false, amend is skipped. The marker is cleared and `mirrorPull` runs again.
- **Existing test**: `mirror-resume.integration.test.ts:369-383` covers this — "continue WITHOUT staging discards unstaged review leftovers". Asserts HEAD unchanged and marker cleared.
- **Failure mode** (not an existing bug, but test is SPURIOUS-pass-prone): The test asserts `git rev-parse HEAD` is unchanged and `review-pending` marker is cleared. **It does NOT assert that `mirrorPull` wasn't re-triggered with tracking pointing somewhere wrong.** If future code path advances tracking mid-continue but forgets to clear the marker, the test still passes (marker would get cleared at the END of `mirrorPull`'s normal flow when it reaches "up to date"). The test should additionally capture console.error and assert no "Applying:" line was emitted (nothing to apply) and no "Partial:" pause-on-retry occurred.
- **Suggested strengthening**: Add `captureStderr` wrapper; assert captured output is empty or contains only benign lines; assert tracking ref equals sourceSha BEFORE the continue (i.e. the marker set by pause was honored) AND after.

### HIGH-6 — `mirror-pull` assumes `currentBranch()` but post-merge runs inline with ongoing merge state

- **Code path**: `mirror-pull.ts:80-87`. `currentBranch()` returns null in detached HEAD, and is truthy during a merge (git resolves `HEAD` as a symbolic ref to the receiving branch throughout).
- **Existing test**: `mirror-pull.integration.test.ts:689-698` covers "not on sync target branch → silent skip". No test covers `mirror pull` invocation via `post-merge` when `MERGE_HEAD` exists but the user's merge hasn't completed (e.g. non-ff merge that needs a commit). `workingTreeDirty()` would catch staged/unstaged changes, but a merge-in-progress with a clean tree (after conflict resolution, before commit) would slip through — and `git am` during that state produces undefined behavior.
- **Suggested test**: Simulate a merge-in-progress (`git merge --no-commit` with changes staged), invoke `mirrorPull`; assert it refuses with a clear message (probably a new precondition check: `existsSync('.git/MERGE_HEAD')` → refuse).

### HIGH-7 — `runRegenerate`'s "leaked-out-scope" outcome is under-tested downstream

- **Code path**: `src/lib/regen.ts:105-112` plus callers in `mirror-pull.ts:241-252, 412-422, 553-562`.
- **Existing test**: `mirror-regenerate.integration.test.ts:244-266` covers the basic leak case. Asserts code 0 and the leaked file is on disk.
- **Failure mode**: The next `mirrorPull` will refuse with `workingTreeDirty()` → exit 1. No test verifies this second-order behavior: the "tool continues with dirty tree" claim in the test name is deceptive — the tool continues THIS iteration; the next iteration is stuck until the user cleans up. This is a MEDIUM friction issue, not a correctness bug, but the inline comment at `regen.ts:17-19` promises "the next `mirror pull` will refuse with dirty-tree, surfacing the config bug" — untested.
- **Suggested test**: After the leak test, run `mirrorPull` again and assert code 1 with a stderr message pointing at the leaked file. Without this test, a future refactor that auto-cleans leaked files silently would masquerade as "improvement" but hide config bugs.

### MEDIUM-1 — `mirror diff` / `mirror source` don't verify `sourceSha` is still in the object DB

- **Code path**: `mirror-diff.ts:72-92`, `mirror-source.ts:24`. Both pass `review.sourceSha` straight to `git show` / `git diff`.
- **Failure mode**: If `git gc --prune=now` runs between pause and diff (or the user force-pushed upstream and re-fetched, dropping the commit), the commands produce cryptic `fatal: bad object` errors. Not catastrophic but user-hostile.
- **Suggested test**: Synthesize a marker pointing at a SHA that's been GCed; assert a clear tool-authored error rather than raw git output.

### MEDIUM-2 — `mirror bootstrap` has no dedicated test file

- **Code path**: `src/commands/mirror-bootstrap.ts` — root-commit warning logic, `--force` override, legacy ref migration via `updateTrackingRef`.
- **Existing test**: Called by test setups but no assertions on its own behavior.
- **Suggested test**: A focused `mirror-bootstrap.integration.test.ts` covering: (a) default refuses when already bootstrapped, (b) `--force` overwrites, (c) root-commit without `--force` fails with explanatory message, (d) root-commit with `--force` succeeds, (e) unknown remote fails cleanly, (f) unresolvable ref fails cleanly.

### MEDIUM-3 — Config parsing edge cases

- **Code path**: `src/lib/mirror-config.ts:100-133`.
- **Existing test**: `mirror-config.test.ts` covers inline + file + missing-file.
- **Failure modes not covered**:
  - `syncPathsFile` containing CRLF line endings → `\r` appended to each path (prefix match fails, silent "outside-scope" classification of every file).
  - Whitespace-only file (no paths, mirror loads with `syncPaths = []` → same as "no mirror configured" but DOES get listed by `listMirrorConfigs` because the File key is present? Actually `getMirrorConfig` returns null when `syncPaths.length === 0` at line 61, but `listMirrorConfigs` filters that out. So OK — but a test would lock this in).
  - `git config --add auto-remote.X.syncPaths <value>` (multiple values) — current code uses `--get` which returns only the last value, silently dropping earlier ones. Users may not realize.
  - `syncPathsFile` with an absolute path — `join(root, '/etc/evil')` gives `/etc/evil`; arguably intentional but untested and worth locking down.
- **Suggested test**: Add each of these as cases in `mirror-config.test.ts`. The CRLF case is most likely to bite a Windows user.

### MEDIUM-4 — `post-applypatch` "last patch = clear sentinel" uses `>=` not `==`

- **Code path**: `post-applypatch.ts:51`. `if (Number.isFinite(last) && next >= last)` — uses `>=`.
- **Failure mode**: Under any git state where `next > last` (shouldn't happen in normal operation but could occur in weird git-am abort/retry scenarios), the sentinel clears prematurely. Unlikely but the `>=` vs `===` choice deserves a comment OR a test that pins down the invariant.
- **Suggested test**: A case where `next > last` (synthesize it) and assert what the hook does. Probably the right answer is: the hook STILL clears the sentinel defensively, but the test makes that behavior intentional.

### MEDIUM-5 — `mirror pull`'s "am-in-progress OR review-pending" precondition check at lines 91-103 only checks review-pending for the CURRENT mirror

- **Code path**: `mirror-pull.ts:97-103`. `if (review && review.remote === mirror.remote)` — refuses when review-pending matches THIS mirror. When iterating multiple mirrors (no `remote` argument), a pending review for mirror A lets mirror B's pull proceed.
- **Failure mode**: Probably intentional (mirrors are independent), but if the am-in-progress sentinel is for mirror A, mirror B's pull will still call `git am` and collide on `.git/rebase-apply`. The `amInProgress()` check at :91 catches this — good. But `getReviewPending()` doesn't check for "some other mirror is paused", meaning during an interactive review on mirror A, a `mirror pull` (no remote) for ALL mirrors would silently process mirror B's updates out-of-order. Subtle and not clearly documented.
- **Suggested test**: Two mirrors configured, pause on mirror A (sub-case B), run `mirror pull` with no remote argument; assert either mirror B is processed (current behavior) OR refused (would require a code change). Either way, lock it in.

## Suggested next action

Fix in this order:

1. **CRIT-1** (blocker for v0.6.4): re-assert tracking ref in all `mirror continue` paths analogous to v0.6.3 skip fix. Two-line change per branch; tests can be copy-paste of the v0.6.3 skip perturbation tests. This is almost certainly the next bug the maintainer will file against this code.

2. **HIGH-1** (v0.6.4 or v0.7.0): cover `post-checkout`, `pre-push`, `post-merge` with at least happy-path + one edge-case each. They're the tool's OS-level entry points and a regression here manifests as "the whole thing stops working" rather than a specific error message.

3. **CRIT-3 + MEDIUM-4** (v0.7.0): harden `post-applypatch` validations and add tests for each defensive branch. Pair with a cleanup path in `mirrorPull` for stuck-sentinel state. Post-applypatch is the only other place that "trusts prior state" in the same shape as the v0.6.3 bug.

CRIT-2 and CRIT-4 are lower probability but high-consequence; address alongside CRIT-1 if scope allows, otherwise queue for v0.7.0. HIGH-2 through HIGH-7 are incremental hardening suitable for any point release.
