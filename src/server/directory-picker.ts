import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { UserError } from './validation';

const execute = promisify(execFile);
const script = `
try
  tell application "Finder"
    activate
    set selectedFolder to choose folder with prompt "Выберите рабочий каталог Teamytime"
    return POSIX path of selectedFolder
  end tell
on error number -128
  return ""
end try`;

export async function chooseDirectory(): Promise<string | null> {
  if (process.platform !== 'darwin') throw new UserError('Выбор через Finder доступен на macOS. Введите путь вручную.');
  let output: string;
  try {
    const result = await execute('/usr/bin/osascript', ['-e', script], { timeout: 120000, maxBuffer: 65536 });
    output = result.stdout.replace(/\r?\n$/, '');
  } catch { throw new UserError('Не удалось выбрать каталог. Проверьте разрешение на управление Finder или введите путь вручную.'); }
  if (!output) return null;
  try {
    const directory = await realpath(output);
    if (!(await stat(directory)).isDirectory()) throw new Error();
    return directory;
  } catch { throw new UserError('Выбранный каталог недоступен. Выберите другую папку.'); }
}
