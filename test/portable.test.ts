import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, copyFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test('portable build runs without node_modules and restores a completed demo after restart', { timeout: 20000 }, async () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'pipe' });
  const directory = await mkdtemp(path.join(tmpdir(), 'teamytime-portable-'));
  let child: ChildProcess | undefined;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child?.kill('SIGKILL'), 2000);
    try { await closed; } finally { clearTimeout(timer); }
  }
  async function launch() {
    child = spawn(process.execPath, ['start.mjs'], { cwd: directory, env: { ...process.env, PORT: '0', TEAMYTIME_DATA_DIR: path.join(directory, 'data'), NODE_PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    return await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Portable launch timeout: ${output}`)), 5000);
      child!.once('error', error => { clearTimeout(timer); reject(error); });
      child!.once('exit', code => { clearTimeout(timer); reject(new Error(`Portable exit ${code}: ${output}`)); });
      child!.stderr!.on('data', bytes => { output += bytes.toString(); });
      child!.stdout!.on('data', bytes => {
        output += bytes.toString(); const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
  }
  try {
    await mkdir(path.join(directory, 'scripts'));
    await cp('dist', path.join(directory, 'dist'), { recursive: true });
    await copyFile('start.mjs', path.join(directory, 'start.mjs'));
    await copyFile('scripts/runtime.mjs', path.join(directory, 'scripts/runtime.mjs'));
    await assert.rejects(access(path.join(directory, 'node_modules')));
    let url = await launch();
    assert.equal((await fetch(url)).status, 200);
    const boot = await (await fetch(`${url}/api/bootstrap`)).json();
    const res = await fetch(`${url}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Проверка переносимой сборки', teamId: boot.config.teams[0].id, mode: 'demo' }) });
    assert.equal(res.status, 201); const created = await res.json();
    let completed = false;
    for (let i = 0; i < 100; i++) {
      const state = await (await fetch(`${url}/api/runs/${created.id}`)).json();
      if (state.status === 'completed') { completed = true; break; }
      if (['paused', 'interrupted'].includes(state.status)) throw new Error(state.note);
      await delay(50);
    }
    assert(completed); await stop(); url = await launch();
    const restored = await (await fetch(`${url}/api/runs/${created.id}`)).json();
    assert.equal(restored.status, 'completed'); assert.equal(restored.artifacts.length, 1);
  } finally { await stop(); await rm(directory, { recursive: true, force: true }); }
});
