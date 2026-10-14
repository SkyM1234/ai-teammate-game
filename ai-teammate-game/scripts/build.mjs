import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from '../../pi-main/node_modules/esbuild/lib/main.js';

await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await build({ entryPoints: [fileURLToPath(new URL('../apps/web/src/main.ts', import.meta.url))], bundle: true, format: 'esm', target: 'es2022', minify: true, outfile: fileURLToPath(new URL('../dist/main.js', import.meta.url)), logLevel: 'warning' });
await Promise.all(['index.html', 'styles.css'].map(name => copyFile(new URL(`../apps/web/${name}`, import.meta.url), new URL(`../dist/${name}`, import.meta.url))));
