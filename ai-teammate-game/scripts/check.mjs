import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const compiler = fileURLToPath(new URL('../../pi-main/node_modules/typescript/bin/tsc', import.meta.url));
const result = spawnSync(process.execPath, [compiler, '--project', 'tsconfig.json'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
