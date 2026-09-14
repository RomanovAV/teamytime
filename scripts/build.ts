import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist/web', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/client/main.tsx'], bundle: true, outfile: 'dist/web/app.js', format: 'esm', target: 'es2022', minify: true }),
  build({ entryPoints: ['src/server/main.ts'], bundle: true, outfile: 'dist/server.mjs', platform: 'node', format: 'esm', packages: 'external', target: 'node24' }),
  copyFile('src/client/index.html', 'dist/web/index.html'), copyFile('src/client/favicon.svg', 'dist/web/favicon.svg'),
]);
console.log('Сборка готова: dist/');
