import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentReply, Configuration, Participant, Run, Turn, Usage } from '../../shared/types';
import { StreamDecoder } from './protocol';
import { buildPrompt, protocol } from './context';

export interface AgentContext {
  run: Run; turn: Turn; participant: Participant; cli: Configuration['cli']; signal: AbortSignal;
  draft: (text: string) => void; activity: (text: string) => void; init: (model?: string) => void;
}
export interface AgentResult { reply: AgentReply; usage?: Usage; cumulativeUsage?: Usage; initModel?: string; actualModel?: string }
export type Adapter = (context: AgentContext) => Promise<AgentResult>;
export function executable(command: string): string | undefined {
  const choices = command.includes('/') ? [path.resolve(command)] : (process.env.PATH ?? '').split(path.delimiter).map(p => path.join(p, command));
  return choices.find(p => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } });
}
export function cliArgs(c: AgentContext): string[] {
  const p = c.participant;
  return [
    ...(p.model === 'default' ? [] : ['--model', p.model]),
    '--chat-recording', p.sessionStarted ? '--resume' : '--session-id', p.sessionId,
    '--append-system-prompt', `${p.role.instructions}\n${p.notes}\n${protocol}`,
    `--approval-mode=${p.role.access === 'execute' ? 'auto-edit' : 'plan'}`,
    ...(p.role.access === 'execute' ? ['--allowed-tools', 'run_shell_command'] : []),
    '--exclude-tools', 'agent', 'save_memory', 'exit_plan_mode', 'ask_user_question',
    '--max-session-turns', '12', '--output-format', 'stream-json', '--include-partial-messages',
    '-p', buildPrompt(c.run, c.turn, p),
  ];
}
export const gigacodeAdapter: Adapter = async c => {
  const command = executable(c.cli.command);
  if (!command) throw new Error('GigaCode не найден. Укажите путь к исполняемому файлу в настройках команды.');
  const args = cliArgs(c);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: c.run.workspace, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const decoder = new StreamDecoder(c.participant.sessionId, c.draft, c.init, c.activity);
    let failure: Error | undefined, killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Process already exited. */ }
    };
    const stop = (error: Error) => { if (failure) return; failure = error; kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 1500); killTimer.unref(); };
    const abort = () => stop(new Error('Ход остановлен. Возможные изменения файлов сохранены в рабочем каталоге.'));
    const timeout = setTimeout(() => stop(new Error(`GigaCode не завершил ход за ${c.cli.timeoutSeconds} секунд.`)), c.cli.timeoutSeconds * 1000);
    c.signal.addEventListener('abort', abort, { once: true }); if (c.signal.aborted) abort();
    child.stdout.on('data', chunk => { try { decoder.feed(chunk); } catch (e) { stop(e as Error); } });
    child.stderr.on('data', chunk => {
      // Authentication URLs and stderr contents are deliberately not persisted.
      if (/auth|login|авториз|вход|device/i.test(chunk.toString())) c.activity('Ожидает авторизации GigaCode. Выполните вход в терминале.');
    });
    child.on('error', () => { failure = new Error('Не удалось запустить процесс GigaCode. Проверьте путь и права файла.'); });
    child.on('close', code => {
      clearTimeout(timeout); c.signal.removeEventListener('abort', abort);
      // Keep the group kill armed after cancellation: descendants may outlive the CLI.
      if (!failure && killTimer) clearTimeout(killTimer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`GigaCode завершился с кодом ${code ?? 'signal'}. Проверьте вход и совместимость CLI 26.8.41.`));
      try { resolve(decoder.end(c.participant.cumulativeUsage)); } catch (e) { reject(e); }
    });
  });
};

