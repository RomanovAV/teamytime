import { access, readFile, writeFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

async function optionalFile(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

export async function runNpm(root, args, { capture = false } = {}) {
  const candidates = [process.env.npm_execpath,
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  let cli;
  for (const candidate of candidates) {
    if (!candidate || !candidate.endsWith('npm-cli.js')) continue;
    try { await access(candidate); cli = candidate; break; } catch { /* Try the next installed npm. */ }
  }
  if (!cli && process.platform === 'win32') throw new Error('Не найден npm-cli.js. Запустите проект через npm start.');
  return new Promise((resolve, reject) => {
    const child = spawn(cli ? process.execPath : 'npm', cli ? [cli, ...args] : args,
      { cwd: root, shell: false, stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'] });
    let output = '';
    const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.stdout?.on('data', chunk => { output += chunk.toString(); if (output.length > 65536) child.kill('SIGTERM'); });
    child.once('error', () => { cleanup(); reject(new Error('Не удалось запустить npm. Проверьте установку Node.js и npm.')); });
    child.once('close', (code, signal) => {
      cleanup();
      if (code !== 0) reject(new Error(`npm ${args[0]} завершился с ${signal ? `сигналом ${signal}` : `кодом ${code}`}. Подготовка остановлена; подробности выше.`));
      else resolve(output.trim());
    });
  });
}

async function fingerprint(root) {
  const manifest = await readFile(path.join(root, 'package.json'), 'utf8');
  const lock = await readFile(path.join(root, 'package-lock.json'), 'utf8');
  const npmrc = await optionalFile(path.join(root, '.npmrc'));
  const hash = createHash('sha256').update(JSON.stringify([1, manifest, lock, npmrc, process.platform, process.arch, process.versions.modules])).digest('hex');
  return { hash, dependencies: JSON.parse(manifest).dependencies ?? {} };
}

async function dependenciesPresent(root, dependencies) {
  for (const [name, version] of Object.entries(dependencies)) {
    try {
      const directory = path.join(root, 'node_modules', name);
      const installed = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      // Project dependencies are pinned to exact versions.
      if (installed.version !== version) return false;
      await access(path.join(directory, installed.main ?? 'index.js'));
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  }
  return true;
}

export async function ensureDependencies(root, npm = runNpm) {
  const wanted = await fingerprint(root);
  const stamp = path.join(root, 'node_modules', '.teamytime-install.json');
  let installed;
  try { installed = JSON.parse(await optionalFile(stamp)); } catch { /* First install or incomplete marker. */ }
  if (installed?.hash === wanted.hash && await dependenciesPresent(root, wanted.dependencies)) return false;

  const registry = await npm(root, ['config', 'get', 'registry'], { capture: true });
  let url;
  try { url = new URL(registry); } catch { throw new Error('Не удалось определить настроенный npm-реестр. Проверьте npm config get registry.'); }
  if (!['https:', 'http:'].includes(url.protocol) || /(^|\.)npmjs\.(org|com)$/i.test(url.hostname)) {
    throw new Error('Для автоматической установки сначала настройте корпоративный npm-реестр внутри контура. Текущий реестр не подходит. Проверьте npm config get registry.');
  }
  console.log('Устанавливаем зависимости из настроенного npm-реестра…');
  // Invalidate before attempting installation, including a failed/interrupted ci.
  try { await unlink(stamp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await npm(root, ['ci', '--omit=dev', '--include=prod', '--include=optional', '--no-audit', '--no-fund']);
  if ((await fingerprint(root)).hash !== wanted.hash) throw new Error('Файлы зависимостей изменились во время установки. Повторите npm start.');
  if (!await dependenciesPresent(root, wanted.dependencies)) throw new Error('После npm ci отсутствуют необходимые зависимости. Проверьте вывод установки и настройки реестра.');
  await writeFile(stamp, JSON.stringify({ hash: wanted.hash }), { mode: 0o600 });
  return true;
}

export async function withPreparationLock(root, prepare) {
  const file = path.join(root, '.teamytime-prepare.lock');
  for (;;) {
    try { await writeFile(file, String(process.pid), { flag: 'wx', mode: 0o600 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await optionalFile(file));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Файл .teamytime-prepare.lock повреждён. Проверьте, что подготовка не запущена, прежде чем удалить его.');
      try { process.kill(pid, 0); }
      catch (probe) { if (probe.code === 'ESRCH') { try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } continue; } throw probe; }
      throw new Error('Подготовка Teamytime уже запущена. Дождитесь её завершения.');
    }
  }
  try { return await prepare(); }
  finally { if (await optionalFile(file) === String(process.pid)) await unlink(file); }
}
