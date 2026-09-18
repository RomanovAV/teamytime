import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store';
import { Engine } from '../src/server/engine';
import { buildContext, buildPrompt, protocol } from '../src/server/agents/context';
import type { Message } from '../src/shared/types';
import { artifactPath, prepareArtifacts } from '../src/server/agents/artifacts';

const context = (prompt: string) => JSON.parse(prompt);

test('large artifacts stay out of prompts while their complete immutable files remain available', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'teamytime-context-'));
  const store = new Store(directory), engine = new Engine(store);
  try {
    const run = engine.create({ prompt: 'Проверить план', mode: 'demo', teamId: 'default-team' }); engine.control(run.id, 'pause');
    const artifact = { id: 'plan', title: '../../plan.md', content: 'П'.repeat(9677) + '\nLAST_SECTION', authorId: 'marina', revision: 1, createdAt: 'now' };
    run.artifacts = [artifact];
    const small = context(buildPrompt(run, run.turns[0], run.participants[0]));
    assert.equal(small.artifacts[0].content, undefined); assert.equal(small.artifacts[0].truncated, true);
    assert.equal(small.artifacts[0].authorId, artifact.authorId);
    run.artifacts.push(...Array.from({ length: 4 }, (_, i) => ({ ...artifact, id: `large-${i}`, content: `${i}` + 'Я'.repeat(49000) + 'END' })));
    await Promise.all([prepareArtifacts(run), prepareArtifacts(run), prepareArtifacts(run)]);
    const prompt = buildPrompt(run, run.turns[0], run.participants[0]);
    assert(Buffer.byteLength(prompt) < 10000);
    assert(!prompt.includes('LAST_SECTION'));
    const large = context(prompt);
    assert(large.artifacts.some((a: any) => a.truncated));
    for (const a of large.artifacts) {
      assert.equal(readFileSync(a.filePath, 'utf8'), run.artifacts.find(original => original.id === a.id)!.content);
      assert.equal(a.totalCharacters, readFileSync(a.filePath, 'utf8').length);
      assert(a.filePath.startsWith(path.join(run.workspace, '.teamytime', 'artifacts')));
    }
    await prepareArtifacts(run); // Idempotent, no truncation on retries.
    writeFileSync(artifactPath(run, artifact), 'changed');
    await assert.rejects(prepareArtifacts(run), /файл артефакта изменён/);
  } finally { await engine.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('resumed sessions receive only new relevant messages, with requirements and retry causes intact', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'teamytime-context-delta-'));
  const store = new Store(directory), engine = new Engine(store);
  try {
    const run = engine.create({ prompt: 'Проверить план', mode: 'demo', teamId: 'default-team' }); engine.control(run.id, 'pause');
    const member = run.participants[0], turn = run.turns[0];
    const add = (id: string, fields: Partial<Message> = {}) => {
      run.messages.push({ id, authorId: 'oleg', kind: 'agent', text: `Вывод ${id}`, recipientIds: [],
        deliveredTo: [], appliedBy: [], revision: 1, createdAt: 'now', ...fields });
    };
    add('public'); add('addressed', { recipientIds: [member.id] });
    add('other', { recipientIds: ['vera'] }); add('own', { authorId: member.id });
    add('stale', { stale: true }); add('old', { revision: 0 });
    const first = buildContext(run, turn, member);
    assert.deepEqual(context(first.prompt).recentMessages.map((m: Message) => m.id), ['public', 'addressed']);
    assert(!first.prompt.includes(protocol));
    assert.equal(member.contextCheckpoint, undefined); // Building or a failed attempt must not consume messages.
    assert.equal(buildContext(run, turn, member).prompt, first.prompt);
    member.sessionStarted = true; member.contextCheckpoint = first.checkpoint;
    add('new'); add('update', { kind: 'user', authorId: null, text: 'Без правок файлов', revision: 2 });
    run.revision = 2;
    add('current', { revision: 2 });
    turn.causeIds = ['addressed']; // Retry remains complete, even if the cause was seen in an older revision.
    const second = context(buildPrompt(run, turn, member));
    assert.deepEqual(second.recentMessages.map((m: Message) => m.id), ['current']);
    assert.deepEqual(second.requirementsAndCauses.map((m: Message) => m.id), [run.messages[0].id, 'addressed', 'update']);
    run.revision = 1; turn.causeIds = [];
    assert.deepEqual(context(buildPrompt(run, turn, member)).recentMessages.map((m: Message) => m.id), ['new']);
    member.sessionId = 'replacement-session';
    assert.deepEqual(context(buildPrompt(run, turn, member)).recentMessages.map((m: Message) => m.id), ['public', 'addressed', 'new']);
    member.sessionId = first.checkpoint.sessionId; member.sessionStarted = false;
    assert.equal(context(buildPrompt(run, turn, member)).recentMessages.length, 3);
  } finally { await engine.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('budget trimming does not consume omitted messages or truncate mandatory causes', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'teamytime-context-budget-'));
  const store = new Store(directory), engine = new Engine(store);
  try {
    const run = engine.create({ prompt: 'Проверить план', mode: 'demo', teamId: 'default-team' }); engine.control(run.id, 'pause');
    for (let i = 0; i < 4; i++) run.messages.push({ id: `long-${i}`, authorId: 'oleg', kind: 'agent', text: 'Я'.repeat(24000),
      recipientIds: [], deliveredTo: [], appliedBy: [], revision: 1, createdAt: 'now' });
    const member = run.participants[0], turn = run.turns[0];
    const prepared = buildContext(run, turn, member);
    assert(Buffer.byteLength(prepared.prompt) <= 90000);
    assert(!prepared.checkpoint.messageIds.includes('long-0'));
    assert(prepared.checkpoint.messageIds.includes('long-3'));
    member.sessionStarted = true; member.contextCheckpoint = prepared.checkpoint;
    assert(context(buildPrompt(run, turn, member)).recentMessages.some((m: Message) => m.id === 'long-2'));
    turn.causeIds = ['long-0', 'long-1'];
    assert.throws(() => buildPrompt(run, turn, member), /Обязательный контекст превысил/);
  } finally { await engine.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('artifact storage refuses symlinked managed directory', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'teamytime-context-link-'));
  const store = new Store(directory), engine = new Engine(store);
  try {
    const run = engine.create({ prompt: 'Проверить план', mode: 'demo', teamId: 'default-team' }); engine.control(run.id, 'pause');
    run.artifacts = [{ id: 'a', title: 'a.md', content: 'test', authorId: 'marina', revision: 1, createdAt: 'now' }];
    symlinkSync(directory, path.join(run.workspace, '.teamytime'));
    await assert.rejects(prepareArtifacts(run), /обычным каталогом/);
  } finally { await engine.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
