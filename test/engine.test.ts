import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/server/store';
import { Engine } from '../src/server/engine';
import type { Adapter, AgentContext, AgentResult } from '../src/server/agents/adapter';
import { buildContext } from '../src/server/agents/context';

export async function until(fn: () => boolean, timeout = 7000) { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('Timed out'); await delay(10); } }
function fixture(adapter?: Adapter) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'teamytime-test-'));
  const store = new Store(directory), engine = new Engine(store, adapter ? { demo: adapter, gigacode: adapter } : undefined);
  const create = () => engine.create({ prompt: 'Проверить совместную работу команды', teamId: 'default-team', mode: 'demo' });
  return { directory, store, engine, create, async close() { await engine.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('context delivery survives restart and commits only the successful input snapshot', async () => {
  let finish!: (result: AgentResult) => void;
  const calls: { context: AgentContext; prepared: ReturnType<typeof buildContext> }[] = [];
  const f = fixture(c => {
    calls.push({ context: c, prepared: buildContext(c.run, c.turn, c.participant) });
    return new Promise(resolve => { finish = resolve; });
  });
  try {
    const r = f.create(); await until(() => calls.length === 1);
    // This message arrives after the running turn's snapshot: it must not be marked delivered.
    f.engine.send(r.id, { kind: 'message', text: 'Новое ограничение' });
    f.engine.control(r.id, 'pause');
    finish({ reply: { message: 'Готово', actions: [] }, contextCheckpoint: calls[0].prepared.checkpoint });
    await until(() => f.store.get(r.id).status === 'paused');
    const firstCheckpoint = f.store.get(r.id).participants[0].contextCheckpoint!;
    assert.deepEqual(firstCheckpoint.messageIds, [r.messages[0].id]);
    f.engine.control(r.id, 'resume'); await until(() => calls.length === 2);
    assert(JSON.parse(calls[1].prepared.prompt).requirementsAndCauses.some((m: { text: string }) => m.text === 'Новое ограничение'));
    // The CLI succeeded, but invalid actions must not advance the durable checkpoint.
    finish({ reply: { message: 'Некорректный ответ', actions: [{ type: 'send', to: 'missing-member', text: 'test' }] }, contextCheckpoint: calls[1].prepared.checkpoint });
    await until(() => f.store.get(r.id).status === 'paused');
    assert.deepEqual(f.store.get(r.id).participants[0].contextCheckpoint, firstCheckpoint);
    const failed = f.store.get(r.id).turns.find(t => t.status === 'failed')!;
    f.engine.resolveTurn(r.id, failed.id, 'retry', true); await until(() => calls.length === 3);
    assert.deepEqual(calls[2].context.turn.causeIds, failed.causeIds);
    assert(JSON.parse(calls[2].prepared.prompt).requirementsAndCauses.some((m: { text: string }) => m.text === 'Новое ограничение'));
    finish({ reply: { message: 'Готово', actions: [] }, contextCheckpoint: calls[2].prepared.checkpoint });
    await until(() => f.store.get(r.id).status === 'waiting');
    const checkpoint = f.store.get(r.id).participants[0].contextCheckpoint;
    assert.notDeepEqual(checkpoint, firstCheckpoint);
    // A separate store reader exercises persisted JSON, not the adapter's in-memory copy.
    const reopened = new Store(f.directory);
    try { assert.deepEqual(reopened.get(r.id).participants[0].contextCheckpoint, checkpoint); }
    finally { reopened.close(); }
  } finally { await f.close(); }
});

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
    assert(done.artifacts.length > 0); assert(done.artifacts.some(a => a.kind === 'result' && a.authorId !== done.team.leadId)); assert(done.decisions.every(d => d.status === 'accepted'));
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

test('continue replenishes an exhausted task from current team settings', async () => {
  const f = fixture(async c => ({ reply: { message: 'Передаю ход', actions: [{ type: 'send', to: c.participant.id === 'marina' ? 'alex' : 'marina', text: 'Ещё один ход' }] } }));
  try {
    const config = f.store.config(); config.teams[0].maxTurns = 4; f.store.saveConfig(config);
    const r = f.create(); await until(() => f.store.get(r.id).status === 'paused');
    const sessions = f.store.get(r.id).participants.map(p => p.sessionId);
    assert.equal(f.store.get(r.id).turns.filter(t => t.startedAt).length, 4);
    const changed = f.store.config(); changed.teams[0].maxTurns = 7; f.store.saveConfig(changed);
    f.engine.control(r.id, 'resume');
    assert.equal(f.store.get(r.id).team.maxTurns, 11);
    await until(() => f.store.get(r.id).status === 'paused');
    const extended = f.store.get(r.id);
    assert.equal(extended.turns.filter(t => t.startedAt).length, 11);
    assert.deepEqual(extended.participants.map(p => p.sessionId), sessions);
  } finally { await f.close(); }
});

test('continue after an exhausted final turn queues the lead when no work remains queued', async () => {
  let calls = 0;
  const f = fixture(async () => ({ reply: { message: `Ход ${++calls}`, actions: [] } }));
  try {
    const r = f.create(); await until(() => f.store.get(r.id).status === 'waiting');
    f.store.update(r.id, 'fixture', run => { run.team.maxTurns = 1; });
    const config = f.store.config(); config.teams[0].maxTurns = 6; f.store.saveConfig(config);
    f.engine.control(r.id, 'resume');
    await until(() => calls === 2 && f.store.get(r.id).status === 'waiting');
    const state = f.store.get(r.id);
    assert.equal(state.team.maxTurns, 7);
    assert(state.messages.some(m => m.kind === 'system' && m.text.includes('исчерпания лимита ходов')));
    assert.equal(state.turns.at(-1)?.agentId, state.team.leadId);
  } finally { await f.close(); }
});

test('protocol repair validates all actions, preserves usage and never invokes the adapter again', async () => {
  const { ReplyError } = await import('../src/server/agents/protocol');
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    const error = new ReplyError('Ответ вне протокола: нет @end', '@artifact result.md\nDone');
    error.usage = error.cumulativeUsage = { input: 100, output: 20, total: 120, cachedInput: 0 };
    throw error;
  });
  try {
    const r = f.create(); await until(() => f.store.get(r.id).status === 'paused');
    const turn = f.store.get(r.id).turns[0];
    assert.equal(turn.rawReply, '@artifact result.md\nDone');
    assert.equal(turn.usage?.total, 120);
    assert.throws(() => f.engine.repairTurn(r.id, turn.id, '@artifact result.md\nDone\n@end\n@send missing\nhello\n@end'), /получателя/);
    assert.equal(f.store.get(r.id).artifacts.length, 0);
    f.engine.repairTurn(r.id, turn.id, '@artifact result.md\nDone\n@end', true);
    await until(() => f.store.get(r.id).status === 'waiting');
    const result = f.store.get(r.id);
    assert.equal(calls, 1); assert.equal(result.turns.length, 1); assert.equal(result.artifacts.length, 1); assert.equal(result.artifacts[0].kind, 'working');
    assert.equal(result.turns[0].usage?.total, 120); assert.equal(result.turns[0].rawReply, undefined);
    assert.throws(() => f.engine.repairTurn(r.id, turn.id, 'Again'), /нет ответа/);
    assert.equal(f.store.diagnostics(r.id)[0].outcome.repaired, true);
  } finally { await f.close(); }
});

