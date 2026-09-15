import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadBuildTool } from './runtime.mjs';

const { build } = await loadBuildTool();
const directory = await mkdtemp(path.join(tmpdir(), 'teamytime-tests-'));
try {
  const files = (await readdir('test')).filter(file => file.endsWith('.test.ts'));
  const plainTests = (await readdir('test')).filter(file => file.endsWith('.test.mjs')).map(file => path.resolve('test', file));
  await build({ entryPoints: files.map(file => `test/${file}`), bundle: true, outdir: directory,
    outExtension: { '.js': '.mjs' }, platform: 'node', format: 'esm', target: 'node22.16' });
  const child = spawn(process.execPath, ['--test', ...files.map(file => path.join(directory, file.replace(/\.ts$/, '.mjs'))), ...plainTests], { stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
} finally { await rm(directory, { recursive: true, force: true }); }
