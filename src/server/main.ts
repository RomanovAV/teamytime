import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store';
import { Engine } from './engine';
import { createApplication } from './http';

export async function start(webDirectory: string) {
  const directory = path.resolve(process.env.TEAMYTIME_DATA_DIR ?? '.teamytime');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, 'server.lock');
  try { writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch {
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Некорректный файл блокировки: ${lock}`);
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
    if (alive) throw new Error('Teamytime уже работает с этим каталогом данных.');
    unlinkSync(lock); writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  const unlock = () => { try { if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock); } catch { /* Already removed. */ } };
  process.once('exit', unlock);
  const store = new Store(directory); store.recover();
  const engine = new Engine(store), app = createApplication(store, engine, webDirectory);
  const port = Number(process.env.PORT ?? 4318);
  await new Promise<void>((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, '127.0.0.1', resolve); });
  console.log(`Teamytime → http://127.0.0.1:${(app.server.address() as { port: number }).port}\nДанные: ${directory}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    app.closeStreams(); const closed = new Promise<void>(resolve => app.server.close(() => resolve()));
    await engine.close(); await closed; store.close(); unlock(); process.exit(0);
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return { store, engine, app };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start(path.join(path.dirname(fileURLToPath(import.meta.url)), 'web')).catch(error => { console.error(error.message); process.exit(1); });
}
