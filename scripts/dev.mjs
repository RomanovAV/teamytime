import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { loadBuildTool } from './runtime.mjs';
import { copyAssets, serverOptions, webOptions } from './build.mjs';

const { context } = await loadBuildTool();
await copyAssets();
let server;
let stopping = false;
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const closed = once(server, 'exit');
  server.kill('SIGTERM');
  const timeout = setTimeout(() => server?.kill('SIGKILL'), 5000);
  try { await closed; } finally { clearTimeout(timeout); }
}
const web = await context({ ...webOptions, minify: false, sourcemap: true });
const backend = await context({ ...serverOptions, plugins: [{ name: 'restart-server', setup(build) {
  build.onStart(stopServer);
  build.onEnd(result => {
    if (result.errors.length || stopping) return;
    // The watcher has already built this entry; avoid a second production build.
    server = spawn(process.execPath, ['dist/server.mjs'], { stdio: 'inherit' });
    server.on('error', error => console.error(error.message));
  });
} }] });
const assets = ['index.html', 'favicon.svg'].map(file => watch(`src/client/${file}`, () => { copyAssets().catch(console.error); }));
await web.rebuild(); await web.watch(); await backend.watch();
async function stop() {
  if (stopping) return; stopping = true;
  assets.forEach(watcher => watcher.close());
  await Promise.all([backend.dispose(), web.dispose()]); await stopServer();
}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
