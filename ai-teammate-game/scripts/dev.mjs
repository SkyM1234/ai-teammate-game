import { mkdir, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from '../../pi-main/node_modules/esbuild/lib/main.js';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await build({ entryPoints: [fileURLToPath(new URL('../apps/web/src/main.ts', import.meta.url))], bundle: true, format: 'esm', target: 'es2022', outfile: fileURLToPath(new URL('../dist/main.js', import.meta.url)), logLevel: 'warning' });
await Promise.all(['index.html', 'styles.css'].map(name => copyFile(new URL(`../apps/web/${name}`, import.meta.url), new URL(`../dist/${name}`, import.meta.url))));
const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'apps/server/src/server.ts'], { cwd: root, stdio: 'inherit' });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => process.exit(code ?? 0));
