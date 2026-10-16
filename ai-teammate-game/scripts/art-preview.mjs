import { createServer } from 'node:http';
import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from '../../pi-main/node_modules/esbuild/lib/main.js';

const output = new URL('../output/art-preview/', import.meta.url);
await mkdir(output, { recursive: true });
await build({ entryPoints: [fileURLToPath(new URL('../apps/art-gallery/src/main.ts', import.meta.url))], bundle: true, format: 'esm', target: 'es2022', outfile: fileURLToPath(new URL('main.js', output)) });
await Promise.all(['index.html', 'styles.css'].map(name => copyFile(new URL(`../apps/art-gallery/${name}`, import.meta.url), new URL(name, output))));
const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/main.js': ['main.js', 'text/javascript; charset=utf-8'] };
const server = createServer(async (req, res) => {
  const file = files[new URL(req.url, 'http://localhost').pathname];
  if (!file) { res.writeHead(req.url === '/favicon.ico' ? 204 : 404); res.end(); return; }
  try { const body = await readFile(new URL(file[0], output)); res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' }); res.end(body); }
  catch { res.writeHead(500); res.end('Preview unavailable'); }
});
const port = Number(process.env.ART_PREVIEW_PORT ?? 4322);
server.listen(port, '127.0.0.1', () => console.log(`ART PREVIEW → http://127.0.0.1:${port}`));
