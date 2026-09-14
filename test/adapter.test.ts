import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
 const reply = JSON.stringify({message: resumed ? 'Продолжение сессии' : 'Новая сессия', actions: []});
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
    const next = await gigacodeAdapter(c); assert.equal(next.reply.message, 'Продолжение сессии'); assert.equal(next.usage?.input, 120);
    p.model = 'HANG'; const hanging = gigacodeAdapter(c); setTimeout(() => abort.abort(), 50);
    await assert.rejects(hanging, /остановлен/);
  } finally { await engine.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
