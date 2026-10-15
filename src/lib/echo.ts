import { execFileSync } from 'node:child_process';
import type { ClassifiedCommit } from './classify.js';
import { git, gitTry } from './git.js';

/**
 * Mirror commits `target` already has in some form, so replaying them would only bring a change back or undo a
 * person's decision: the change crossed the other way earlier, or a person resolved its conflict in a review ref
 * that was merged. `git am --empty=drop` drops such a commit only while the target holds its exact result; once a
 * later target commit touched its lines, or the person kept other content, the 3-way merge conflicts on every pull.
 *
 * A crossing keeps the commit's author and message (git am, rebase, cherry-pick and the review ref all do), so the
 * target has it when it carries more commits with the same author, author time and message than `source` has before
 * it (a source that holds two such commits gets each through once). A copy whose message was edited on the way is
 * still found by its content: a target commit authored in the same second that changed every file the copy would
 * apply from the same content to the same content.
 */
export function findEchoes(
  commits: readonly ClassifiedCommit[],
  target: string,
  source: string,
): ReadonlySet<string> {
  const byTime = new Map<string, string[]>();
  const onTarget = new Map<string, number>();
  for (const { sha, time, id } of authored(target)) {
    byTime.set(time, [...(byTime.get(time) ?? []), sha]);
    onTarget.set(id, (onTarget.get(id) ?? 0) + 1);
  }
  const earlier = new Map<string, { id: string; count: number }>();
  const seen = new Map<string, number>();
  for (const { sha, id } of authored(source).reverse()) {
    const count = seen.get(id) ?? 0;
    earlier.set(sha, { id, count });
    seen.set(id, count + 1);
  }
  const echoes = new Set<string>();
  for (const { sha, classification } of commits) {
    if (classification.kind === 'out-of-scope') continue;
    const own = earlier.get(sha);
    if (own && (onTarget.get(own.id) ?? 0) > own.count) {
      echoes.add(sha);
      continue;
    }
    const paths =
      classification.kind === 'partial' ? [...classification.included, ...classification.review] : classification.included;
    if (paths.length === 0) continue;
    const change = fileChanges(sha, paths);
    const originals = byTime.get(git('log', '-1', '--format=%at', sha)) ?? [];
    if (originals.some((original) => fileChanges(original, paths) === change)) echoes.add(sha);
  }
  return echoes;
}

/**
 * Every commit of <ref>, newest first: its author time, and its author, author time and message as one key. Read
 * directly rather than through `git()`: a few thousand messages pass the default 1 MiB output limit.
 */
function authored(ref: string): { sha: string; time: string; id: string }[] {
  const log = execFileSync('git', ['log', '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%B%x1e', ref], {
    encoding: 'utf8',
    maxBuffer: Number.POSITIVE_INFINITY,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return log.split('\x1e').flatMap((record) => {
    const [sha, name, email, time, message] = record.replace(/^\n/, '').split('\x1f');
    if (!sha || !time) return [];
    return [{ sha, time, id: [name, email, time, message?.trim()].join('\x1f') }];
  });
}

/** How <sha> changed <paths>: each path's mode and content before and after, as `git diff-tree` reports them. */
function fileChanges(sha: string, paths: readonly string[]): string | null {
  return gitTry('--literal-pathspecs', 'diff-tree', '-r', '--root', '--no-renames', '--no-commit-id', sha, '--', ...paths);
}
