import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TurnLogger, diagnosticLimits, redact } from '../src/server/diagnostics';
import { Store } from '../src/server/store';
import { Engine } from '../src/server/engine';
import { runReport } from '../src/server/report';

async function until(fn: () => boolean) {
  const start = Date.now();
  while (!fn()) { if (Date.now() - start > 6000) throw new Error('Timed out'); await delay(10); }
}

test('diagnostics redact complete fragmented UTF-8 lines, nested credentials, reasoning and deltas', () => {
  const entries: { stream: string; data: unknown }[] = [];
  const logger = new TurnLogger((stream, data) => entries.push({ stream, data }), '/private/workspace');
  const stdout = [
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }, { type: 'text', text: 'Привет' }, { type: 'tool_use', input: { api_key: 'KEY_SECRET', file: '/private/workspace/result.md' } }] } },
    { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'SPLIT_SECRET' } } },
    { type: 'result', result: '{"message":"Готово","password":"NESTED_SECRET"}' },
  ].map(e => JSON.stringify(e)).join('\n') + '\nnot stream-json: Привет';
  const buffer = Buffer.from(stdout);
  for (let i = 0; i < buffer.length; i++) logger.feed('stdout', buffer.subarray(i, i + 1));
  logger.feed('stderr', Buffer.from('Authorization: Bear'));
  logger.feed('stderr', Buffer.from('er BEARER_SECRET\nLogin: https://example.test/oauth?code=AUTH_SECRET\napi_key=ASSIGN'));
  logger.feed('stderr', Buffer.from('MENT_SECRET'));
  assert.equal(entries.filter(e => e.stream === 'stderr').length, 2, 'unfinished line is not persisted yet');
  logger.end();
  const serialized = JSON.stringify(entries);
  for (const secret of ['PRIVATE_REASONING', 'KEY_SECRET', 'SPLIT_SECRET', 'NESTED_SECRET', 'BEARER_SECRET', 'AUTH_SECRET', 'ASSIGNMENT_SECRET', '/private/workspace']) assert(!serialized.includes(secret), secret);
  assert(serialized.includes('Привет')); assert(!serialized.includes('�'));
  assert(serialized.includes('[WORKSPACE]/result.md'));
  assert.equal(entries.filter(e => e.stream === 'stdout').length, 4);
  assert.equal(entries.at(-2)?.data, 'not stream-json: Привет');
  assert.deepEqual(redact({ input_tokens: 17, output_tokens: 2, token: 'secret' }), { input_tokens: 17, output_tokens: 2, token: '[REDACTED]' });
});

test('oversized lines are omitted as a whole and logging failure does not crash a CLI callback', () => {
  const entries: unknown[] = [];
  const logger = new TurnLogger((_stream, data) => entries.push(data), '/workspace');
  logger.feed('stdout', Buffer.from('x'.repeat(diagnosticLimits.lineBytes + 1)));
  logger.feed('stdout', Buffer.from('secret-tail\n{"type":"result","result":"OK"}\n'));
  logger.end();
  assert.deepEqual(entries, [{ omitted: 'line_too_large', limitBytes: diagnosticLimits.lineBytes }, { type: 'result', result: 'OK' }]);
  let writes = 0;
  const broken = new TurnLogger(() => { writes++; throw new Error('disk full'); }, '/workspace');
  assert.doesNotThrow(() => { broken.feed('stderr', Buffer.from('first\nsecond\n')); broken.end(); });
  assert.equal(writes, 1); assert.match(broken.error!, /Не удалось сохранить/);
});

