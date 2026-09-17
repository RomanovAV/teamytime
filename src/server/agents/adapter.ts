import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentReply, Configuration, Participant, Run, Turn, Usage } from '../../shared/types';
import { ReplyError, StreamDecoder } from './protocol';
import { buildPrompt, protocol } from './context';
import type { TurnLogger } from '../diagnostics';
import { CliErrors } from './cli-errors';
import { prepareArtifacts } from './artifacts';

export interface AgentContext {
  run: Run; turn: Turn; participant: Participant; cli: Configuration['cli']; signal: AbortSignal;
  draft: (text: string) => void; activity: (text: string) => void; init: (model?: string) => void;
  logger?: TurnLogger;
  promptOverride?: string;
  protocolRepair?: boolean;
}
export interface AgentResult { reply: AgentReply; warnings?: string[]; usage?: Usage; cumulativeUsage?: Usage; initModel?: string; actualModel?: string }
export type Adapter = (context: AgentContext) => Promise<AgentResult>;
export function executable(command: string): string | undefined {
  const choices = command.includes('/') ? [path.resolve(command)] : (process.env.PATH ?? '').split(path.delimiter).map(p => path.join(p, command));
  return choices.find(p => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } });
}
export function cliArgs(c: AgentContext): string[] {
  const p = c.participant;
  const execute = p.role.access === 'execute' && !c.turn.readOnly && !c.protocolRepair;
  const excluded = ['agent', 'save_memory', 'exit_plan_mode', 'ask_user_question',
    ...(!execute ? ['edit', 'write_file'] : []),
    ...(c.protocolRepair ? ['run_shell_command', 'read_file', 'send_message', 'todo_write'] : [])];
  return [
    ...(p.model === 'default' ? [] : ['--model', p.model]),
    '--chat-recording', p.sessionStarted ? '--resume' : '--session-id', p.sessionId,
    '--append-system-prompt', `${p.role.instructions}\n${p.notes}\n${protocol}`,
    `--approval-mode=${execute ? 'auto-edit' : 'plan'}`,
    ...(execute ? ['--allowed-tools', 'run_shell_command'] : []),
    '--exclude-tools', ...excluded,
    '--output-format', 'stream-json', '--include-partial-messages',
    '-p', c.promptOverride ?? buildPrompt(c.run, c.turn, p),
  ];
}
class ModelUnavailableError extends Error {}
const protocolRepairAttempts = 2;

function addUsage(a?: Usage, b?: Usage): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return { input: a.input + b.input, output: a.output + b.output, cachedInput: a.cachedInput + b.cachedInput, total: a.total + b.total };
}

function repairPrompt(error: ReplyError, attempt: number): string {
  return `Предыдущий ответ отклонён Teamytime из-за формата:\n${error.message}\n\nИсправь предыдущий ответ и верни его целиком ещё раз. Сохрани содержание, адресатов, ID и все необходимые действия. Не повторяй исследование, команды, проверки и изменения файлов; инструменты в этом повторе отключены. Не объясняй ошибку и не добавляй служебный комментарий. Исправь только формат согласно системному протоколу. Это автоматическая попытка ${attempt} из ${protocolRepairAttempts}.`;
}

export const gigacodeAdapter: Adapter = async c => {
  await prepareArtifacts(c.run);
  const deadline = Date.now() + c.cli.timeoutSeconds * 1000;
  let context = c, totalUsage: Usage | undefined, repairCount = 0;
  const carriedWarnings: string[] = [];
  while (true) {
    try {
      const result = await runWithModelFallback(context, deadline);
      totalUsage = addUsage(totalUsage, result.usage);
      const repaired = repairCount ? [`Ответ вне протокола автоматически исправлен с попытки ${repairCount + 1}; инструменты при исправлении были отключены.`] : [];
      const warnings = [...new Set([...carriedWarnings, ...repaired, ...(result.warnings ?? [])])];
      return { ...result, usage: totalUsage, warnings: warnings.length ? warnings : undefined };
    } catch (error) {
      if (!(error instanceof ReplyError)) throw error;
      totalUsage = addUsage(totalUsage, error.usage);
      carriedWarnings.push(...(error.warnings ?? []));
      if (repairCount >= protocolRepairAttempts || c.signal.aborted) {
        error.usage = totalUsage;
        error.warnings = [...new Set([...carriedWarnings, `Автоматические попытки исправления протокола (${protocolRepairAttempts}) исчерпаны.`])];
        throw error;
      }
      repairCount++;
      c.activity(`Исправляет формат ответа (${repairCount}/${protocolRepairAttempts})`);
      c.logger?.event({ type: 'protocol-retry', attempt: repairCount, maxAttempts: protocolRepairAttempts, error: error.message });
      context = {
        ...c,
        protocolRepair: true,
        promptOverride: repairPrompt(error, repairCount),
        participant: {
          ...c.participant,
          sessionStarted: true,
          cumulativeUsage: error.cumulativeUsage ?? context.participant.cumulativeUsage,
          model: error.modelFallback ? 'default' : context.participant.model,
        },
      };
    }
  }
};

