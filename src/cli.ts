#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { detect } from './commands/detect.js';
import { postCheckout } from './commands/post-checkout.js';
import { prePush } from './commands/pre-push.js';
import { setup } from './commands/setup.js';
import { status } from './commands/status.js';
import { uninstall } from './commands/uninstall.js';

const USAGE = `Usage: git-auto-remote <command> [options]

Commands:
  setup [--quiet]       Install chainable git hooks (idempotent)
  status                Show remotes, detected roots, and current routing
  detect [ref]          Show ancestry analysis for a ref (default: HEAD)
  uninstall             Remove our blocks from the git hooks

Hook entry points (invoked by installed hooks; not meant for manual use):
  post-checkout <prev> <new> <flag>
  pre-push <remote> <url>       (reads refs from stdin)

Options:
  -h, --help            Show this help message
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: 'boolean', short: 'h' },
      quiet: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return 0;
  }

  const [command, ...rest] = positionals;
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
