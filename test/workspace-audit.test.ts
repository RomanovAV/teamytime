import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { snapshotWorkspace, compareWorkspace } from '../src/server/workspace-audit';
import { Store } from '../src/server/store';
import { Engine } from '../src/server/engine';
import { cliArgs } from '../src/server/agents/adapter';

function repository() {
  const dir = mkdtempSync(path.join(tmpdir(), 'teamytime-audit-'));
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(path.join(dir, '.gitignore'), '.teamytime/\nignored/\n');
  writeFileSync(path.join(dir, 'tracked.txt'), 'base');
  execFileSync('git', ['add', '.'], { cwd: dir });
  return dir;
}

test('audit detects edits to already-dirty and untracked files, additions and deletions', async () => {
  const dir = repository();
  try {
    writeFileSync(path.join(dir, 'tracked.txt'), 'dirty before');
    writeFileSync(path.join(dir, 'untracked.txt'), 'before');
    writeFileSync(path.join(dir, 'remove.txt'), 'before');
    const before = await snapshotWorkspace(dir);
    writeFileSync(path.join(dir, 'tracked.txt'), 'dirty after');
    writeFileSync(path.join(dir, 'untracked.txt'), 'after');
    writeFileSync(path.join(dir, 'new.txt'), 'new');
    unlinkSync(path.join(dir, 'remove.txt'));
    mkdirSync(path.join(dir, '.teamytime')); writeFileSync(path.join(dir, '.teamytime', 'internal'), 'service');
    const changes = compareWorkspace(before, await snapshotWorkspace(dir));
    assert.equal(changes.incomplete, false);
    assert.deepEqual(changes.files.sort((a, b) => a.path.localeCompare(b.path)), [
      { path: 'new.txt', change: 'added' }, { path: 'remove.txt', change: 'deleted' },
      { path: 'tracked.txt', change: 'modified' }, { path: 'untracked.txt', change: 'modified' },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audit does not follow symlinks or claim a non-Git directory is unchanged', async () => {
  const dir = repository(), outside = mkdtempSync(path.join(tmpdir(), 'teamytime-audit-outside-'));
  try {
    writeFileSync(path.join(outside, 'private'), 'before');
    symlinkSync(outside, path.join(dir, 'linked'));
    const before = await snapshotWorkspace(dir);
    writeFileSync(path.join(outside, 'private'), 'after');
    assert.deepEqual(compareWorkspace(before, await snapshotWorkspace(dir)).files, []);
    assert.equal((await snapshotWorkspace(outside)).incomplete, true);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('discussion role may run verification shell but detected source edits pause before applying actions', async () => {
  const dir = repository(), data = mkdtempSync(path.join(tmpdir(), 'teamytime-audit-data-'));
  const store = new Store(data);
  const adapter = async (c: Parameters<typeof cliArgs>[0]) => {
    const args = cliArgs(c);
    assert(args.includes('--approval-mode=plan')); assert(args.includes('--allowed-tools'));
    assert(args.includes('edit')); assert(args.includes('write_file'));
    writeFileSync(path.join(dir, 'tracked.txt'), 'unexpected write');
    return { reply: { message: 'No changes', actions: [{ type: 'artifact' as const, title: 'bad.md', content: 'Must not apply' }] } };
  };
  const engine = new Engine(store, { demo: adapter, gigacode: adapter });
  try {
    const config = store.config(); config.cli.command = process.execPath; store.saveConfig(config);
    const run = engine.create({ prompt: 'Проверить без изменений', mode: 'gigacode', teamId: 'default-team', workspace: dir });
    const start = Date.now();
    while (store.get(run.id).status !== 'paused') { if (Date.now() - start > 6000) throw new Error('Timed out'); await delay(10); }
    const result = store.get(run.id);
    assert.equal(result.artifacts.length, 0);
    assert.match(result.turns[0].error!, /изменил файлы/);
    assert.deepEqual(result.turns[0].workspaceChanges!.files, [{ path: 'tracked.txt', change: 'modified' }]);
    assert(store.diagnostics(run.id)[0].entries.some(e => e.data.type === 'workspace-audit'));
  } finally { await engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); }
});
