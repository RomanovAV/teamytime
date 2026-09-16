import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { Store } from '../src/server/store';
import { Engine } from '../src/server/engine';
import { createApplication } from '../src/server/http';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

test('HTTP validates origin and input, persists runs and replays SSE after reconnect', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'teamytime-http-'));
  const store = new Store(directory), engine = new Engine(store, { demo: async () => ({ reply: { message: 'Ответ', actions: [] } }), gigacode: async () => { throw new Error('unused'); } });
  let pickerCalls = 0, selectFolder: ((value: string | null) => void) | undefined;
  const app = createApplication(store, engine, path.resolve('dist/web'), async () => {
    pickerCalls++;
    if (pickerCalls === 1) return new Promise<string | null>(resolve => { selectFolder = resolve; });
    if (pickerCalls === 3) throw new Error('Picker failed');
    return null;
  });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const post = (url: string, body: unknown, origin?: string) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  try {
    const boot = await (await fetch(base + '/api/bootstrap')).json();
    assert.equal((await post('/api/workspace/choose', {}, 'https://evil.example')).status, 403);
    assert.equal(pickerCalls, 0);
    const picking = post('/api/workspace/choose', {});
    for (let i = 0; !selectFolder && i < 200; i++) await delay(5);
    assert(selectFolder);
    assert.equal((await post('/api/workspace/choose', {})).status, 409);
    selectFolder(directory);
    assert.deepEqual(await (await picking).json(), { path: directory });
    assert.deepEqual(await (await post('/api/workspace/choose', {})).json(), { path: null });
    assert.equal((await post('/api/workspace/choose', {})).status, 500);
    assert.deepEqual(await (await post('/api/workspace/choose', {})).json(), { path: null });
    assert.equal((await post('/api/runs', {}, 'https://evil.example')).status, 403);
    assert.equal((await post('/api/runs', { prompt: 'x' })).status, 400);
    const created = await post('/api/runs', { prompt: 'Тест HTTP', mode: 'demo', teamId: 'default-team' }); assert.equal(created.status, 201);
    const run = await created.json();
    assert.equal((await (await fetch(base + '/api/runs/' + run.id)).json()).prompt, 'Тест HTTP');
    const reportResponse = await fetch(`${base}/api/runs/${run.id}/report`);
    assert.equal(reportResponse.status, 200);
    assert.equal(reportResponse.headers.get('content-type'), 'application/gzip');
    assert.match(reportResponse.headers.get('content-disposition')!, /attachment; filename="teamytime-run-.*\.json\.gz"/);
    const report = JSON.parse(gunzipSync(Buffer.from(await reportResponse.arrayBuffer())).toString());
    assert.equal(report.format, 'teamytime-run-report'); assert.equal(report.formatVersion, 1);
    assert.equal(report.run.prompt, 'Тест HTTP'); assert.equal(report.run.id, run.id);
    assert(report.events.items.some((e: any) => e.reason === 'created'));
    assert.equal(report.diagnostics.turns[0].context.mode, 'demo');
    assert.equal(report.diagnostics.turns[0].outcome.status, 'succeeded');
    assert.equal((await fetch(`${base}/api/runs/missing/report`)).status, 404);
    assert.equal((await fetch(`${base}/api/runs/${run.id}/report`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const abort = new AbortController();
    const stream = await fetch(base + '/api/events?after=' + boot.cursor, { signal: abort.signal });
    assert.match(stream.headers.get('content-type')!, /text\/event-stream/);
    const chunk = await stream.body!.getReader().read(); abort.abort();
    assert.match(new TextDecoder().decode(chunk.value), /event: change/);
    assert.match(new TextDecoder().decode(chunk.value), /created/);
    assert.equal((await post(`/api/runs/${run.id}/control`, { action: 'unknown' })).status, 400);
    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(base + '/api/bootstrap', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end();
    });
    assert.equal(badHostStatus, 403);
  } finally {
    app.closeStreams(); await engine.close(); await new Promise<void>(resolve => app.server.close(() => resolve())); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
