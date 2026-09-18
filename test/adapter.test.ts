import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store';
import { Engine } from '../src/server/engine';
import { gigacodeAdapter, cliArgs, type AgentContext } from '../src/server/agents/adapter';
import { protocol } from '../src/server/agents/context';

test('roles keep their edit mode, verification shell is allowed, and repair disables tools', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'teamytime-subagents-'));
  const store = new Store(directory), engine = new Engine(store);
  try {
    const run = engine.create({ prompt: 'Изучить код', teamId: 'default-team', mode: 'demo' }); engine.control(run.id, 'pause');
    for (const access of ['discuss', 'execute'] as const) {
      for (const protocolRepair of [false, true]) {
          const c: AgentContext = { run, turn: run.turns[0],
            participant: { ...run.participants[0], role: { ...run.participants[0].role, access } },
            protocolRepair, cli: { command: 'gigacode', timeoutSeconds: 10 },
            signal: new AbortController().signal, draft: () => {}, init: () => {}, activity: () => {} };
          const args = cliArgs(c), excluded = args.slice(args.indexOf('--exclude-tools') + 1, args.indexOf('--output-format'));
          const editing = access === 'execute' && !protocolRepair;
          const subagents = !protocolRepair;
          assert.equal(excluded.includes('agent'), !subagents, JSON.stringify({ access, protocolRepair }));
          assert(args.includes(`--approval-mode=${editing ? 'auto-edit' : 'plan'}`));
          assert.equal(excluded.includes('edit'), !editing); assert.equal(excluded.includes('write_file'), !editing);
          assert(excluded.includes('exit_plan_mode')); assert.equal(args.includes('--allowed-tools'), !protocolRepair);
          assert(args[args.indexOf('--append-system-prompt') + 1].endsWith(!subagents
            ? 'В текущем ходе субагенты отключены.'
            : editing ? 'В текущем ходе разрешены субагенты для анализа и выполнения работы, включая правки файлов в рамках поручения.'
              : 'В текущем ходе можно выполнять проверки, сборки и тесты через run_shell_command. Нельзя менять исходные файлы. Субагенты доступны для чтения, поиска, анализа и таких же проверок в режиме plan.'));
      }
    }
  } finally { await engine.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('real process adapter uses stable sessions, handles fragmented output, and cancels', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'teamytime-cli-'));
  const script = path.join(directory, 'gigacode');
  writeFileSync(script, `#!${process.execPath}\n
const args = process.argv.slice(2);
const id = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
if (args.includes('HANG')) { setInterval(() => {}, 1000); }
else {
 const resumed = args.includes('--resume');
 const reply = resumed ? 'Продолжение сессии' : 'Новая сессия';
 const text = [
  {type:'system',subtype:'init',session_id:id,model:'CodeChat'},
  {type:'assistant',message:{model:'Qwen',content:[{type:'text',text:reply}]}},
  {type:'result',subtype:'success',session_id:id,result:reply,usage:{input_tokens:resumed?220:100,output_tokens:resumed?15:5}}
 ].map(x=>JSON.stringify(x)).join('\\n');
 const b=Buffer.from(text); let at=0;
 const timer=setInterval(()=>{ if(at>=b.length){clearInterval(timer);return;} process.stdout.write(b.subarray(at,at+13)); at+=13; },1);
}
`, { mode: 0o700 });
  const store = new Store(directory), engine = new Engine(store);
  try {
    const run = engine.create({ prompt: 'Проверка адаптера', teamId: 'default-team', mode: 'demo' }); engine.control(run.id, 'pause');
    const p = run.participants[0]; const abort = new AbortController();
    const c: AgentContext = { run, turn: run.turns[0], participant: p, cli: { command: script, timeoutSeconds: 10 }, signal: abort.signal, draft: () => {}, init: () => {}, activity: () => {} };
    const args = cliArgs(c);
    assert(args[args.indexOf('--append-system-prompt') + 1].includes(protocol));
    assert(!args[args.indexOf('-p') + 1].includes(protocol));
    const first = await gigacodeAdapter(c); assert.equal(first.reply.message, 'Новая сессия'); assert.equal(first.usage?.input, 100);
    assert.deepEqual(first.contextCheckpoint, { sessionId: p.sessionId, messageIds: [run.messages[0].id] });
    p.sessionStarted = true; p.cumulativeUsage = first.cumulativeUsage;
    assert(cliArgs(c).includes('--resume')); assert(cliArgs(c).includes(p.sessionId));
    assert(!cliArgs(c).some(arg => arg.startsWith('--max-session-turns')));
    const next = await gigacodeAdapter(c); assert.equal(next.reply.message, 'Продолжение сессии'); assert.equal(next.usage?.input, 120);
    p.model = 'HANG'; const hanging = gigacodeAdapter(c); setTimeout(() => abort.abort(), 50);
    await assert.rejects(hanging, /остановлен/);
  } finally { await engine.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('missing model falls back once, preserves session and logs both attempts', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'teamytime-model-'));
  const script = path.join(directory, 'gigacode');
  writeFileSync(script, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('attempts.jsonl', JSON.stringify(args) + '\\n');
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'default';
const id = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
if (model === 'late') process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:id})+'\\n');
if (model !== 'default' || fs.existsSync('fail-default')) {
 process.stderr.write(model === 'auth' ? 'Authentication required\\n' : "Error: The selected model 'missing' is not present in the current backend catalogue\\n");
 process.exitCode = 1;
} else {
 process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:id,result:'{"message":"Default reply","actions":[]}'}));
}
`, { mode: 0o700 });
  const store = new Store(directory), engine = new Engine(store);
  try {
    const run = engine.create({ prompt: 'Проверка модели', teamId: 'default-team', mode: 'demo', workspace: directory }); engine.control(run.id, 'pause');
    const p = run.participants[0]; p.model = 'missing'; p.sessionStarted = true;
    const activities: string[] = [];
    const controller = new AbortController();
    const c: AgentContext = { run, turn: run.turns[0], participant: p, cli: { command: script, timeoutSeconds: 10 }, signal: controller.signal,
      draft: () => {}, init: () => {}, activity: text => activities.push(text) };
    const attempts = () => readFileSync(path.join(directory, 'attempts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    const result = await gigacodeAdapter(c);
    assert.equal(result.reply.message, 'Default reply'); assert.match(result.warnings![0], /по умолчанию/);
    assert.equal(p.model, 'missing');
    assert.equal(attempts().length, 2); assert(attempts()[0].includes('--model')); assert(!attempts()[1].includes('--model'));
    assert(attempts().every(args => args.includes('--resume') && args.includes(p.sessionId)));
    assert(activities.some(text => text.includes('Повторяю')));
    for (const model of ['auth', 'late']) {
      const before = attempts().length; p.model = model;
      await assert.rejects(gigacodeAdapter(c)); assert.equal(attempts().length, before + 1);
    }
    writeFileSync(path.join(directory, 'fail-default'), ''); p.model = 'missing';
    const before = attempts().length;
    await assert.rejects(gigacodeAdapter(c), /модель отсутствует/); assert.equal(attempts().length, before + 2);
    p.model = 'default'; await assert.rejects(gigacodeAdapter(c)); assert.equal(attempts().length, before + 3);
    p.model = 'missing'; c.activity = () => controller.abort();
    await assert.rejects(gigacodeAdapter(c), /остановлен/); assert.equal(attempts().length, before + 4);
  } finally { await engine.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('protocol errors are retried in the same session without tools and usage is counted once', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'teamytime-protocol-retry-'));
  const script = path.join(directory, 'gigacode');
  writeFileSync(script, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const attempts = fs.existsSync('attempts.jsonl') ? fs.readFileSync('attempts.jsonl', 'utf8').trim().split('\\n').filter(Boolean).length : 0;
fs.appendFileSync('attempts.jsonl', JSON.stringify(args) + '\\n');
const id = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
const repair = args[args.indexOf('-p') + 1].includes('Предыдущий ответ отклонён Teamytime');
const result = attempts === 0 ? '@send marina\\n' + 'x'.repeat(24001) + '\\n@end' : 'Исправленный ответ';
process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:id,model:'TestModel'})+'\\n');
process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:id,result,usage:{input_tokens:repair?160:100,output_tokens:repair?20:10}}));
`, { mode: 0o700 });
  const store = new Store(directory), engine = new Engine(store);
  try {
    const run = engine.create({ prompt: 'Проверить автоповтор', teamId: 'default-team', mode: 'demo', workspace: directory }); engine.control(run.id, 'pause');
    const activities: string[] = [];
    const c: AgentContext = { run, turn: run.turns[0], participant: run.participants[0], cli: { command: script, timeoutSeconds: 10 },
      signal: new AbortController().signal, draft: () => {}, init: () => {}, activity: text => activities.push(text) };
    const result = await gigacodeAdapter(c);
    const attempts = readFileSync(path.join(directory, 'attempts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.equal(result.reply.message, 'Исправленный ответ'); assert.equal(attempts.length, 2);
    assert.deepEqual(result.contextCheckpoint, { sessionId: c.participant.sessionId, messageIds: [run.messages[0].id] });
    assert(attempts[0].includes('--session-id')); assert(attempts[1].includes('--resume'));
    assert(attempts[1].includes('--approval-mode=plan')); assert(!attempts[1].includes('--allowed-tools'));
    for (const tool of ['agent', 'run_shell_command', 'read_file', 'send_message', 'todo_write', 'edit', 'write_file']) assert(attempts[1].includes(tool));
    assert.match(attempts[1][attempts[1].indexOf('-p') + 1], /actions\.0\.text: превышен лимит 24000/);
    assert.equal(result.usage?.total, 180); assert.equal(result.cumulativeUsage?.total, 180);
    assert(result.warnings?.some(warning => warning.includes('автоматически исправлен')));
    assert(activities.some(activity => activity.includes('Исправляет формат ответа (1/2)')));
  } finally { await engine.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('API response timeout is recovered in the same session without rerunning tools', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'teamytime-timeout-recovery-'));
  const script = path.join(directory, 'gigacode');
  writeFileSync(script, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const attempts = fs.existsSync('attempts.jsonl') ? fs.readFileSync('attempts.jsonl', 'utf8').trim().split('\\n').filter(Boolean).length : 0;
fs.appendFileSync('attempts.jsonl', JSON.stringify(args) + '\\n');
const id = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
const result = attempts === 0 ? '[API Error: Request timeout after 11s. Try again.]' : '@send marina\\nПроверка завершена\\n@end';
process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:id,result,usage:{input_tokens:(attempts+1)*100,output_tokens:(attempts+1)*10}}));
`, { mode: 0o700 });
  const store = new Store(directory), engine = new Engine(store);
  try {
    const run = engine.create({ prompt: 'Проверить восстановление', teamId: 'default-team', mode: 'demo', workspace: directory }); engine.control(run.id, 'pause');
    const activities: string[] = [];
    const c: AgentContext = { run, turn: run.turns[0], participant: run.participants[0], cli: { command: script, timeoutSeconds: 10 },
      signal: new AbortController().signal, draft: () => {}, init: () => {}, activity: value => activities.push(value) };
    const result = await gigacodeAdapter(c);
    const attempts = readFileSync(path.join(directory, 'attempts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.equal(attempts.length, 2); assert(attempts[1].includes('--resume'));
    assert(attempts[1].includes('--approval-mode=plan')); assert(!attempts[1].includes('--allowed-tools'));
    assert.match(attempts[1][attempts[1].indexOf('-p') + 1], /восстанови только итоговый ответ целиком/);
    assert.deepEqual(result.reply.actions, [{ type: 'send', to: 'marina', text: 'Проверка завершена' }]);
    assert(result.warnings?.some(warning => warning.includes('восстановлен после таймаута')));
    assert(activities.some(activity => activity.includes('Восстанавливает ответ после таймаута')));
  } finally { await engine.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('protocol retry is bounded and preserves the final raw reply for manual repair', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'teamytime-protocol-bounded-'));
  const script = path.join(directory, 'gigacode');
  writeFileSync(script, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2); fs.appendFileSync('attempts.jsonl', JSON.stringify(args) + '\\n');
const id = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
const count = fs.readFileSync('attempts.jsonl', 'utf8').trim().split('\\n').length;
process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:id,result:'@continue',usage:{input_tokens:count*100,output_tokens:count*10}}));
`, { mode: 0o700 });
  const store = new Store(directory), engine = new Engine(store);
  try {
    const run = engine.create({ prompt: 'Проверить лимит', teamId: 'default-team', mode: 'demo', workspace: directory }); engine.control(run.id, 'pause');
    const c: AgentContext = { run, turn: run.turns[0], participant: run.participants[0], cli: { command: script, timeoutSeconds: 10 },
      signal: new AbortController().signal, draft: () => {}, init: () => {}, activity: () => {} };
    await assert.rejects(gigacodeAdapter(c), error => error instanceof Error && (error as any).raw === '@continue' && (error as any).usage.total === 330);
    assert.equal(readFileSync(path.join(directory, 'attempts.jsonl'), 'utf8').trim().split('\n').length, 3);
  } finally { await engine.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
