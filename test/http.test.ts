import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { Store } from '../src/server/store';
import { Engine } from '../src/server/engine';
import { createApplication } from '../src/server/http';

test('HTTP validates origin and input, persists runs and replays SSE after reconnect', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'teamytime-http-'));
  const store = new Store(directory), engine = new Engine(store, { demo: async () => ({ reply: { message: 'Ответ', actions: [] } }), gigacode: async () => { throw new Error('unused'); } });
  const app = createApplication(store, engine, path.resolve('dist/web'));
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const post = (url: string, body: unknown, origin?: string) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  try {
    const boot = await (await fetch(base + '/api/bootstrap')).json();
    assert.equal((await post('/api/runs', {}, 'https://evil.example')).status, 403);
    assert.equal((await post('/api/runs', { prompt: 'x' })).status, 400);
    const created = await post('/api/runs', { prompt: 'Тест HTTP', mode: 'demo', teamId: 'default-team' }); assert.equal(created.status, 201);
    const run = await created.json();
    assert.equal((await (await fetch(base + '/api/runs/' + run.id)).json()).prompt, 'Тест HTTP');
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
