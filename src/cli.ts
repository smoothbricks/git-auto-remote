#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { detect } from './commands/detect.js';
import { mirrorBootstrap } from './commands/mirror-bootstrap.js';
import { mirrorContinue } from './commands/mirror-continue.js';
import { mirrorDiff } from './commands/mirror-diff.js';
import { mirrorList } from './commands/mirror-list.js';
import { mirrorPull } from './commands/mirror-pull.js';
import { mirrorSkip } from './commands/mirror-skip.js';
import { mirrorSource } from './commands/mirror-source.js';
import { mirrorStatus } from './commands/mirror-status.js';
import { splitPassthroughArgs } from './lib/cli-args.js';
import { postApplypatch } from './commands/post-applypatch.js';
import { postCheckout } from './commands/post-checkout.js';
import { postMerge } from './commands/post-merge.js';
import { prePush } from './commands/pre-push.js';
import { setup } from './commands/setup.js';
import { status } from './commands/status.js';
import { uninstall } from './commands/uninstall.js';

const USAGE = `Usage: git-auto-remote <command> [options]

Core commands:
  setup [--quiet]               Install chainable git hooks (idempotent)
  status                        Show remotes, detected roots, and current routing
  detect [ref]                  Show ancestry analysis for a ref (default: HEAD)
  uninstall                     Remove our blocks from the git hooks

Mirror commands (cherry-pick from a remote with disjoint history):
  mirror list                                   List configured mirrors
  mirror status [<remote>]                      Show sync state for mirror(s)
  mirror bootstrap <remote> <sha> [--force]     Initialize tracking ref (optional)
  mirror pull [<remote>] [--non-interactive]    Sync new mirror commits
                           [--on-partial <cmd>] Handler for partial commits
  mirror continue [<remote>]                    Resume from any sync pause
  mirror skip [<remote>]                        Skip the paused commit, resume
  mirror diff [<remote>] [--raw] [git-diff-args]  Source-vs-HEAD diff during a pause,
                                                  scoped to paths THIS commit touched
                                                  in review/regenerate/outside buckets
  mirror source [<remote>] [git-show-args]        'git show' the current pause's source

Hook entry points (invoked by installed hooks; not meant for manual use):
  post-checkout <prev> <new> <flag>
  pre-push <remote> <url>                       (reads refs from stdin)
  post-merge <squash-flag>
  post-applypatch

Options:
  -h, --help                    Show this help message
`;

async function main(): Promise<number> {
  // Special-case `mirror diff` and `mirror source` subcommands BEFORE parseArgs
  // strips any unrecognized flags (node's parseArgs moves `--stat`, `--raw`,
  // etc. into `values` as booleans rather than leaving them in positionals
  // even with strict:false). For these subcommands we want to forward all
  // trailing args verbatim to git-diff / git-show respectively, so we split
  // them off here and dispatch directly.
  const raw = process.argv.slice(2);
  if (raw[0] === 'mirror' && (raw[1] === 'diff' || raw[1] === 'source')) {
    const sub = raw[1];
    const { remote, extraArgs } = splitPassthroughArgs(raw.slice(2));
    return sub === 'diff' ? mirrorDiff(remote, extraArgs) : mirrorSource(remote, extraArgs);
  }

  const { values, positionals } = parseArgs({
    args: raw,
    options: {
      help: { type: 'boolean', short: 'h' },
      quiet: { type: 'boolean' },
      'non-interactive': { type: 'boolean' },
      'on-partial': { type: 'string' },
      force: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return 0;
  }

  const [command, ...rest] = positionals;

  // Mirror subcommands: `mirror <sub> [...]`
  if (command === 'mirror') {
    const [sub, ...subArgs] = rest;
    switch (sub) {
      case 'list':
        return mirrorList();
      case 'status':
        return mirrorStatus(subArgs[0]);
      case 'bootstrap':
        if (subArgs.length < 2) {
          console.error('Usage: git-auto-remote mirror bootstrap <remote> <sha> [--force]');
          return 1;
        }
        return mirrorBootstrap(subArgs[0], subArgs[1], Boolean(values.force));
      case 'pull':
        return mirrorPull({
          remote: subArgs[0],
          nonInteractive: Boolean(values['non-interactive']),
          onPartial: typeof values['on-partial'] === 'string' ? values['on-partial'] : null,
        });
      case 'continue':
        return await mirrorContinue(subArgs[0]);
      case 'skip':
        return await mirrorSkip(subArgs[0]);
      case 'diff':
      case 'source':
        // Unreachable: these are special-cased at the top of main() to
        // bypass parseArgs and preserve their passthrough args. Fall
        // through defensively if something routes here.
        console.error(`[git-auto-remote] internal: 'mirror ${sub}' routed through parseArgs path`);
        return 1;
      case 'am-continue':
      case 'am-skip':
        console.error(
          `'mirror ${sub}' was removed in v0.4.0. Use 'mirror continue' / 'mirror skip' instead - they now handle am-conflict, review-pause, and pure-review-pause uniformly.`,
        );
        return 1;
      default:
        console.error(`Unknown mirror subcommand: ${sub ?? '(none)'}`);
        console.error(USAGE);
        return 1;
    }
  }

  switch (command) {
    case 'setup':
      return setup({ quiet: Boolean(values.quiet) });
    case 'status':
      return status();
    case 'detect':
      return detect(rest[0]);
    case 'uninstall':
      return uninstall();
    case 'post-checkout':
      return postCheckout(rest);
    case 'pre-push':
      return await prePush(rest);
    case 'post-merge':
      return await postMerge();
    case 'post-applypatch':
      return postApplypatch();
    default:
      console.error(`Unknown command: ${command}`);
      console.error(USAGE);
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[git-auto-remote] fatal:', err?.message ?? err);
    process.exit(1);
  });
