import { spawnSync } from 'node:child_process';
import { workingTreeDirty } from './git.js';

/**
 * Exit codes from the partialHandler script.
 *
 *   0 = resolved: HEAD (possibly amended) is the acceptable state; continue sync
 *   2 = skip: this commit should not be mirrored; tool will reset HEAD~1 and advance
 *   any other = punt: human review required; tool pauses (interactive) or stops (CI)
 */
export type HandlerOutcome = 'resolved' | 'skipped' | 'punted' | 'dirty-tree';

export type HandlerInput = {
  remote: string;
  sourceSha: string;
  sourceSubject: string;
  includedPaths: readonly string[];
  reviewPaths: readonly string[];
  outsidePaths: readonly string[];
};

/**
 * Invoke the user-configured partial handler with a stable env/argv contract.
 * Returns an outcome describing what to do next. Never throws.
 *
 * When the handler is called:
 *   - HEAD has the `included` subset applied (preserving source author + author-date)
 *   - Working tree has the `review` subset unstaged (ready for `git add -p` / `git restore`)
 *   - `outside` paths are NOT in HEAD and NOT in worktree; just reported for context
 *   - `git am` is NOT in progress (conflicts during apply are surfaced up the stack, not here)
 *
 * The handler may `git add` + `git commit --amend --no-edit` to roll review content
 * into HEAD (author + author-date stay intact), `git restore` to drop it, or mix.
 */
export function runPartialHandler(handlerCmd: string, input: HandlerInput): HandlerOutcome {
  const env = {
    ...process.env,
    MIRROR_REMOTE: input.remote,
    MIRROR_SOURCE_SHA: input.sourceSha,
    MIRROR_SOURCE_SUBJECT: input.sourceSubject,
    MIRROR_INCLUDED_PATHS: input.includedPaths.join('\n'),
    MIRROR_REVIEW_PATHS: input.reviewPaths.join('\n'),
    MIRROR_OUTSIDE_PATHS: input.outsidePaths.join('\n'),
  };

  // Structured positional args: <remote> <sourceSha>
  // Paths go through env (newline-separated) to avoid argv-length limits.
  const result = spawnSync(handlerCmd, [input.remote, input.sourceSha], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: false,
  });

  if (result.error) return 'punted';
  const code = result.status;
  if (code === 0) return workingTreeDirty() ? 'dirty-tree' : 'resolved';
  if (code === 2) return 'skipped';
  return 'punted';
}
