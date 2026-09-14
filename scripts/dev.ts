import { context } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { start } from '../src/server/main';

await mkdir('dist/web', { recursive: true });
await Promise.all(['index.html', 'favicon.svg'].map(file => copyFile(`src/client/${file}`, `dist/web/${file}`)));
const build = await context({ entryPoints: ['src/client/main.tsx'], bundle: true, outfile: 'dist/web/app.js', format: 'esm', target: 'es2022', sourcemap: true });
await build.rebuild(); await build.watch(); await start(path.resolve('dist/web'));
