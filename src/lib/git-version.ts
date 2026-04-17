import { gitTry } from './git.js';

/**
 * `git am --empty=drop` requires git 2.34 (Nov 2021). Older git predates our
 * required flag and will misbehave silently (keep empty commits).
 */
const MIN_MAJOR = 2;
const MIN_MINOR = 34;

/** Returns an error message if the installed git is too old, null otherwise. */
export function checkGitVersion(): string | null {
  const out = gitTry('--version');
  if (!out) return `Cannot execute 'git'. Is it installed?`;
  const m = out.match(/git version (\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return `Cannot parse 'git --version' output: ${out}`;
  const major = Number.parseInt(m[1], 10);
  const minor = Number.parseInt(m[2], 10);
  if (major > MIN_MAJOR) return null;
  if (major === MIN_MAJOR && minor >= MIN_MINOR) return null;
  return `git ${major}.${minor} is too old; git-auto-remote requires >= ${MIN_MAJOR}.${MIN_MINOR} for 'git am --empty=drop'.`;
}
