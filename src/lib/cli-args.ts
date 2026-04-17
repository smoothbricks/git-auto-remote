/**
 * Split a `mirror diff` / `mirror source` subcommand's trailing args into
 * `{ remote | undefined, extraArgs }`. Pulled into a separate module from
 * cli.ts so tests can import it without executing the CLI entry point.
 *
 * Rule: if the first arg exists and doesn't start with `-`, it's the remote
 * name; the rest is forwarded verbatim to `git diff` / `git show` (including
 * tool-local flags like `--raw` which `mirror diff` handles itself).
 * Otherwise the whole list is extraArgs.
 *
 * Regression context: v0.5.5 ran these subcommands through node's parseArgs
 * with strict:false, which ate unknown flags (`--stat`, `--raw`, etc.) by
 * placing them into `values` rather than leaving them in positionals. User
 * had to type `mirror diff -- --stat` (extra `--`) as a workaround. v0.5.6
 * bypasses parseArgs for these subcommands and uses this helper to split.
 */
export function splitPassthroughArgs(subArgs: readonly string[]): {
  remote: string | undefined;
  extraArgs: string[];
} {
  const first = subArgs[0];
  const hasRemote = first !== undefined && !first.startsWith('-');
  return {
    remote: hasRemote ? first : undefined,
    extraArgs: hasRemote ? subArgs.slice(1) : [...subArgs],
  };
}
