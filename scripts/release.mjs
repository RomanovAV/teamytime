import { mkdir, mkdtemp, cp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildApp } from './build.mjs';

await buildApp();
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const temporary = await mkdtemp(path.join(tmpdir(), 'teamytime-release-'));
try {
  const directory = path.join(temporary, 'teamytime');
  await mkdir(path.join(directory, 'scripts'), { recursive: true });
  await cp('dist', path.join(directory, 'dist'), { recursive: true });
  await Promise.all(['start.mjs', 'LICENSE', 'README.md'].map(file => copyFile(file, path.join(directory, file))));
  await Promise.all(['runtime.mjs', 'start-teamytime.command'].map(file => copyFile(`scripts/${file}`, path.join(directory, 'scripts', file))));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module', engines: pkg.engines, scripts: { start: 'node start.mjs' } }, null, 2) + '\n');
  await mkdir('release', { recursive: true });
  const archive = path.resolve(`release/teamytime-${pkg.version}-node22.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', temporary, 'teamytime'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
  console.log(`Готовый архив без node_modules: ${archive}`);
} finally { await rm(temporary, { recursive: true, force: true }); }
