/**
 * Pure routing decision logic.
 *
 * Given a set of remotes with their root commits and a way to check ancestry,
 * decide which remote a branch should push/pull to.
 *
 * Decision rules:
 * - No remotes configured → no-op
 * - All remotes share the exact same root set → single history (mirrors or traditional setup);
 *   inherit the routing of the branch HEAD was on before checkout
 * - Remotes have disjoint roots (fork scenario):
 *   - 0 remotes match HEAD's ancestry → silent no-op
 *   - 1 remote matches → route to that remote
 *   - 2+ remotes match → refuse, histories have been merged (likely a mistake)
 */

export type Remote = {
  name: string;
  /** Root commit SHAs of this remote (typically one, but can be many if remote has disjoint histories). */
  roots: readonly string[];
};

export type RoutingDecision =
  | { kind: 'no-remotes' }
  | { kind: 'no-match' }
  | { kind: 'single-match'; remote: string }
  | { kind: 'multi-match'; remotes: readonly string[] }
  | { kind: 'shared-history'; inheritedRemote: string | null };

/**
 * @param remotes     All remotes configured in the repo, each with their detected root commits.
 * @param isAncestor  Predicate: given a commit SHA, is it an ancestor of HEAD? (synchronous, mockable)
 * @param inheritedRemote  The pushRemote of the branch HEAD was on before checkout (for shared-history case).
 */
export function decideRouting(
  remotes: readonly Remote[],
  isAncestor: (sha: string) => boolean,
  inheritedRemote: string | null,
): RoutingDecision {
  if (remotes.length === 0) return { kind: 'no-remotes' };

  if (remotesShareRoots(remotes)) {
    return { kind: 'shared-history', inheritedRemote };
  }

  const matching = remotes.filter((r) => r.roots.some(isAncestor));

  if (matching.length === 0) return { kind: 'no-match' };
  if (matching.length === 1) return { kind: 'single-match', remote: matching[0].name };
  return { kind: 'multi-match', remotes: matching.map((r) => r.name) };
}

/**
 * True iff every remote has the exact same set of root commits.
 * When true, the remotes are mirrors (or a single-upstream setup) and ancestry routing doesn't apply.
 */
function remotesShareRoots(remotes: readonly Remote[]): boolean {
  if (remotes.length < 2) return true;
  const reference = new Set(remotes[0].roots);
  return remotes.every((r) => r.roots.length === reference.size && r.roots.every((root) => reference.has(root)));
}

/**
 * Verifies a ref being pushed to `remoteName` is actually descended from that remote's history.
 * Returns null if valid, or an error message if the push should be rejected.
 */
export function validatePush(
  remoteName: string,
  remotes: readonly Remote[],
  refsBeingPushed: readonly { localRef: string; localSha: string }[],
  isAncestor: (ancestorSha: string, descendantSha: string) => boolean,
): string | null {
  const target = remotes.find((r) => r.name === remoteName);
  if (!target) return null; // Unknown remote - not our concern
  if (target.roots.length === 0) return null; // No roots detected - can't validate

  // If all remotes share roots, there's no cross-contamination to worry about.
  if (remotesShareRoots(remotes)) return null;

  for (const { localRef, localSha } of refsBeingPushed) {
    // Skip deletions (localSha is 40 zeros)
    if (/^0+$/.test(localSha)) continue;

    const descendsFromTarget = target.roots.some((root) => isAncestor(root, localSha));
    if (!descendsFromTarget) {
      const foreignRemotes = remotes
        .filter((r) => r.name !== remoteName && r.roots.some((root) => isAncestor(root, localSha)))
        .map((r) => r.name);

      return (
        `Refusing to push ${localRef} to remote '${remoteName}': ` +
        `the commit ${localSha.slice(0, 8)} does not descend from '${remoteName}' history.` +
        (foreignRemotes.length > 0 ? ` It appears to come from: ${foreignRemotes.join(', ')}.` : '')
      );
    }
  }

  return null;
}
