import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitDir } from './git.js';
import { VERSION } from './version.js';

export type HookName = 'post-checkout' | 'pre-push' | 'post-merge' | 'post-applypatch';

export const ALL_HOOKS: readonly HookName[] = [
  'post-checkout',
  'pre-push',
  'post-merge',
  'post-applypatch',
];

/**
 * Exit-code behavior per hook:
 *   post-checkout   - never fail a checkout (auto-routing is best-effort)
 *   post-merge      - never fail a pull (mirror sync is best-effort)
 *   post-applypatch - never fail `git am` (ref-advancement is best-effort)
 *   pre-push        - propagate exit code (it's a safety gate)
 */
function exitBehavior(name: HookName): string {
  return name === 'pre-push' ? '|| exit $?' : '|| true';
}

/**
 * Shell snippet injected into hook files. The string `git-auto-remote <hook>` is the
 * marker used to detect our presence in existing hooks (for chainability and idempotence).
 *
 * The `@<major>.<minor>.x` pin on the bunx call ensures the hook invokes the same
 * release line the installer was run from, rather than whatever bunx has cached.
 * Upgrading across a minor bump is done by re-running `git-auto-remote setup` with
 * the new version - the installer detects and replaces an outdated block in place.
 */
function hookSnippet(name: HookName): string {
  return [
    `# >>> git-auto-remote ${name} ${VERSION} >>>`,
    `# Managed by git-auto-remote. Safe to chain with other hooks above/below these markers.`,
    `bunx --bun git-auto-remote@${pinForVersion(VERSION)} ${name} "$@" ${exitBehavior(name)}`,
    `# <<< git-auto-remote ${name} <<<`,
  ].join('\n');
}

/** Convert "0.3.1" -> "0.3.x" so patch-level bugfixes roll out without re-running setup. */
function pinForVersion(v: string): string {
  const [major, minor] = v.split('.');
  return `${major}.${minor}.x`;
}

const SHEBANG = '#!/usr/bin/env bash';
// Start marker tolerates any trailing version suffix so older-generation blocks
// (without a version) are still detected and replaced in place.
const START_MARKER_RE = (name: HookName) =>
  new RegExp(`^# >>> git-auto-remote ${name}(?:\\s+\\S+)? >>>$`, 'm');
const FULL_BLOCK_RE = (name: HookName) =>
  new RegExp(
    `\\n?# >>> git-auto-remote ${name}(?:\\s+\\S+)? >>>[\\s\\S]*?# <<< git-auto-remote ${name} <<<\\n?`,
    'm',
  );

export type InstallResult =
  | { kind: 'installed'; path: string }
  | { kind: 'already-present'; path: string }
  | { kind: 'updated'; path: string }
  | { kind: 'appended'; path: string };

/**
 * Install our hook snippet into .git/hooks/<name>, preserving any existing content.
 * - If the hook file doesn't exist: create it with a shebang and our snippet.
 * - If it exists and already contains our marker: do nothing.
 * - If it exists without our marker: append our snippet to the end.
 */
export function installHook(name: HookName): InstallResult {
  const hooksDir = join(gitDir(), 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const path = join(hooksDir, name);

  if (!existsSync(path)) {
    const content = `${SHEBANG}\n\n${hookSnippet(name)}\n`;
    writeFileSync(path, content);
    chmodSync(path, 0o755);
    return { kind: 'installed', path };
  }

  const existing = readFileSync(path, 'utf8');
  if (START_MARKER_RE(name).test(existing)) {
    // Our block is present. If its content matches what we'd write now, no-op;
    // otherwise replace in place (happens after a version bump, or when the
    // snippet format itself changes across releases).
    const desired = hookSnippet(name);
    const match = existing.match(FULL_BLOCK_RE(name));
    if (match && match[0].trim() === desired.trim()) {
      return { kind: 'already-present', path };
    }
    const updated = existing.replace(FULL_BLOCK_RE(name), '\n' + desired + '\n');
    writeFileSync(path, updated);
    chmodSync(path, 0o755);
    return { kind: 'updated', path };
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(path, existing + separator + hookSnippet(name) + '\n');
  chmodSync(path, 0o755);
  return { kind: 'appended', path };
}

export type UninstallResult =
  | { kind: 'removed'; path: string }
  | { kind: 'not-present'; path: string }
  | { kind: 'file-missing'; path: string };

/**
 * Remove our hook block from .git/hooks/<name>.
 * If the file becomes empty (only a shebang left), remove it entirely.
 */
export function uninstallHook(name: HookName): UninstallResult {
  const path = join(gitDir(), 'hooks', name);
  if (!existsSync(path)) return { kind: 'file-missing', path };

  const existing = readFileSync(path, 'utf8');
  if (!START_MARKER_RE(name).test(existing)) return { kind: 'not-present', path };

  const cleaned = existing.replace(FULL_BLOCK_RE(name), '\n').trimEnd() + '\n';
  // If only the shebang (or nothing useful) remains, remove the file.
  const stripped = cleaned.replace(/^#!.*$/m, '').trim();
  if (stripped.length === 0) {
    // Intentionally leave the file in place but truncated to shebang - removing could disrupt
    // other tools that check for its existence. Just keep it empty of logic.
    writeFileSync(path, `${SHEBANG}\n`);
  } else {
    writeFileSync(path, cleaned);
  }
  return { kind: 'removed', path };
}

/** Compute what installHook would return without writing anything. For dry-run/testing. */
export function hookStatus(name: HookName): 'absent' | 'present-ours' | 'present-foreign' {
  const path = join(gitDir(), 'hooks', name);
  if (!existsSync(path)) return 'absent';
  const existing = readFileSync(path, 'utf8');
  return START_MARKER_RE(name).test(existing) ? 'present-ours' : 'present-foreign';
}
