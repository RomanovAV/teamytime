import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { loadBuildTool } from './runtime.mjs';
import { pathToFileURL } from 'node:url';

export const serverOptions = {
  entryPoints: ['src/server/main.ts'], bundle: true, outfile: 'dist/server.mjs',
  platform: 'node', format: 'esm', target: 'node22.16', metafile: true,
};
export const webOptions = {
  entryPoints: ['src/client/main.tsx'], bundle: true, outfile: 'dist/web/app.js',
  format: 'esm', target: 'es2022', minify: true,
};
export async function copyAssets() {
  await mkdir('dist/web', { recursive: true });
  await Promise.all(['index.html', 'favicon.svg'].map(file => copyFile(`src/client/${file}`, `dist/web/${file}`)));
}
export async function buildApp() {
  const { build } = await loadBuildTool();
  await copyAssets();
  const [server] = await Promise.all([build(serverOptions), build(webOptions)]);
  // The portable distribution must resolve only built-in Node modules at runtime.
  for (const output of Object.values(server.metafile.outputs)) {
    if (output.imports.some(item => item.external && !item.path.startsWith('node:'))) {
      throw new Error('Серверная сборка содержит внешнюю npm-зависимость.');
    }
  }
  const licenses = await Promise.all(['react', 'react-dom', 'scheduler', 'zod'].map(async name => {
    const pkg = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
    return `${name} ${pkg.version}\n${await readFile(`node_modules/${name}/LICENSE`, 'utf8')}`;
  }));
  await writeFile('dist/THIRD_PARTY_LICENSES.txt', licenses.join('\n\n--------------------\n\n'));
  console.log('Локальная сборка готова: dist/. Запуск: npm start.');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  buildApp().catch(error => { console.error(error.message); process.exitCode = 1; });
}
