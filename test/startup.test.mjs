import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ensureDependencies, withPreparationLock } from '../scripts/prepare.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'teamytime-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { dependencies: { esbuild: '0.28.0' }, devDependencies: { typescript: '5.9.3' } };
  await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  const calls = [];
  const install = async () => {
    const directory = path.join(root, 'node_modules/esbuild'); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '0.28.0', main: 'index.js' }));
    await writeFile(path.join(directory, 'index.js'), '');
  };
  const npm = async (cwd, args) => {
    assert.equal(cwd, root); calls.push(args);
    if (args[0] === 'config') return 'https://packages.corp.example/npm/';
    assert.deepEqual(args, ['ci', '--omit=dev', '--include=prod', '--include=optional', '--no-audit', '--no-fund']);
    await install(); return '';
  };
  const marker = path.join(root, 'node_modules/.teamytime-install.json');
  return { root, npm, calls, marker, install };
}

test('first start installs; unchanged dependencies and source-only edits never call npm again', async t => {
  const f = await fixture(t);
  assert.equal(await ensureDependencies(f.root, f.npm), true);
  assert.equal(f.calls.length, 2);
  assert.equal(await ensureDependencies(f.root, f.npm), false);
  await writeFile(path.join(f.root, 'main.ts'), 'const changed: boolean = true;');
  assert.equal(await ensureDependencies(f.root, f.npm), false);
  assert.equal(f.calls.length, 2);
  await assert.rejects(access(path.join(f.root, 'node_modules/typescript')));
});

test('lockfile, manifest and project npmrc changes cause installation; deleted dependencies are repaired', async t => {
  const f = await fixture(t);
  await ensureDependencies(f.root, f.npm);
  for (const file of ['package-lock.json', 'package.json']) {
    const full = path.join(f.root, file); const contents = JSON.parse(await readFile(full, 'utf8'));
    contents.changed = true; await writeFile(full, JSON.stringify(contents));
    assert.equal(await ensureDependencies(f.root, f.npm), true);
  }
  await writeFile(path.join(f.root, '.npmrc'), 'registry=https://packages.corp.example/npm/\n');
  assert.equal(await ensureDependencies(f.root, f.npm), true);
  await rm(path.join(f.root, 'node_modules/esbuild/index.js'));
  assert.equal(await ensureDependencies(f.root, f.npm), true);
  await rm(path.join(f.root, 'node_modules'), { recursive: true });
  assert.equal(await ensureDependencies(f.root, f.npm), true);
});

test('failed or incomplete installation never writes a successful marker and is retried', async t => {
  const f = await fixture(t);
  const failed = async (_root, args) => {
    if (args[0] === 'config') return 'https://packages.corp.example/npm/';
    throw new Error('registry unavailable');
  };
  await assert.rejects(ensureDependencies(f.root, failed), /registry unavailable/);
  await assert.rejects(access(f.marker));
  await assert.rejects(ensureDependencies(f.root, async () => 'https://packages.corp.example/npm/'), /отсутствуют необходимые/);
  await assert.rejects(access(f.marker));
  assert.equal(await ensureDependencies(f.root, f.npm), true);
});

test('public npm registry is rejected before installing or printing registry credentials', async t => {
  const f = await fixture(t);
  for (const registry of ['https://registry.npmjs.org/', 'https://USER:SECRET@registry.npmjs.org/', 'file:///tmp/packages']) {
    let calls = 0;
    await assert.rejects(ensureDependencies(f.root, async (_root, args) => {
      calls++; assert.deepEqual(args, ['config', 'get', 'registry']); return registry;
    }), error => /корпоративный npm-реестр/.test(error.message) && !error.message.includes('SECRET'));
    assert.equal(calls, 1); await assert.rejects(access(f.marker));
  }
});

test('files changed during installation are detected and require a fresh installation', async t => {
  const f = await fixture(t);
  await assert.rejects(ensureDependencies(f.root, async (root, args, options) => {
    const result = await f.npm(root, args, options);
    if (args[0] === 'ci') await writeFile(path.join(root, 'package-lock.json'), '{"newLock":true}');
    return result;
  }), /изменились во время установки/);
  await assert.rejects(access(f.marker));
  assert.equal(await ensureDependencies(f.root, f.npm), true);
});

test('preparation lock prevents concurrent installation and is released after failure', async t => {
  const f = await fixture(t);
  await assert.rejects(withPreparationLock(f.root, async () => {
    await assert.rejects(withPreparationLock(f.root, async () => assert.fail('must not run')), /уже запущена/);
    throw new Error('build failed');
  }), /build failed/);
  let prepared = false;
  await withPreparationLock(f.root, async () => { prepared = true; });
  assert(prepared); await assert.rejects(access(path.join(f.root, '.teamytime-prepare.lock')));
});

test('launcher installs before building, skips repeat installation, and never starts stale output after failure', async t => {
  // No application build or network: isolated npm/build/server stand-ins exercise the launcher.
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'scripts')); await mkdir(path.join(f.root, 'dist'));
  for (const name of ['start.mjs', 'scripts/runtime.mjs', 'scripts/prepare.mjs']) await copyFile(new URL(`../${name}`, import.meta.url), path.join(f.root, name));
  const cli = path.join(f.root, 'npm-cli.js');
  await writeFile(cli, `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'config') console.log('https://packages.corp.example/npm/');
else if (process.env.TEST_INSTALL_FAIL) process.exitCode = 7;
else {
  fs.mkdirSync('node_modules/esbuild', { recursive: true });
  fs.writeFileSync('node_modules/esbuild/package.json', JSON.stringify({version:'0.28.0',main:'index.js'}));
  fs.writeFileSync('node_modules/esbuild/index.js', '');
  console.log('INSTALL_STUB');
}
`);
  await writeFile(path.join(f.root, 'scripts/build.mjs'), `export async function buildApp() {
    if (process.env.TEST_BUILD_FAIL) throw new Error('BUILD_STUB_FAILURE');
    console.log('BUILD_STUB');
  }`);
  await writeFile(path.join(f.root, 'dist/server.mjs'), `export async function start() { console.log('SERVER_STUB'); }`);
  const launch = extra => promisify(execFile)(process.execPath, ['start.mjs'], { cwd: f.root, env: { ...process.env, npm_execpath: cli, TEST_INSTALL_FAIL: '', TEST_BUILD_FAIL: '', ...extra } });
  const first = await launch(); assert.match(first.stdout, /INSTALL_STUB[\s\S]*BUILD_STUB[\s\S]*SERVER_STUB/);
  const second = await launch(); assert(!second.stdout.includes('INSTALL_STUB')); assert.match(second.stdout, /BUILD_STUB[\s\S]*SERVER_STUB/);
  await assert.rejects(launch({ TEST_BUILD_FAIL: '1' }), error => error.stderr.includes('BUILD_STUB_FAILURE') && !error.stdout.includes('SERVER_STUB'));
  await writeFile(path.join(f.root, 'package-lock.json'), '{"updated":true}');
  await assert.rejects(launch({ TEST_INSTALL_FAIL: '1' }), error => /кодом 7/.test(error.stderr) && !/BUILD_STUB|SERVER_STUB/.test(error.stdout));
  await assert.rejects(access(f.marker));
  const retried = await launch(); assert.match(retried.stdout, /INSTALL_STUB[\s\S]*BUILD_STUB[\s\S]*SERVER_STUB/);
});
