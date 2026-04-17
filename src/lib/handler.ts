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
  excludedPaths: readonly string[];
};

/**
 * Invoke the user-configured partial handler with a stable env/argv contract.
 * Returns an outcome describing what to do next. Never throws.
 */
export function runPartialHandler(handlerCmd: string, input: HandlerInput): HandlerOutcome {
  const env = {
    ...process.env,
    MIRROR_REMOTE: input.remote,
    MIRROR_SOURCE_SHA: input.sourceSha,
    MIRROR_SOURCE_SUBJECT: input.sourceSubject,
    MIRROR_INCLUDED_PATHS: input.includedPaths.join('\n'),
    MIRROR_EXCLUDED_PATHS: input.excludedPaths.join('\n'),
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
