import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Artifact, Run } from '../../shared/types';

export function artifactPath(run: Run, artifact: Artifact): string {
  const hash = createHash('sha256').update(artifact.content).digest('hex');
  return path.join(run.workspace, '.teamytime', 'artifacts', `${hash}.md`);
}

/** CLI read_file can access these within its workspace. Names never come from model text. */
const preparing = new Map<string, Promise<void>>();
export async function prepareArtifacts(run: Run): Promise<void> {
  const previous = preparing.get(run.workspace) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => writeArtifacts(run));
  preparing.set(run.workspace, pending);
  try { await pending; }
  finally { if (preparing.get(run.workspace) === pending) preparing.delete(run.workspace); }
}

async function writeArtifacts(run: Run): Promise<void> {
  if (!run.artifacts.length) return;
  let directory = run.workspace;
  for (const name of ['.teamytime', 'artifacts']) {
    directory = path.join(directory, name);
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Каталог артефактов должен быть обычным каталогом внутри рабочего проекта.');
  }
  for (const artifact of run.artifacts) {
    const file = artifactPath(run, artifact);
    try { await writeFile(file, artifact.content, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || await readFile(file, 'utf8') !== artifact.content) {
        throw new Error('Сохранённый файл артефакта изменён. Сверьте его с результатом в Teamytime.');
      }
    }
  }
}