test('protocol repair rejects stale requirements and preserves the failed answer', async () => {
  const { ReplyError } = await import('../src/server/agents/protocol');
  const f = fixture(async () => { throw new ReplyError('bad format', '@continue'); });
  try {
    const r = f.create(); await until(() => f.store.get(r.id).status === 'paused');
    f.engine.send(r.id, { kind: 'update', text: 'Новые требования' });
    assert.throws(() => f.engine.repairTurn(r.id, r.turns[0].id, 'Done'), /Требования изменились/);
    assert.equal(f.store.get(r.id).turns[0].status, 'failed');
  } finally { await f.close(); }
});

test('read-only delegation cannot elevate access and persists across continuation and retry', async () => {
  const calls: AgentContext[] = [];
  const f = fixture(async c => {
    calls.push(c);
    if (calls.length === 1) return { reply: { message: 'Диагностика', actions: [{ type: 'send', to: 'vera', text: 'Проверить', readOnly: true }] } };
    assert.equal(c.turn.readOnly, true);
    if (calls.length === 2) return { reply: { message: 'Дальше', actions: [{ type: 'continue', reason: 'Ещё проверка' }] } };
    if (calls.length === 3) throw new Error('failed');
    if (calls.length === 4) return { reply: { message: 'Передать', actions: [{ type: 'send', to: 'alex', text: 'Проверить тоже', readOnly: false }] } };
    return { reply: { message: 'Готово', actions: [] } };
  });
  try {
    const r = f.create(); await until(() => f.store.get(r.id).status === 'paused');
    const failed = f.store.get(r.id).turns.find(t => t.status === 'failed')!;
    f.engine.resolveTurn(r.id, failed.id, 'retry', true);
    await until(() => f.store.get(r.id).status === 'waiting');
    assert.equal(calls.length, 5);
    assert(calls.slice(1).every(c => c.turn.readOnly));
  } finally { await f.close(); }
});

