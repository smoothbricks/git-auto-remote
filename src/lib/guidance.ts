/**
 * Self-guiding CLI output (C1-h). Every command, on every terminal path, ends
 * with a single machine-greppable next-step line:
 *
 *   Next: <command>  # <why>
 *
 * Agents (and humans) can parse the `Next:` prefix to discover the exact command
 * to run next without reading prose. Guidance always goes to stderr so stdout
 * stays clean for any data a command pipes (e.g. `mirror list`).
 */

/** Format a next-step line. Locked format - agents grep the `Next:` prefix. */
export function formatNext(command: string, why: string): string {
  return `Next: ${command}  # ${why}`;
}

/** Print a trailing next-step line to stderr (preceded by a blank line). */
export function printNext(command: string, why: string): void {
  console.error(`\n${formatNext(command, why)}`);
}