async function runWithModelFallback(c: AgentContext, deadline: number): Promise<AgentResult> {
  try { return await runGigacode(c, deadline); }
  catch (error) {
    if (!(error instanceof ModelUnavailableError) || c.participant.model === 'default' || c.signal.aborted) throw error;
    const warning = `Указанная модель «${c.participant.model}» отсутствует в каталоге GigaCode. Использована модель по умолчанию CLI.`;
    c.activity('Указанная модель недоступна. Повторяю с моделью по умолчанию CLI.');
    c.logger?.event({ type: 'model-fallback', requestedModel: c.participant.model, fallbackModel: 'default' });
    try {
      const result = await runGigacode({ ...c, participant: { ...c.participant, model: 'default' } }, deadline);
      return { ...result, warnings: [warning, ...(result.warnings ?? [])] };
    } catch (fallbackError) {
      if (fallbackError instanceof ReplyError) {
        fallbackError.modelFallback = true;
        fallbackError.warnings = [warning, ...(fallbackError.warnings ?? [])];
      }
      throw fallbackError;
    }
  }
}

async function runGigacode(c: AgentContext, deadline: number): Promise<AgentResult> {
  if (c.signal.aborted) throw new Error('Ход остановлен.');
  if (Date.now() >= deadline) throw new Error(`GigaCode не завершил ход за ${c.cli.timeoutSeconds} секунд.`);
  const command = executable(c.cli.command);
  if (!command) throw new Error('GigaCode не найден. Укажите путь к исполняемому файлу в настройках команды.');
  const args = cliArgs(c);
  c.logger?.event({ type: 'process-start', command, args, cwd: c.run.workspace });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: c.run.workspace, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const decoder = new StreamDecoder(c.participant.sessionId, c.draft, c.init, c.activity);
    const errors = new CliErrors();
    let failure: Error | undefined, killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Process already exited. */ }
    };
    const stop = (error: Error) => { if (failure) return; failure = error; c.logger?.event({ type: 'process-stop', reason: error.message }); kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 1500); killTimer.unref(); };
    const abort = () => stop(new Error('Ход остановлен. Возможные изменения файлов сохранены в рабочем каталоге.'));
    const timeout = setTimeout(() => stop(new Error(`GigaCode не завершил ход за ${c.cli.timeoutSeconds} секунд. При необходимости увеличьте таймаут в настройках CLI и повторите ход.`)), Math.max(1, deadline - Date.now()));
    c.signal.addEventListener('abort', abort, { once: true }); if (c.signal.aborted) abort();
    child.stdout.on('data', chunk => { c.logger?.feed('stdout', chunk); try { decoder.feed(chunk); } catch (e) { stop(e as Error); } });
    child.stderr.on('data', chunk => {
      c.logger?.feed('stderr', chunk);
      errors.feed(chunk, c.activity);
    });
    child.on('spawn', () => c.logger?.event({ type: 'process-spawned', pid: child.pid }));
    child.on('error', error => { c.logger?.event({ type: 'process-error', message: error.message }); failure = new Error('Не удалось запустить процесс GigaCode. Проверьте путь и права файла.'); });
    child.on('close', (code, signal) => {
      errors.end(c.activity);
      c.logger?.end(); c.logger?.event({ type: 'process-exit', code, signal });
      clearTimeout(timeout); c.signal.removeEventListener('abort', abort);
      // Keep the group kill armed after cancellation: descendants may outlive the CLI.
      if (!failure && killTimer) clearTimeout(killTimer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(errors.isModelUnavailable && !decoder.initialized
        ? new ModelUnavailableError(errors.message(code)) : new Error(errors.message(code)));
      try { resolve(decoder.end(c.participant.cumulativeUsage)); } catch (e) { reject(e); }
    });
  });
}

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
        { type: 'publish_artifact', artifactId: artifacts[0].id },
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
