import { isAncestorOf } from '../lib/git.js';
import { collectRemotes } from '../lib/remotes.js';
import { validatePush } from '../lib/routing.js';

/**
 * pre-push hook entry point.
 * Args: <remote-name> <remote-url>
 * Stdin: lines of "<local-ref> <local-sha> <remote-ref> <remote-sha>"
 *
 * Aborts the push (exit 1) if any ref being pushed doesn't descend from the target remote's history.
 */
export async function prePush(args: readonly string[]): Promise<number> {
  const [remoteName] = args;
  if (!remoteName) return 0;

  const refs = await readPushRefsFromStdin();
  if (refs.length === 0) return 0;

  const remotes = collectRemotes();
  const error = validatePush(remoteName, remotes, refs, isAncestorOf);

  if (error) {
    console.error(`[git-auto-remote] ${error}`);
    console.error('[git-auto-remote] If this is intentional (e.g. you really mean to cross histories),');
    console.error('[git-auto-remote] bypass with: git push --no-verify');
    return 1;
  }

  return 0;
}

async function readPushRefsFromStdin(): Promise<{ localRef: string; localSha: string }[]> {
  const parts: string[] = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    parts.push(chunk as string);
  }
  return parts
    .join('')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [localRef, localSha] = line.split(' ');
      return { localRef, localSha };
    });
}
