import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const child = spawn(process.execPath, ['apps/server/src/server.ts'], { cwd: root, stdio: 'inherit' });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => process.exit(code ?? 0));
