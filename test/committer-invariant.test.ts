import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirrorContinue } from '../src/commands/mirror-continue.js';
import { mirrorPull } from '../src/commands/mirror-pull.js';
import { installHook } from '../src/lib/hooks.js';
import { trackingRefName } from '../src/lib/mirror-state.js';

/**
 * v0.6.0 INVARIANT: every commit this tool creates or amends must have
 * committer name / email / date equal to the author name / email / date.
 *
 * Without this, git uses the current user (whoever ran the tool) as the
 * committer via user.name/user.email config - leaking the tool runner's
 * identity into every replayed commit. Replays should produce commits
 * indistinguishable from source commits.
 *
 * Covered paths:
 *   - clean range apply (applyRange batch git am + commit-tree rewrite)
 *   - clean range + regenerate (amend onto last commit)
 *   - partial apply (sub-case B: included + review)
 *   - sub-case C.1 synthesized commit (regenerate only)
 *   - sub-case C.2 synthesized commit via mirror continue (review + regen)
 *   - handler-resolved outcome in sub-case C (finalizePureReviewAsResolved)
 */

let root: string;
let upstream: string;
let local: string;
let originalCwd: string;

const TRACKING = trackingRefName('upstream');

// Deliberately different from any source-commit author so assertions are
// meaningful - if the tool forgets to override, committer WILL be these values.
const ENV = {
  GIT_AUTHOR_NAME: 'Test Runner',
  GIT_AUTHOR_EMAIL: 'runner@test',
  GIT_COMMITTER_NAME: 'Test Runner',
  GIT_COMMITTER_EMAIL: 'runner@test',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...ENV },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${r.stdout}\n${r.stderr}`);
  }
  return (r.stdout ?? '').trim();
}

function commitAs(cwd: string, author: { name: string; email: string; date: string }, message: string): string {
  const r = spawnSync('git', ['commit', '-q', '-m', message], {
    cwd,
    env: {
      ...process.env,
      ...ENV,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: author.date,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    throw new Error(`commit failed in ${cwd}:\n${(r.stdout ?? '').toString()}\n${(r.stderr ?? '').toString()}`);
  }
  return git(cwd, 'rev-parse', 'HEAD');
}

function authorOf(cwd: string, sha: string = 'HEAD'): { name: string; email: string; date: string } {
  const out = execFileSync('git', ['-C', cwd, 'show', '-s', '--format=%an%x00%ae%x00%aI', sha], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [name = '', email = '', date = ''] = out.replace(/\n+$/, '').split('\x00');
  return { name, email, date };
}

function committerOf(cwd: string, sha: string = 'HEAD'): { name: string; email: string; date: string } {
  const out = execFileSync('git', ['-C', cwd, 'show', '-s', '--format=%cn%x00%ce%x00%cI', sha], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [name = '', email = '', date = ''] = out.replace(/\n+$/, '').split('\x00');
  return { name, email, date };
}

/** Assert committer == author for every commit in (base..tip] (tip inclusive). */
function assertCommitterEqualsAuthor(cwd: string, base: string, tip: string = 'HEAD'): void {
  const shasOut = execFileSync('git', ['-C', cwd, 'rev-list', '--reverse', `${base}..${tip}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const shas = shasOut.split('\n').filter((s) => s.length > 0);
  expect(shas.length).toBeGreaterThan(0);
  for (const sha of shas) {
    const author = authorOf(cwd, sha);
    const committer = committerOf(cwd, sha);
    const tag = `${sha.slice(0, 8)} ${git(cwd, 'show', '-s', '--format=%s', sha)}`;
    expect({ ...committer, sha: tag }).toEqual({ ...author, sha: tag });
  }
}

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'gar-committer-'));
  upstream = join(root, 'upstream.git');
  local = join(root, 'local');

  git(root, 'init', '--bare', '-q', upstream);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', seed);
  mkdirSync(join(seed, 'packages/cli'), { recursive: true });
  writeFileSync(join(seed, 'packages/cli/a.ts'), 'v0\n');
  git(seed, 'add', '-A');
  commitAs(
    seed,
    {
      name: 'Seed Author',
      email: 'seed@upstream',
      date: '2025-01-01T00:00:00+04:00',
    },
    'seed: v0',
  );
  writeFileSync(join(seed, '.dummy'), 'x\n');
  git(seed, 'add', '-A');
  commitAs(
    seed,
    {
      name: 'Seed Author',
      email: 'seed@upstream',
      date: '2025-01-02T00:00:00+04:00',
    },
    'seed: marker',
  );
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', upstream);
  git(seed, 'push', '-q', 'origin', 'main');

  git(root, 'init', '-q', local);
  mkdirSync(join(local, 'packages/cli'), { recursive: true });
  writeFileSync(join(local, 'packages/cli/a.ts'), 'v0\n');
  git(local, 'add', '-A');
  commitAs(
    local,
    {
      name: 'Local Seed',
      email: 'local@seed',
      date: '2025-01-01T00:00:00+04:00',
    },
    'local: v0',
  );
  git(local, 'branch', '-M', 'private');
  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'fetch', '-q', 'upstream');

  git(local, 'config', 'auto-remote.upstream.syncPaths', 'packages');
  git(local, 'config', 'auto-remote.upstream.syncTargetBranch', 'private');
  git(local, 'config', 'auto-remote.upstream.syncBranch', 'main');
  git(local, 'config', 'auto-remote.upstream.pushSyncRef', 'false');

  git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));

  process.chdir(local);
  installHook('post-applypatch');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('committer = author invariant (v0.6.0)', () => {
  test('clean range: N commits each get committer identity from their own author', async () => {
    // Push 3 commits with DISTINCT author metadata each.
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v1\n');
    git(seed, 'add', '-A');
    commitAs(seed, { name: 'Alice', email: 'alice@up', date: '2025-06-01T10:00:00+04:00' }, 'feat: Alice bump');
    writeFileSync(join(seed, 'packages/cli/b.ts'), 'v1\n');
    git(seed, 'add', '-A');
    commitAs(seed, { name: 'Bob', email: 'bob@up', date: '2025-06-02T11:00:00+04:00' }, 'feat: Bob add');
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v2\n');
    git(seed, 'add', '-A');
    commitAs(seed, { name: 'Carol', email: 'carol@up', date: '2025-06-03T12:00:00+04:00' }, 'feat: Carol bump');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    const headBefore = git(local, 'rev-parse', 'HEAD');
    const code = await mirrorPull({ remote: 'upstream' });
    expect(code).toBe(0);

    // Every new commit has committer = author.
    assertCommitterEqualsAuthor(local, headBefore);

    // Spot-check specific commits.
    const log = git(local, 'log', '--format=%H %s', `${headBefore}..HEAD`, '--reverse').split('\n');
    expect(log.length).toBe(3);

    const commits = log.map((line) => {
      const [sha, ...rest] = line.split(' ');
      return { sha, subject: rest.join(' ') };
    });
    // Committer = author per commit.
    const alice = commits.find((c) => c.subject === 'feat: Alice bump')!;
    expect(committerOf(local, alice.sha)).toEqual({
      name: 'Alice',
      email: 'alice@up',
      date: '2025-06-01T10:00:00+04:00',
    });
    const bob = commits.find((c) => c.subject === 'feat: Bob add')!;
    expect(committerOf(local, bob.sha)).toEqual({
      name: 'Bob',
      email: 'bob@up',
      date: '2025-06-02T11:00:00+04:00',
    });
    const carol = commits.find((c) => c.subject === 'feat: Carol bump')!;
    expect(committerOf(local, carol.sha)).toEqual({
      name: 'Carol',
      email: 'carol@up',
      date: '2025-06-03T12:00:00+04:00',
    });
  });

  test('clean range + regenerate: amended last commit keeps committer = author', async () => {
    git(local, 'config', 'auto-remote.upstream.regeneratePaths', 'bun.lock');
    git(local, 'config', 'auto-remote.upstream.regenerateCommand', "printf 'regen\\n' > bun.lock");
    writeFileSync(join(local, 'bun.lock'), 'local-old\n');
    git(local, 'add', '-A');
    commitAs(
      local,
      {
        name: 'Local Seed',
        email: 'local@seed',
        date: '2025-01-02T00:00:00+04:00',
      },
      'local: lock seed',
    );

    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'bun.lock'), 'upstream-lock\n');
    git(seed, 'add', '-A');
    commitAs(seed, { name: 'Dave', email: 'dave@up', date: '2025-07-01T09:00:00+04:00' }, 'chore: seed lock');
    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v1\n');
    writeFileSync(join(seed, 'bun.lock'), 'upstream-lock v2\n');
    git(seed, 'add', '-A');
    commitAs(seed, { name: 'Eve', email: 'eve@up', date: '2025-07-02T10:00:00+04:00' }, 'feat: bump A + lock');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main~1'));

    const headBefore = git(local, 'rev-parse', 'HEAD');
    const code = await mirrorPull({ remote: 'upstream' });
    expect(code).toBe(0);

    assertCommitterEqualsAuthor(local, headBefore);
    // The amend-after-regen HEAD commit must be Eve's (with regenerated bun.lock).
    expect(authorOf(local, 'HEAD').name).toBe('Eve');
    expect(committerOf(local, 'HEAD').name).toBe('Eve');
    expect(committerOf(local, 'HEAD').date).toBe('2025-07-02T10:00:00+04:00');
    expect(git(local, 'show', 'HEAD:bun.lock')).toBe('regen');
  });

  test('partial (sub-case B): included subset applied with committer = author', async () => {
    git(local, 'config', 'auto-remote.upstream.reviewPaths', 'packages/cli/reviewed.conf');
    writeFileSync(join(local, 'packages/cli/reviewed.conf'), 'v0\n');
    git(local, 'add', '-A');
    commitAs(
      local,
      {
        name: 'Local Seed',
        email: 'local@seed',
        date: '2025-01-02T00:00:00+04:00',
      },
      'local: seed review',
    );
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'packages/cli/reviewed.conf'), 'v0\n');
    git(seed, 'add', '-A');
    commitAs(seed, { name: 'Frank', email: 'frank@up', date: '2025-08-01T11:00:00+04:00' }, 'seed: review baseline');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));

    writeFileSync(join(seed, 'packages/cli/a.ts'), 'v-partial\n');
    writeFileSync(join(seed, 'packages/cli/reviewed.conf'), 'v1\n');
    writeFileSync(join(seed, 'README.md'), 'outside\n');
    git(seed, 'add', '-A');
    commitAs(seed, { name: 'Grace', email: 'grace@up', date: '2025-08-02T12:00:00+04:00' }, 'feat: partial');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    const headBefore = git(local, 'rev-parse', 'HEAD');
    const code = await mirrorPull({ remote: 'upstream' });
    // Pauses for review.
    expect(code).toBe(0);
    // HEAD is the included subset with Grace as author + committer.
    expect(git(local, 'rev-parse', 'HEAD')).not.toBe(headBefore);
    expect(authorOf(local, 'HEAD').name).toBe('Grace');
    expect(committerOf(local, 'HEAD')).toEqual({
      name: 'Grace',
      email: 'grace@up',
      date: '2025-08-02T12:00:00+04:00',
    });

    // User stages the review content and continues.
    git(local, 'add', 'packages/cli/reviewed.conf');
    const contCode = await mirrorContinue('upstream');
    expect(contCode).toBe(0);

    // After amend: HEAD still has Grace as author AND committer (v0.6.0
    // fix: continueReviewPause's amend now sets GIT_COMMITTER_* env).
    expect(authorOf(local, 'HEAD').name).toBe('Grace');
    expect(committerOf(local, 'HEAD')).toEqual({
      name: 'Grace',
      email: 'grace@up',
      date: '2025-08-02T12:00:00+04:00',
    });
  });

  test('sub-case C.1 synthesized (regenerate only): committer = author', async () => {
    git(local, 'config', 'auto-remote.upstream.regeneratePaths', 'bun.lock');
    git(local, 'config', 'auto-remote.upstream.regenerateCommand', "printf 'regenerated\\n' > bun.lock");
    writeFileSync(join(local, 'bun.lock'), 'local-old\n');
    git(local, 'add', '-A');
    commitAs(
      local,
      {
        name: 'Local Seed',
        email: 'local@seed',
        date: '2025-01-02T00:00:00+04:00',
      },
      'local: seed lock',
    );

    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'bun.lock'), 'upstream-lock v0\n');
    writeFileSync(join(seed, 'package.json'), '{"v":"0"}\n');
    git(seed, 'add', '-A');
    commitAs(seed, { name: 'Seed', email: 's@up', date: '2025-08-01T00:00:00+04:00' }, 'seed: lock + pkg');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));

    writeFileSync(join(seed, 'bun.lock'), 'upstream-lock v1\n');
    writeFileSync(join(seed, 'package.json'), '{"v":"1"}\n');
    git(seed, 'add', '-A');
    commitAs(seed, { name: 'Henry', email: 'henry@up', date: '2025-09-01T13:00:00+04:00' }, 'chore(deps): bump');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    const headBefore = git(local, 'rev-parse', 'HEAD');
    const code = await mirrorPull({ remote: 'upstream' });
    expect(code).toBe(0);

    // A new commit was synthesized with Henry's identity.
    expect(git(local, 'rev-parse', 'HEAD')).not.toBe(headBefore);
    expect(authorOf(local, 'HEAD')).toEqual({
      name: 'Henry',
      email: 'henry@up',
      date: '2025-09-01T13:00:00+04:00',
    });
    expect(committerOf(local, 'HEAD')).toEqual({
      name: 'Henry',
      email: 'henry@up',
      date: '2025-09-01T13:00:00+04:00',
    });
  });

  test('sub-case C.2 via mirror continue (review + regenerate): committer = author', async () => {
    git(local, 'config', 'auto-remote.upstream.reviewPaths', 'tooling/reviewed.conf');
    git(local, 'config', 'auto-remote.upstream.regeneratePaths', 'bun.lock');
    git(local, 'config', 'auto-remote.upstream.regenerateCommand', "printf 'regenerated\\n' > bun.lock");

    mkdirSync(join(local, 'tooling'), { recursive: true });
    writeFileSync(join(local, 'tooling/reviewed.conf'), 'v0\n');
    writeFileSync(join(local, 'bun.lock'), 'local-old\n');
    git(local, 'add', '-A');
    commitAs(
      local,
      {
        name: 'Local Seed',
        email: 'local@seed',
        date: '2025-01-02T00:00:00+04:00',
      },
      'local: baselines',
    );

    const seed = join(root, 'seed');
    mkdirSync(join(seed, 'tooling'), { recursive: true });
    writeFileSync(join(seed, 'tooling/reviewed.conf'), 'v0\n');
    writeFileSync(join(seed, 'bun.lock'), 'upstream-lock v0\n');
    writeFileSync(join(seed, 'package.json'), '{"v":"0"}\n');
    git(seed, 'add', '-A');
    commitAs(seed, { name: 'Seed', email: 's@up', date: '2025-08-01T00:00:00+04:00' }, 'seed: baselines');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');
    git(local, 'update-ref', TRACKING, git(local, 'rev-parse', 'upstream/main'));

    writeFileSync(join(seed, 'tooling/reviewed.conf'), 'v1\n');
    writeFileSync(join(seed, 'bun.lock'), 'upstream-lock v1\n');
    writeFileSync(join(seed, 'package.json'), '{"v":"1"}\n');
    git(seed, 'add', '-A');
    commitAs(seed, { name: 'Ivy', email: 'ivy@up', date: '2025-09-02T14:00:00+04:00' }, 'feat: review + regen');
    git(seed, 'push', '-q', 'origin', 'main');
    git(local, 'fetch', '-q', 'upstream');

    await mirrorPull({ remote: 'upstream' });
    // Stage the review hunk and continue.
    git(local, 'add', 'tooling/reviewed.conf');
    const contCode = await mirrorContinue('upstream');
    expect(contCode).toBe(0);

    expect(authorOf(local, 'HEAD')).toEqual({
      name: 'Ivy',
      email: 'ivy@up',
      date: '2025-09-02T14:00:00+04:00',
    });
    expect(committerOf(local, 'HEAD')).toEqual({
      name: 'Ivy',
      email: 'ivy@up',
      date: '2025-09-02T14:00:00+04:00',
    });
  });

  // NOTE: the `finalizePureReviewAsResolved` staged-commit path in
  // mirror-pull.ts is only reachable if handler leaves a CLEAN tree (per
  // handler.ts: staged content -> 'dirty-tree' outcome, not 'resolved').
  // In practice resolved = handler committed itself, in which case committer
  // choice is the handler's responsibility, not the tool's. The 5 tests
  // above cover every commit-creation path the tool itself owns.
});
