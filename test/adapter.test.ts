import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store';
import { Engine } from '../src/server/engine';
import { gigacodeAdapter, cliArgs, type AgentContext } from '../src/server/agents/adapter';

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
    const first = await gigacodeAdapter(c); assert.equal(first.reply.message, 'Новая сессия'); assert.equal(first.usage?.input, 100);
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
