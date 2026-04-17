import { findRemoteRoots, listRemotes } from './git.js';
import type { Remote } from './routing.js';

/**
 * Collect all remotes and their root commits.
 * Remotes with zero roots (not fetched yet, or empty) are included with an empty list
 * so they still show up in `status` output.
 */
export function collectRemotes(): Remote[] {
  return listRemotes().map((name) => ({ name, roots: findRemoteRoots(name) }));
}
