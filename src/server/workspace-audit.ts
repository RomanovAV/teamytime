import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Turn } from '../shared/types';

const exec = promisify(execFile);
interface Snapshot { files: Map<string, string>; incomplete: boolean; note?: string }

/** Compare contents, including files already dirty/untracked before the turn. No Git mutations. */
export async function snapshotWorkspace(workspace: string): Promise<Snapshot> {
  const snapshot: Snapshot = { files: new Map(), incomplete: false };
  try {
    const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: workspace, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const names = [...new Set(stdout.split('\0').filter(Boolean))];
    let bytes = 0;
    const deadline = Date.now() + 10000;
    for (const name of names) {
      if (name === '.teamytime' || name.startsWith('.teamytime/')) continue;
      if (snapshot.files.size >= 20000 || bytes >= 128 * 1024 * 1024 || Date.now() > deadline) { snapshot.incomplete = true; break; }
      if (path.isAbsolute(name) || name.split('/').includes('..')) { snapshot.incomplete = true; continue; }
      const file = path.join(workspace, name);
      try {
        // Do not follow symlinked parent directories into other workspaces.
        let parent = workspace, unsafe = false;
        for (const part of name.split('/').slice(0, -1)) {
          parent = path.join(parent, part);
          if ((await lstat(parent)).isSymbolicLink()) { unsafe = true; break; }
        }
        if (unsafe) { snapshot.incomplete = true; continue; }
        const stat = await lstat(file);
        if (stat.isSymbolicLink()) { snapshot.files.set(name, `link:${await readlink(file)}`); continue; }
        if (!stat.isFile() || stat.size > 16 * 1024 * 1024) { snapshot.incomplete = true; continue; }
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const hash = createHash('sha256'); const buffer = Buffer.alloc(65536); let count = 0;
          while (true) {
            const { bytesRead } = await handle.read(buffer);
            if (!bytesRead) break;
            count += bytesRead; bytes += bytesRead;
            if (count > 16 * 1024 * 1024 || bytes > 128 * 1024 * 1024 || Date.now() > deadline) throw new Error('audit limit');
            hash.update(buffer.subarray(0, bytesRead));
          }
          snapshot.files.set(name, `${stat.mode & 0o777}:${hash.digest('hex')}`);
        } finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') snapshot.files.set(name, 'missing');
        else snapshot.incomplete = true;
      }
    }
    snapshot.note = 'Проверены отслеживаемые и неигнорируемые файлы Git; .teamytime исключён. Изменения за время хода могут принадлежать другим процессам.';
  } catch {
    snapshot.incomplete = true;
    snapshot.note = 'Сравнение файлов недоступно: требуется доступный Git-репозиторий. Отсутствие изменений не подтверждено.';
  }
  return snapshot;
}

export function compareWorkspace(before: Snapshot, after: Snapshot): NonNullable<Turn['workspaceChanges']> {
  const files: NonNullable<Turn['workspaceChanges']>['files'] = [];
  for (const name of new Set([...before.files.keys(), ...after.files.keys()])) {
    const previous = before.files.get(name), current = after.files.get(name);
    if (previous === current) continue;
    // Missing entries in a partial scan must not be reported as actual additions/deletions.
    if ((!previous && before.incomplete) || (!current && after.incomplete)) continue;
    const change = !current || current === 'missing' ? 'deleted' : !previous || previous === 'missing' ? 'added' : 'modified';
    files.push({ path: name, change });
  }
  return { files, incomplete: before.incomplete || after.incomplete, note: after.note };
}
