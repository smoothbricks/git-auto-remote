import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The code under test commits (`git am`, `git commit`) in the test process's environment. A machine with no global
 * git identity, such as a CI runner, refuses those commits, so every test run gets a global git config of its own that
 * only names one. It is the lowest-priority identity: a test's repository config or explicit GIT_* variables still win.
 */
const config = join(mkdtempSync(join(tmpdir(), 'gar-test-config-')), 'gitconfig');
writeFileSync(config, '[user]\n\tname = Test\n\temail = test@example.com\n');
process.env.GIT_CONFIG_GLOBAL = config;
