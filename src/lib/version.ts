import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The installed version of this package, read from the adjacent package.json
 * at runtime. Used to pin hook-snippet `bunx` invocations so they always
 * resolve to the same release line (major.minor) the user invoked `setup`
 * from, rather than whatever `bunx` happens to have cached.
 */
const pkgJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
export const VERSION: string = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version;