export const demoAdapter: Adapter = async c => {
  const { run: r, participant: p } = c;
  const lead = r.team.leadId;
  const others = r.participants.filter(x => x.id !== lead);
  const reviewer = others.find(x => x.role.kind === 'reviewer');
  const executor = others.find(x => x.role.access === 'execute') ?? others.find(x => x.id !== reviewer?.id) ?? others[0];
  const evidence = r.messages.filter(m => m.kind === 'agent' && m.authorId !== lead && m.revision === r.revision && !m.stale);
  const artifacts = r.artifacts.filter(a => a.revision === r.revision);
  let reply: AgentReply;
  if (p.id === lead) {
    const review = evidence.find(m => m.authorId === (reviewer?.id ?? executor.id) && m.text.includes('Демонстрационная проверка'));
    if (artifacts.length && review) {
      reply = { message: 'Команда прошла демонстрационный цикл: поручения, результат и проверка. Реальная задача в этом режиме не выполнялась.', actions: [
        ...r.decisions.filter(d => d.revision === r.revision && d.status === 'proposed').slice(0, 3).map(d => ({ type: 'accept_decision' as const, decisionId: d.id })),
        { type: 'finish', summary: 'Демонстрация завершена. Сохранены диалог, решение и пример результата. Для выполнения вашей задачи создайте запуск в режиме GigaCode.', evidenceIds: [review.id] },
      ] };
    } else if (!r.turns.some(t => t.agentId === lead && t.revision === r.revision && t.status === 'succeeded')) {
      reply = { message: 'Разберём задачу командой. В деморежиме покажу, как участники получают поручения, обмениваются замечаниями и фиксируют результат.', actions: [
        { type: 'propose_decision', title: 'Проверить совместную работу команды', rationale: 'Это демонстрационный запуск. Ответы заранее определены; модели и инструменты не вызываются.' },
        ...others.filter(x => x.id !== reviewer?.id || x.id === executor.id).slice(0, 6).map(x => ({ type: 'send' as const, to: x.id, text: x.id === executor.id ? 'Подготовь демонстрационный результат с учётом текущих требований.' : 'Отметь ограничения задачи и передай замечания исполнителю.' })),
      ] };
    } else reply = { message: 'Получил сообщение. Ожидаю результат и проверку коллег текущей версии требований.', actions: [] };
  } else if (p.id === executor.id && !artifacts.length) {
    reply = { message: 'Подготовлен пример результата. Передаю его на проверку; содержимое отмечено как демонстрационное.', actions: [
      { type: 'artifact', title: 'Демонстрационный результат.md', content: `# Демонстрационный результат\n\nЭто пример артефакта Teamytime, а не выполненная задача.\n\n## Задача\n${r.prompt}\n\n## Уточнения\n${r.messages.filter(m => m.kind === 'user').map(m => m.text).join('\n\n')}\n\nВерсия требований: ${r.revision}.\n\nВ реальном запуске здесь будет результат работы агента.` },
      { type: 'send', to: reviewer && reviewer.id !== p.id ? reviewer.id : lead, text: reviewer && reviewer.id !== p.id ? 'Проверь демонстрационный результат текущей версии.' : 'Демонстрационная проверка: пример результата сохранён, реальная задача не выполнялась.' },
    ] };
  } else if (p.id === reviewer?.id || p.id === executor.id) {
    reply = { message: 'Демонстрационная проверка: результат сохранён и явно помечен как пример. Фактическое решение задачи требует режима GigaCode.', actions: [{ type: 'send', to: lead, text: 'Демонстрационная проверка: пример результата готов, ограничение деморежима указано.' }] };
  } else reply = { message: 'Для реального решения нужны проверяемые критерии готовности. Передаю это замечание исполнителю.', actions: [{ type: 'send', to: executor.id, text: 'В результате укажи критерии проверки и ограничения деморежима.' }] };
  c.init('Демонстрация');
  let draft = '';
  for (const word of reply.message.split(' ')) { await delay(35, undefined, { signal: c.signal }); draft += `${word} `; c.draft(draft.trim()); }
  return { reply, actualModel: 'Демонстрация' };
};
