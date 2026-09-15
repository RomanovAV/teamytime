import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertRuntime } from './scripts/runtime.mjs';

try {
  assertRuntime();
  const entry = new URL('./dist/server.mjs', import.meta.url);
  try { await access(entry); }
  catch { throw new Error('Локальная сборка не найдена. Установите зависимости из настроенного реестра: npm ci --include=dev. Затем выполните npm run build.'); }
  const { start } = await import(entry.href);
  await start(fileURLToPath(new URL('./dist/web', import.meta.url)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
