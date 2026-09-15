import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/server/store';
import { Engine } from '../src/server/engine';
import type { Adapter, AgentContext, AgentResult } from '../src/server/agents/adapter';

export async function until(fn: () => boolean, timeout = 7000) { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('Timed out'); await delay(10); } }
function fixture(adapter?: Adapter) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'teamytime-test-'));
  const store = new Store(directory), engine = new Engine(store, adapter ? { demo: adapter, gigacode: adapter } : undefined);
  const create = () => engine.create({ prompt: 'Проверить совместную работу команды', teamId: 'default-team', mode: 'demo' });
  return { directory, store, engine, create, async close() { await engine.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('retry can resume immediately or remain paused by user choice', async () => {
  for (const resume of [false, true]) {
    let calls = 0;
    const f = fixture(async () => { if (++calls === 1) throw new Error('failure'); return { reply: { message: 'Recovered', actions: [] } }; });
    try {
      const r = f.create(); await until(() => f.store.get(r.id).status === 'paused');
      f.engine.resolveTurn(r.id, r.turns[0].id, 'retry', resume);
      if (!resume) { await delay(20); assert.equal(calls, 1); assert.equal(f.store.get(r.id).status, 'paused'); f.engine.control(r.id, 'resume'); }
      await until(() => f.store.get(r.id).status === 'waiting'); assert.equal(calls, 2);
    } finally { await f.close(); }
  }
});

test('automatic recovery waits for other failures and respects turn budget', async () => {
  const f = fixture(async () => ({ reply: { message: 'done', actions: [] } }));
  try {
    const r = f.create(); f.engine.control(r.id, 'pause');
    f.store.update(r.id, 'fixture', r => {
      r.turns[0].status = 'failed'; r.turns[0].startedAt = new Date().toISOString();
      r.turns.push({ ...r.turns[0], id: 'second', agentId: 'alex', status: 'interrupted' });
    });
    f.engine.resolveTurn(r.id, r.turns[0].id, 'retry', true);
    assert.equal(f.store.get(r.id).status, 'paused'); assert.equal(f.store.get(r.id).resumeAfterRecovery, true);
    f.engine.resolveTurn(r.id, 'second', 'skip');
    await until(() => f.store.get(r.id).status === 'waiting');
    f.store.update(r.id, 'fixture', r => { r.status = 'paused'; r.team.maxTurns = 1; r.turns[0].status = 'failed'; });
    f.engine.resolveTurn(r.id, r.turns[0].id, 'retry', true);
    assert.equal(f.store.get(r.id).status, 'paused'); assert.match(f.store.get(r.id).note, /лимит/);
  } finally { await f.close(); }
});

test('explicit continuation runs serially, persists warnings and stops at budget', async () => {
  let active = 0, maxActive = 0;
  const f = fixture(async () => {
    maxActive = Math.max(maxActive, ++active); await delay(5); active--;
    return { reply: { message: 'Нужен следующий шаг', actions: [{ type: 'continue', reason: 'Завершить проверку' }] }, warnings: ['Проверка Git отклонена'] };
  });
  try {
    const r = f.create(); f.store.update(r.id, 'fixture', r => { r.team.maxTurns = 4; });
    await until(() => f.store.get(r.id).status === 'paused');
    const state = f.store.get(r.id);
    assert.equal(state.turns.filter(t => t.status === 'succeeded').length, 4);
    assert.equal(maxActive, 1); assert.equal(state.turns[0].warnings?.[0], 'Проверка Git отклонена');
    assert.equal(state.turns.filter(t => t.status === 'queued').length, 1);
    assert(state.messages.some(m => m.kind === 'system' && m.text.includes('Завершить проверку')));
  } finally { await f.close(); }
});
test('demo completes through addressed messages, persists results and native identities', async () => {
  const f = fixture();
  try {
    const r = f.create(); await until(() => f.store.get(r.id).status === 'completed');
    const done = f.store.get(r.id);
    assert(done.artifacts.length > 0); assert(done.decisions.every(d => d.status === 'accepted'));
    assert(done.messages.some(m => m.recipientIds.includes('oleg') && m.appliedBy.includes('oleg')));
    assert.equal(new Set(done.participants.map(p => p.sessionId)).size, 4);
    assert(done.participants.every(p => p.sessionStarted));
    const config = f.store.config(); config.teams[0].members[0].name = 'Другой'; f.store.saveConfig(config);
    assert.equal(f.store.get(r.id).participants[0].name, 'Марина');
    const eventIds = f.store.eventsAfter(0).map(e => e.id); assert.equal(new Set(eventIds).size, eventIds.length);
  } finally { await f.close(); }
});
test('requirement change marks an in-flight reply stale and discards its actions', async () => {
  let pending!: (r: AgentResult) => void; const calls: AgentContext[] = [];
  const adapter: Adapter = c => { calls.push(c); return new Promise(resolve => { pending = resolve; }); };
  const f = fixture(adapter);
  try {
    const r = f.create(); await until(() => calls.length === 1);
    f.engine.send(r.id, { kind: 'update', text: 'Использовать только новую схему.' });
    f.engine.control(r.id, 'pause');
    pending({ reply: { message: 'Старое решение', actions: [{ type: 'artifact', title: 'Устаревший', content: 'НЕ ПРИМЕНЯТЬ' }] } });
    await until(() => f.store.get(r.id).status === 'paused');
    const state = f.store.get(r.id);
    assert.equal(state.revision, 2); assert.equal(state.artifacts.length, 0);
    assert(state.messages.some(m => m.text === 'Старое решение' && m.stale));
    assert.equal(state.messages[0].appliedBy.length, 0);
    assert.equal(state.turns.filter(t => t.status === 'queued').length, 4);
  } finally { await f.close(); }
});
test('same participant is serialized; queued causes coalesce; pause drains active work', async () => {
  let finish!: (result: AgentResult) => void, calls = 0;
  const f = fixture(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  try {
    const r = f.create(); await until(() => calls === 1);
    f.engine.send(r.id, { kind: 'message', text: 'Первое сообщение' });
    f.engine.send(r.id, { kind: 'message', text: 'Второе сообщение' });
    await delay(25); assert.equal(calls, 1);
    assert.equal(f.store.get(r.id).turns.filter(t => t.status === 'queued').length, 1);
    assert.equal(f.store.get(r.id).turns.find(t => t.status === 'queued')?.causeIds.length, 2);
    f.engine.control(r.id, 'pause'); finish({ reply: { message: 'Готово', actions: [] } });
    await until(() => f.store.get(r.id).status === 'paused'); assert.equal(calls, 1);
  } finally { await f.close(); }
});
test('invalid action applies no partial artifacts and requires explicit recovery', async () => {
  const f = fixture(async c => { c.init('CodeChat'); return { reply: { message: 'Ошибка протокола', actions: [{ type: 'artifact', title: 'Не создавать', content: 'x' }, { type: 'send', to: 'nonexistent', text: 'x' }] } }; });
  try {
    const r = f.create(); await until(() => f.store.get(r.id).status === 'paused');
    let state = f.store.get(r.id); assert.equal(state.artifacts.length, 0); assert(state.participants[0].sessionStarted);
    assert.equal(state.turns[0].draft, 'Ошибка протокола');
    assert.throws(() => f.engine.control(r.id, 'resume'), /Сначала/);
    f.engine.resolveTurn(r.id, state.turns[0].id, 'skip'); f.engine.control(r.id, 'resume');
    await until(() => f.store.get(r.id).status === 'waiting');
  } finally { await f.close(); }
});
test('restart preserves state and never automatically replays an uncertain turn', async () => {
  const f = fixture(async () => ({ reply: { message: 'Сохранено', actions: [] } }));
  try {
    const r = f.create(); await until(() => f.store.get(r.id).status === 'waiting');
    f.store.update(r.id, 'simulate-crash', r => { r.status = 'running'; r.turns[0].status = 'running'; });
    const reopened = new Store(f.directory); reopened.recover();
    assert.equal(reopened.get(r.id).status, 'interrupted');
    assert.equal(reopened.get(r.id).turns[0].status, 'interrupted'); reopened.close();
  } finally { await f.close(); }
});
test('one writing participant per canonical workspace, across independent tasks', async () => {
  const pending: { c: AgentContext; resolve: (r: AgentResult) => void }[] = [];
  const f = fixture(c => new Promise(resolve => pending.push({ c, resolve })));
  try {
    const config = f.store.config(); config.teams[0].members = config.teams[0].members.slice(0, 2).map(m => ({ ...m, roleId: 'executor' })); f.store.saveConfig(config);
    const create = () => f.engine.create({ prompt: 'Проверить запись', teamId: 'default-team', mode: 'demo', workspace: f.directory });
    const a = create(), b = create(); await until(() => pending.length === 1);
    await delay(30); assert.equal(pending.length, 1);
    pending[0].resolve({ reply: { message: 'Запись завершена', actions: [] } });
    await until(() => pending.length === 2);
    pending[1].resolve({ reply: { message: 'Запись завершена', actions: [] } });
    await until(() => [a, b].every(r => f.store.get(r.id).status === 'waiting'));
  } finally { await f.close(); }
});

test('manual checkpoint retains queued work until the user continues', async () => {
  const f = fixture();
  try {
    const config = f.store.config(); config.teams[0].checkpoints = 'manual'; f.store.saveConfig(config);
    const r = f.create(); await until(() => f.store.get(r.id).status === 'paused');
    const checkpoint = f.store.get(r.id);
    assert.equal(checkpoint.turns.filter(t => t.startedAt).length, 1);
    assert(checkpoint.turns.some(t => t.status === 'queued'));
    f.engine.decide(r.id, checkpoint.decisions[0].id, 'accept'); f.engine.control(r.id, 'resume');
    await until(() => f.store.get(r.id).status === 'completed');
  } finally { await f.close(); }
});

test('global turn budget stops self-sustaining message loops', async () => {
  const f = fixture(async c => ({ reply: { message: 'Передаю ход', actions: [{ type: 'send', to: c.participant.id === 'marina' ? 'alex' : 'marina', text: 'Ещё один ход' }] } }));
  try {
    const config = f.store.config(); config.teams[0].maxTurns = 4; f.store.saveConfig(config);
    const r = f.create(); await until(() => f.store.get(r.id).status === 'paused');
    assert.equal(f.store.get(r.id).turns.filter(t => t.startedAt).length, 4);
    assert.throws(() => f.engine.control(r.id, 'resume'), /Лимит ходов/);
  } finally { await f.close(); }
});