test('bounded logs retain final failures and survive reopening without mixing tasks', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'teamytime-logs-'));
  let store = new Store(directory);
  const engine = new Engine(store);
  try {
    const first = engine.create({ prompt: 'Первый запуск', mode: 'demo', teamId: 'default-team' }); engine.control(first.id, 'pause');
    const second = engine.create({ prompt: 'PRIVATE_OTHER_TASK', mode: 'demo', teamId: 'default-team' }); engine.control(second.id, 'pause');
    store.update(second.id, 'legacy-run', r => { r.turns[0].startedAt = new Date().toISOString(); r.turns[0].status = 'succeeded'; });
    assert.deepEqual((runReport(store, second.id) as any).diagnostics.missingTurnIds, [second.turns[0].id]);
    const turnId = first.turns[0].id;
    store.beginDiagnostics(first.id, turnId, { startedAt: 'then' }, first.workspace);
    const logger = new TurnLogger((stream, data) => store.appendDiagnostic(turnId, stream, data), first.workspace);
    for (let i = 0; i < 550; i++) logger.feed('stdout', Buffer.from(`entry-${i}\n`));
    for (let i = 0; i < 12; i++) logger.feed('stderr', Buffer.from(`${i}: ${'x'.repeat(60000)}\n`));
    logger.event({ type: 'process-exit', code: 7 }); logger.end();
    store.finishDiagnostics(turnId, { status: 'failed', error: 'Final failure' }, first.workspace);
    store.update(first.id, 'simulate-crash', r => { r.status = 'running'; r.turns[0].status = 'running'; r.turns[0].startedAt = new Date().toISOString(); });
    await engine.close(); store.close(); store = new Store(directory); store.recover();
    const [logged] = store.diagnostics(first.id);
    assert(logged.droppedEntries >= 38);
    assert.equal(logged.entries.filter(e => e.stream === 'stdout').length, diagnosticLimits.streamEntries);
    assert(logged.entries.some(e => e.data === 'entry-549'));
    assert(!logged.entries.some(e => e.data === 'entry-0'));
    assert(logged.entries.some(e => e.data.type === 'process-exit' && e.data.code === 7));
    assert.equal(logged.outcome.error, 'Final failure');
    assert.equal(store.get(first.id).status, 'interrupted');
    const report = JSON.stringify(runReport(store, first.id));
    assert(!report.includes('PRIVATE_OTHER_TASK')); assert(report.includes('entry-549')); assert(!report.includes(first.workspace));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('real CLI failures, retries, timeout and cancellation leave separate durable diagnostics', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'teamytime-report-cli-'));
  const script = path.join(directory, 'gigacode');
  writeFileSync(script, `#!${process.execPath}\n
const args = process.argv.slice(2);
const mode = args[args.indexOf('--model') + 1];
const id = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:id,model:'TestModel'})+'\\n');
if (mode === 'broken') { process.stdout.write('not valid JSON\\n'); setInterval(()=>{},1000); }
else if (mode === 'exit') { process.stderr.write('API_KEY=DO_NOT_EXPORT\\nnetwork unavailable'); process.exitCode=9; }
else if (mode === 'hang') { process.stderr.write('still waiting\\n'); setInterval(()=>{},1000); }
else { process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:id,result:'not a team reply'})); }
`, { mode: 0o700 });
  const store = new Store(directory), engine = new Engine(store);
  const config = store.config(); config.cli = { command: script, timeoutSeconds: 1 }; config.teams[0].members[0].model = 'broken'; store.saveConfig(config);
  const create = (model: string) => {
    const config = store.config(); config.teams[0].members[0].model = model; store.saveConfig(config);
    return engine.create({ prompt: 'Проверка отчёта', mode: 'gigacode', teamId: 'default-team' });
  };
  try {
    const broken = create('broken'); await until(() => store.get(broken.id).status === 'paused');
    assert(store.diagnostics(broken.id)[0].entries.some(e => e.data === 'not valid JSON'));
    assert.match(store.diagnostics(broken.id)[0].outcome.error, /stream-json/);
    engine.resolveTurn(broken.id, broken.turns[0].id, 'retry'); engine.control(broken.id, 'resume');
    await until(() => store.get(broken.id).status === 'paused');
    const attempts = store.diagnostics(broken.id); assert.equal(attempts.length, 2); assert.notEqual(attempts[0].turnId, attempts[1].turnId);
    assert(attempts[1].entries.some(e => e.data.type === 'process-start' && e.data.args.includes('--resume')));
    const exited = create('exit'); await until(() => store.get(exited.id).status === 'paused');
    const exitLog = store.diagnostics(exited.id)[0];
    assert(exitLog.entries.some(e => e.stream === 'stderr' && e.data === 'network unavailable'));
    assert(exitLog.entries.some(e => e.data.type === 'process-exit' && e.data.code === 9));
    assert(!JSON.stringify(exitLog).includes('DO_NOT_EXPORT'));
    const badReply = create('reply'); await until(() => store.get(badReply.id).status === 'paused');
    const replyLog = store.diagnostics(badReply.id)[0];
    assert(replyLog.entries.some(e => e.data.type === 'result' && e.data.result === 'not a team reply'));
    assert.match(replyLog.outcome.error, /вне протокола/);
    const timedOut = create('hang'); await until(() => store.get(timedOut.id).status === 'paused');
    assert.match(store.diagnostics(timedOut.id)[0].outcome.error, /за 1 секунд/);
    const cancelled = create('hang'); await until(() => store.diagnostics(cancelled.id)[0]?.entries.some(e => e.data === 'still waiting') ?? false);
    const activeReport = runReport(store, cancelled.id) as any;
    assert.equal(activeReport.run.status, 'running'); assert.equal(activeReport.diagnostics.turns[0].outcome, null);
    assert(activeReport.diagnostics.turns[0].entries.some((e: any) => e.data === 'still waiting'));
    engine.control(cancelled.id, 'cancel');
    await until(() => !!store.diagnostics(cancelled.id)[0].outcome);
    assert.equal(store.diagnostics(cancelled.id)[0].outcome.status, 'cancelled');
    assert(store.diagnostics(cancelled.id)[0].entries.some(e => e.data.type === 'process-exit' && e.data.signal === 'SIGTERM'));
  } finally { await engine.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
