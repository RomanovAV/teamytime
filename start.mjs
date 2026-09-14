import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertRuntime } from './scripts/runtime.mjs';

try {
  assertRuntime();
  const entry = new URL('./dist/server.mjs', import.meta.url);
  try { await access(entry); }
  catch { throw new Error('Готовая сборка не найдена. Распакуйте архив Teamytime или соберите исходники командой npm run build.'); }
  const { start } = await import(entry.href);
  await start(fileURLToPath(new URL('./dist/web', import.meta.url)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
