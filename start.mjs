import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertRuntime } from './scripts/runtime.mjs';

try {
  assertRuntime();
  const buildScript = new URL('./scripts/build.mjs', import.meta.url);
  let hasBuildScript = true;
  try { await access(buildScript); }
  catch (error) { if (error.code !== 'ENOENT') throw error; hasBuildScript = false; }
  if (hasBuildScript) {
    const root = fileURLToPath(new URL('.', import.meta.url));
    const { ensureDependencies, withPreparationLock } = await import('./scripts/prepare.mjs');
    await withPreparationLock(root, async () => {
      await ensureDependencies(root);
      console.log('Собираем Teamytime из исходников на этом компьютере…');
      const { buildApp } = await import(buildScript.href);
      const launchDirectory = process.cwd();
      process.chdir(root);
      try { await buildApp(); }
      finally { process.chdir(launchDirectory); }
    });
  }
  const entry = new URL('./dist/server.mjs', import.meta.url);
  try { await access(entry); }
  catch { throw new Error('Локальная сборка не найдена. Запустите npm start из полного каталога проекта с исходниками и установленными зависимостями.'); }
  const { start } = await import(entry.href);
  await start(fileURLToPath(new URL('./dist/web', import.meta.url)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
