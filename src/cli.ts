#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { detect } from './commands/detect.js';
import { mirrorBootstrap } from './commands/mirror-bootstrap.js';
import { mirrorContinue } from './commands/mirror-continue.js';
import { mirrorDiff } from './commands/mirror-diff.js';
import { mirrorList } from './commands/mirror-list.js';
import { mirrorPull } from './commands/mirror-pull.js';
import { mirrorSkip } from './commands/mirror-skip.js';
import { mirrorSource } from './commands/mirror-source.js';
import { mirrorStatus } from './commands/mirror-status.js';
import { postApplypatch } from './commands/post-applypatch.js';
import { postCheckout } from './commands/post-checkout.js';
import { postMerge } from './commands/post-merge.js';
import { prePush } from './commands/pre-push.js';
import { setup } from './commands/setup.js';
import { status } from './commands/status.js';
import { uninstall } from './commands/uninstall.js';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  version: string;
};

/**
 * Wrap a command implementation (returning an exit code) as a commander action.
 * Commander swallows return values, so we translate non-zero codes into
 * process.exit(). Errors thrown inside bubble up to the top-level catch.
 */
function asAction<Args extends unknown[]>(fn: (...args: Args) => number | Promise<number>) {
  return async (...args: Args) => {
    const code = await fn(...args);
    if (code !== 0) process.exit(code);
  };
}

const program = new Command()
  .name('git-auto-remote')
  .description('Auto-route push/pull + mirror sync for repos with disjoint-history remotes')
  .version(pkg.version)
  // Required so `mirror diff` / `mirror source` can use .passThroughOptions()
  // to forward trailing flags (`--stat`, `--name-only`, ...) verbatim to git.
  .enablePositionalOptions();

// --- Core commands ----------------------------------------------------------

program
  .command('setup')
  .description('Install chainable git hooks (idempotent)')
  .option('--quiet', 'Suppress informational output (still prints errors)')
  .action(asAction((opts: { quiet?: boolean }) => setup({ quiet: !!opts.quiet })));

program
  .command('status')
  .description("Show the current branch's auto-routing decision and any cross-history conflicts")
  .action(asAction(() => status()));

program
  .command('detect [ref]')
  .description('Run ancestry analysis for a ref (default: HEAD)')
  .action(asAction((ref: string | undefined) => detect(ref)));

program
  .command('uninstall')
  .description('Remove git-auto-remote marker block from .git/hooks/* (other content preserved)')
  .action(asAction(() => uninstall()));

// --- Mirror commands --------------------------------------------------------

const mirror = program
  .command('mirror')
  .description('Cherry-pick sync from a remote with disjoint history')
  .enablePositionalOptions()
  .exitOverride();

mirror
  .command('list')
  .description('List all configured mirror remotes with their full config')
  .action(asAction(() => mirrorList()));

mirror
  .command('status [remote]')
  .description('Show sync state for one or all configured mirrors')
  .option('--remotes', 'Also enumerate refs/git-auto-remote/mirror/* on each remote (cross-clone drift diagnostic)')
  .addHelpText(
    'after',
    `
Output legend per ref (with --remotes):
  (matches local)             remote SHA == local SHA
  (differs from local: <sha>) remote SHA != local SHA
  (no local ref)              remote-only ref
  (no mirror refs on remote)  remote has none
  (ls-remote failed: ...)     network/auth/missing remote (inline error, exit 0)
`,
  )
  .action(
    asAction((remote: string | undefined, opts: { remotes?: boolean }) =>
      mirrorStatus(remote, { showRemotes: !!opts.remotes }),
    ),
  );

mirror
  .command('bootstrap <remote> <sha>')
  .description('Initialize tracking ref (optional; mirror pull works without)')
  .option('--force', 'Overwrite existing tracking ref, or bootstrap at a root commit')
  .addHelpText(
    'after',
    `
SECURITY: the tracking ref points at a SHA from <remote>. Pushing this ref
to a different remote transfers full object closure - every reachable commit,
tree, blob - making source content accessible on the destination remote.
Configure remote.<X>.push as same-direction-only on public-facing remotes.
See README "Tracking-ref durability > SECURITY".
`,
  )
  .action(
    asAction((remote: string, sha: string, opts: { force?: boolean }) => mirrorBootstrap(remote, sha, !!opts.force)),
  );

