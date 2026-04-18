import { execFileSync, spawnSync } from 'node:child_process';
import { git } from './git.js';

/**
 * Rewrite the range `fromSha..toSha` (exclusive of fromSha, inclusive of toSha)
 * so that each commit's committer identity equals its author identity. Also
 * updates HEAD to the new top commit.
 *
 * Why this exists:
 *
 *   `git am` preserves the patch's author header on the applied commit, but
 *   uses the CURRENT user (whoever invokes git am) as the committer. There
 *   is no `git am` flag to align committer name/email with author - only
 *   `--committer-date-is-author-date` handles the DATE. Similarly for
 *   `git commit --amend --no-edit`: committer is always refreshed to the
 *   current invoker. For mirror/sync replays where local commits should be
 *   indistinguishable from source commits in metadata, this leaks the tool
 *   runner's identity into every replayed commit.
 *
 *   The idiomatic-but-discouraged approach is `git filter-branch --env-filter
 *   'export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME; ...'`. Git itself recommends
 *   against filter-branch ("plethora of pitfalls", "abysmal performance") and
 *   points at `git filter-repo` which is an external tool we don't want to
 *   depend on.
 *
 *   This helper does what filter-branch does internally - `git commit-tree`
 *   with per-commit env - minus the shell-evaluation layer, the
 *   `refs/original/*` backup refs, and the deprecation warning. One pass per
 *   applyRange batch, about 20ms per commit.
 *
 * Safety:
 *
 *   - Merge commits: reads all parents from the commit object and passes
 *     them through. Linear replay flows produce no merges, but handle them
 *     correctly if they appear.
 *   - Empty range (fromSha == toSha): no-op.
 *   - Parent chain: each rewritten commit's parent is the rewritten previous
 *     commit, not the original. `fromSha` itself is not rewritten (it's the
 *     pre-batch HEAD we build on top of).
 *   - Encoding: uses -z null-terminated format to preserve embedded newlines
 *     in commit messages.
 *
 * Tracking ref independence:
 *
 *   Our mirror tracking ref stores SOURCE SHAs (the upstream commit whose
 *   patch we applied), not our local SHAs. SOURCE SHAs are read from the
 *   patch "From " header by the post-applypatch hook. Rewriting our local
 *   commits here does NOT invalidate the tracking ref.
 */
export function rewriteCommitterToAuthor(fromSha: string, toSha: string): void {
  if (fromSha === toSha) return;

  // List commits in the range in topological order (oldest first).
  const rangeOut = execFileSync('git', ['rev-list', '--reverse', `${fromSha}..${toSha}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const originalShas = rangeOut.split('\n').filter((s) => s.length > 0);
  if (originalShas.length === 0) return;

  // Map original SHA -> rewritten SHA. Parent lookup when rewriting uses
  // this map to substitute the rewritten ancestor; anything outside the
  // range (i.e. fromSha and earlier) stays as-is.
  const rewrittenBySha = new Map<string, string>();

  for (const sha of originalShas) {
    const parsed = readCommitForRewrite(sha);
    const mappedParents = parsed.parents.map((p) => rewrittenBySha.get(p) ?? p);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: parsed.authorName,
      GIT_AUTHOR_EMAIL: parsed.authorEmail,
      GIT_AUTHOR_DATE: parsed.authorDate,
      // The v0.6.0 invariant: committer identity matches author identity.
      GIT_COMMITTER_NAME: parsed.authorName,
      GIT_COMMITTER_EMAIL: parsed.authorEmail,
      GIT_COMMITTER_DATE: parsed.authorDate,
    };

    const parentArgs: string[] = [];
    for (const p of mappedParents) {
      parentArgs.push('-p', p);
    }

    const result = spawnSync('git', ['commit-tree', parsed.tree, ...parentArgs], {
      input: parsed.message,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      const stderr = (result.stderr ?? '').toString();
      throw new Error(`git commit-tree failed rewriting ${sha}: ${stderr}`);
    }
    const newSha = (result.stdout ?? '').toString().trim();
    if (!/^[0-9a-f]{40}$/.test(newSha)) {
      throw new Error(`git commit-tree produced unexpected output for ${sha}: '${newSha}'`);
    }
    rewrittenBySha.set(sha, newSha);
  }

  // Update HEAD to point at the rewritten top. Use `git update-ref -m` so
  // the reflog captures the intent.
  const newTop = rewrittenBySha.get(originalShas[originalShas.length - 1]);
  if (!newTop) {
    throw new Error('rewriteCommitterToAuthor: internal error - missing rewritten top');
  }
  // Update the currently checked-out branch ref directly (HEAD may be a
  // symbolic ref). `git update-ref HEAD` follows symbolic refs.
  git('update-ref', '-m', 'git-auto-remote: committer=author rewrite', 'HEAD', newTop);
}

type ParsedCommit = {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  /** Raw commit message body + trailing newline, ready to pipe into commit-tree. */
  message: string;
};

/**
 * Parse the fields we need from a commit object. We use `cat-file -p` for
 * the commit message verbatim (preserves any leading/trailing whitespace
 * the original had) and `--format` for structured fields.
 *
 * Author identity is read in committish format (from %an/%ae/%aI) and
 * passed back through GIT_AUTHOR_* env on commit-tree.
 */
function readCommitForRewrite(sha: string): ParsedCommit {
  // Structured fields via pretty format; NUL-separated to avoid
  // ambiguity with commit message content.
  const fieldFormat = '%T%x00%P%x00%an%x00%ae%x00%aI';
  const fieldsOut = execFileSync('git', ['show', '-s', `--format=${fieldFormat}`, sha], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [tree = '', parentList = '', authorName = '', authorEmail = '', authorDate = ''] = fieldsOut
    .replace(/\n+$/, '')
    .split('\x00');
  if (!/^[0-9a-f]{40}$/.test(tree)) {
    throw new Error(`readCommitForRewrite: bad tree for ${sha}: '${tree}'`);
  }
  const parents = parentList.split(' ').filter((s) => s.length > 0);

  // Message as bytes: `git cat-file -p <sha>` prints the raw commit object
  // (header + blank line + message). Strip through the first blank line to
  // get just the message. This preserves any trailing newline and body
  // formatting exactly.
  const raw = execFileSync('git', ['cat-file', '-p', sha], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const blankIdx = raw.indexOf('\n\n');
  const message = blankIdx === -1 ? '' : raw.slice(blankIdx + 2);

  return { tree, parents, authorName, authorEmail, authorDate, message };
}