test('queued diagnostic and execution requests never coalesce into a writing turn', async () => {
  const f = fixture(async () => ({ reply: { message: 'done', actions: [] } }));
  try {
    const r = f.create(); f.engine.control(r.id, 'pause');
    f.engine.send(r.id, { kind: 'message', recipientId: 'vera', text: 'Диагностика', readOnly: true });
    f.engine.send(r.id, { kind: 'message', recipientId: 'vera', text: 'Реализация', readOnly: false });
    const turns = f.store.get(r.id).turns.filter(t => t.agentId === 'vera');
    assert.equal(turns.length, 2); assert.deepEqual(turns.map(t => t.readOnly), [true, false]);
  } finally { await f.close(); }
});

test('diagnostic scope survives user status messages and accepted decisions until explicitly changed', async () => {
  const f = fixture(async () => ({ reply: { message: 'done', actions: [] } }));
  try {
    const r = f.engine.create({ prompt: 'Диагностика', teamId: 'default-team', mode: 'demo', readOnly: true });
    f.engine.control(r.id, 'pause');
    f.engine.send(r.id, { kind: 'message', text: 'Как дела?' });
    f.store.update(r.id, 'fixture', r => { r.decisions.push({ id: 'd', title: 'План', rationale: 'Проверка', authorId: 'marina', status: 'proposed', revision: 1, createdAt: 'now' }); });
    f.engine.decide(r.id, 'd', 'accept');
    assert(f.store.get(r.id).turns.every(t => t.readOnly));
    f.engine.send(r.id, { kind: 'message', text: 'Теперь реализуй', readOnly: false });
    assert.equal(f.store.get(r.id).turns.at(-1)!.readOnly, false);
  } finally { await f.close(); }
});

test('only the lead can create or publish final result artifacts', async () => {
  const f = fixture(async c => c.participant.id === 'marina'
    ? { reply: { message: 'Передаю исполнителю', actions: [{ type: 'send', to: 'vera', text: 'Подготовь финальный документ' }] } }
    : { reply: { message: 'Пытаюсь опубликовать', actions: [{ type: 'result', title: 'result.md', content: 'Не утверждено координатором' }] } });
  try {
    const r = f.create(); await until(() => f.store.get(r.id).status === 'paused');
    const state = f.store.get(r.id), failed = state.turns.find(t => t.agentId === 'vera' && t.status === 'failed');
    assert(failed); assert.match(failed.error!, /Только ведущий/); assert.equal(state.artifacts.length, 0);
  } finally { await f.close(); }
});