mirror
  .command('pull [remote]')
  .description('Apply new commits from <remote> onto current branch')
  .option('--non-interactive', 'Stop at first partial/conflict instead of pausing (CI mode)')
  .option('--on-partial <cmd>', 'Shell command invoked on each partial commit')
  .addHelpText(
    'after',
    `
Handler env: MIRROR_REMOTE, MIRROR_SOURCE_SHA, MIRROR_SOURCE_SUBJECT,
             MIRROR_INCLUDED_PATHS, MIRROR_REVIEW_PATHS,
             MIRROR_REGENERATE_PATHS, MIRROR_OUTSIDE_PATHS
Exit code: 0 resolved, 1 punt, 2 skip. Dirty worktree on exit -> abort.
`,
  )
  .action(
    asAction((remote: string | undefined, opts: { nonInteractive?: boolean; onPartial?: string }) =>
      mirrorPull({
        remote,
        nonInteractive: !!opts.nonInteractive,
        onPartial: opts.onPartial ?? null,
      }),
    ),
  );

mirror
  .command('continue [remote]')
  .description('Resume mirror sync from any paused state')
  .action(asAction((remote: string | undefined) => mirrorContinue(remote)));

mirror
  .command('skip [remote]')
  .description('Drop the paused source commit and resume sync')
  .action(asAction((remote: string | undefined) => mirrorSkip(remote)));

// Passthrough commands: trailing args forwarded verbatim to git diff / git show.
// `.passThroughOptions()` tells commander to stop option parsing at the first
// positional so flags like `--stat` end up in the variadic gitArgs instead of
// triggering "unknown option". `--raw` IS our tool-local flag (scoped to diff)
// and must be declared explicitly so it's captured in opts rather than being
// treated as a passthrough (it has to stay before any positional to work that
// way; if the user puts it after a remote, commander puts it into gitArgs and
// we prepend it back below).

mirror
  .command('diff [remote] [git-args...]')
  .description('Source-vs-HEAD diff during a pause (scoped to review bucket)')
  .option('--raw', 'Bypass review-bucket pathspec; raw git diff HEAD <source>')
  .passThroughOptions()
  .action(
    asAction((remote: string | undefined, gitArgs: string[], opts: { raw?: boolean }) => {
      const extra = opts.raw ? ['--raw', ...gitArgs] : gitArgs;
      return mirrorDiff(remote, extra);
    }),
  );

mirror
  .command('source [remote] [git-args...]')
  .description("'git show' the current pause's source commit")
  .passThroughOptions()
  .action(asAction((remote: string | undefined, gitArgs: string[]) => mirrorSource(remote, gitArgs)));

// --- Hook entry points (invoked by installed hooks) -------------------------

program
  .command('post-checkout <prev> <new> <flag>')
  .description('(hook) Auto-route + mirror state advance')
  .action(asAction((prev: string, n: string, f: string) => postCheckout([prev, n, f])));

program
  .command('pre-push <remote> <url>')
  .description('(hook) Refuse cross-history pushes (reads refs from stdin)')
  .action(asAction((remote: string, url: string) => prePush([remote, url])));

program
  .command('post-merge <squash>')
  .description('(hook) Mirror state advance after fast-forward merge')
  .action(asAction(() => postMerge()));

program
  .command('post-applypatch')
  .description('(hook) Mirror state advance during git am')
  .action(asAction(() => postApplypatch()));

// --- Dispatch ---------------------------------------------------------------

// Short-circuit the documented "informational" entry points (no args, `mirror`
// with no subcommand) to print help on stdout and exit 0. Commander's default
// for those cases is to print help on stderr with exit 1 (treated as a
// missing-subcommand error); this keeps the pre-commander behavior.
const argv = process.argv.slice(2);
if (argv.length === 0) {
  program.outputHelp();
  process.exit(0);
}
if (argv.length === 1 && argv[0] === 'mirror') {
  mirror.outputHelp();
  process.exit(0);
}

program.exitOverride();
program.parseAsync(process.argv).catch((e: CommanderError) => {
  // Commander already printed its own error/help message to stderr/stdout.
  // `commander.help*` / `commander.version` are user-requested informational
  // exits; map them to exit 0. Everything else propagates the error code.
  if (e.code === 'commander.help' || e.code === 'commander.helpDisplayed' || e.code === 'commander.version') {
    process.exit(0);
  }
  process.exit(e.exitCode ?? 1);
});
