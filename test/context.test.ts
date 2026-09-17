import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store';
import { Engine } from '../src/server/engine';
import { buildPrompt } from '../src/server/agents/context';
import { artifactPath, prepareArtifacts } from '../src/server/agents/artifacts';

const context = (prompt: string) => JSON.parse(prompt.slice(prompt.indexOf('\n\n{') + 2));

test('reviewer receives full plan or an explicit reference to its complete immutable file', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'teamytime-context-'));
  const store = new Store(directory), engine = new Engine(store);
  try {
    const run = engine.create({ prompt: 'Проверить план', mode: 'demo', teamId: 'default-team' }); engine.control(run.id, 'pause');
    const artifact = { id: 'plan', title: '../../plan.md', content: 'П'.repeat(9677) + '\nLAST_SECTION', authorId: 'marina', revision: 1, createdAt: 'now' };
    run.artifacts = [artifact];
    const small = context(buildPrompt(run, run.turns[0], run.participants[0]));
    assert.equal(small.artifacts[0].content, artifact.content); assert.equal(small.artifacts[0].truncated, false);
    run.artifacts.push(...Array.from({ length: 4 }, (_, i) => ({ ...artifact, id: `large-${i}`, content: `${i}` + 'Я'.repeat(49000) + 'END' })));
    await Promise.all([prepareArtifacts(run), prepareArtifacts(run), prepareArtifacts(run)]);
    const prompt = buildPrompt(run, run.turns[0], run.participants[0]);
    assert(Buffer.byteLength(prompt) <= 90000);
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
