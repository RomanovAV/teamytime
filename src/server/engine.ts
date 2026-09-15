import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Action, AgentReply, Message, Run, Turn } from '../shared/types';
import { Store } from './store';
import { UserError, createRunSchema, messageSchema, replySchema } from './validation';
import { demoAdapter, executable, gigacodeAdapter, type Adapter, type AgentResult } from './agents/adapter';
import { runtimeInfo, TurnLogger } from './diagnostics';
import { ReplyError } from './agents/protocol';

const now = () => new Date().toISOString();
const uid = () => randomUUID();
function queue(r: Run, agentId: string, causeId: string, reason: string) {
  const pending = r.turns.find(t => t.agentId === agentId && t.status === 'queued');
  if (pending) { if (!pending.causeIds.includes(causeId)) pending.causeIds.push(causeId); return; }
  r.turns.push({ id: uid(), agentId, causeIds: [causeId], status: 'queued', reason, createdAt: now(), draft: '' });
}
function message(r: Run, fields: Pick<Message, 'authorId' | 'kind' | 'text' | 'recipientIds'> & Partial<Message>): Message {
  const m: Message = { id: uid(), deliveredTo: [], appliedBy: [], revision: r.revision, createdAt: now(), ...fields };
  r.messages.push(m); return m;
}

export class Engine {
  private active = new Map<string, { runId: string; agentId: string; workspace: string; write: boolean; abort: AbortController; done: Promise<void> }>();
  private scheduled = false;
  private closing = false;
  constructor(readonly store: Store, private adapters: Record<Run['mode'], Adapter> = { demo: demoAdapter, gigacode: gigacodeAdapter }) {}
  create(input: unknown): Run {
    const data = createRunSchema.parse(input), config = this.store.config();
    const team = config.teams.find(t => t.id === data.teamId);
    if (!team) throw new UserError('Команда не найдена.');
    if (data.mode === 'gigacode' && !executable(config.cli.command)) throw new UserError('GigaCode не найден. Укажите путь в настройках или выберите деморежим.');
    const id = uid();
    let workspace: string;
    if (data.workspace) {
      if (!path.isAbsolute(data.workspace)) throw new UserError('Рабочий каталог должен быть абсолютным путём.');
      try { workspace = realpathSync(data.workspace); if (!statSync(workspace).isDirectory()) throw new Error(); }
      catch { throw new UserError('Рабочий каталог не найден.'); }
    } else {
      workspace = path.join(this.store.directory, 'workspaces', id); mkdirSync(workspace, { recursive: true }); workspace = realpathSync(workspace);
    }
    const run: Run = {
      id, title: data.prompt.replace(/\s+/g, ' ').slice(0, 80), prompt: data.prompt, mode: data.mode, status: 'running', note: '', revision: 1,
      createdAt: now(), updatedAt: now(), workspace, team: structuredClone(team),
      participants: team.members.map(m => ({ ...m, role: structuredClone(config.roles.find(role => role.id === m.roleId)!), sessionId: uid(), sessionStarted: false })),
      messages: [], turns: [], topics: [], decisions: [], artifacts: [],
    };
    const m = message(run, { authorId: null, kind: 'user', text: data.prompt, recipientIds: [team.leadId] });
    queue(run, team.leadId, m.id, 'Новая задача'); this.store.create(run); this.kick(); return run;
  }
  send(id: string, input: unknown) {
    const data = messageSchema.parse(input);
    const value = this.store.update(id, 'message', r => {
      if (r.status === 'cancelled') throw new UserError('Остановленная задача закрыта. Создайте новую.');
      const recipients = data.kind === 'update' ? r.participants.map(p => p.id) : [data.recipientId ?? r.team.leadId];
      if (recipients.some(id => !r.participants.some(p => p.id === id))) throw new UserError('Получатель не найден.');
      if (data.kind === 'update') {
        r.revision++; r.completion = undefined; r.finalSummary = undefined;
        r.decisions.filter(d => d.status !== 'rejected').forEach(d => d.status = 'needs_review');
      }
      const m = message(r, { authorId: null, kind: 'user', text: data.text, recipientIds: recipients });
      recipients.forEach(to => queue(r, to, m.id, data.kind === 'update' ? 'Уточнение требований' : 'Сообщение пользователя'));
      r.completion = undefined; r.finalSummary = undefined;
      if (['waiting', 'completed'].includes(r.status)) { r.status = 'running'; r.note = ''; }
    });
    this.kick(); return value;
  }
  control(id: string, action: string) {
    if (!['pause', 'resume', 'cancel'].includes(action)) throw new UserError('Неизвестное действие.');
    const value = this.store.update(id, action, r => {
      r.resumeAfterRecovery = false;
      if (action === 'cancel') {
        r.status = 'cancelled'; r.note = 'Задача остановлена пользователем.';
        r.turns.filter(t => t.status === 'queued').forEach(t => t.status = 'cancelled'); return;
      }
      if (['completed', 'cancelled'].includes(r.status)) throw new UserError('Задача уже завершена.');
      if (action === 'pause') { r.status = this.isActive(id) ? 'pausing' : 'paused'; r.note = 'Пауза по запросу пользователя.'; }
      else {
        if (r.turns.some(t => ['failed', 'interrupted'].includes(t.status))) throw new UserError('Сначала повторите или пропустите незавершённые ходы.');
        if (r.turns.filter(t => t.startedAt).length >= r.team.maxTurns) throw new UserError('Лимит ходов исчерпан. Создайте новую задачу с большим лимитом.');
        r.status = 'running'; r.note = '';
      }
    });
    if (action === 'cancel') for (const a of this.active.values()) if (a.runId === id) a.abort.abort();
    this.kick(); return value;
  }
  resolveTurn(id: string, turnId: string, action: string, resume?: boolean) {
    if (resume !== undefined && typeof resume !== 'boolean') throw new UserError('Параметр продолжения должен быть логическим.');
    if (!['retry', 'skip'].includes(action)) throw new UserError('Неизвестное действие.');
    const value = this.store.update(id, action, r => {
      if (r.status === 'cancelled') throw new UserError('Задача остановлена.');
      const t = r.turns.find(t => t.id === turnId);
      if (!t || !['failed', 'interrupted'].includes(t.status)) throw new UserError('Этот ход не требует восстановления.');
      t.status = 'skipped';
      if (action === 'retry') for (const cause of t.causeIds) queue(r, t.agentId, cause, 'Повтор по запросу пользователя');
      if (resume !== undefined) r.resumeAfterRecovery = resume;
      if (r.resumeAfterRecovery && !r.turns.some(t => ['failed', 'interrupted'].includes(t.status))) {
        r.resumeAfterRecovery = false;
        if (r.turns.filter(t => t.startedAt).length >= r.team.maxTurns) {
          r.note = `Достигнут лимит ${r.team.maxTurns} ходов. Создайте новую задачу с большим лимитом.`;
        } else { r.status = 'running'; r.note = ''; }
      } else r.note = r.resumeAfterRecovery
        ? 'Работа продолжится после повтора или пропуска оставшихся ошибочных ходов.'
        : 'Нажмите «Продолжить», когда проверите оставшиеся ходы.';
    }); this.kick(); return value;
  }
  decide(id: string, decisionId: string, action: string) {
    if (!['accept', 'reject'].includes(action)) throw new UserError('Неизвестное решение.');
    const value = this.store.update(id, 'decision', r => {
      if (r.status === 'cancelled') throw new UserError('Задача остановлена.');
      const d = r.decisions.find(d => d.id === decisionId); if (!d) throw new UserError('Решение не найдено.');
      d.status = action === 'accept' ? 'accepted' : 'rejected'; d.revision = r.revision;
      const m = message(r, { authorId: null, kind: 'user', text: `${action === 'accept' ? 'Принимаю' : 'Отклоняю'} решение «${d.title}».`, recipientIds: [r.team.leadId] });
      queue(r, r.team.leadId, m.id, 'Решение пользователя');
      r.completion = undefined;
      if (['completed', 'waiting'].includes(r.status)) r.status = 'running';
    }); this.kick(); return value;
  }
  private isActive(id: string) { return [...this.active.values()].some(a => a.runId === id); }
  private kick() {
    if (this.closing || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; if (!this.closing) this.pump(); });
  }
  private pump() {
    for (const r of this.store.all()) {
      if (r.status === 'pausing' && !this.isActive(r.id)) { this.store.update(r.id, 'paused', r => { r.status = 'paused'; }); continue; }
      if (r.status !== 'running') continue;
      let started = r.turns.filter(t => t.startedAt).length;
      for (const t of r.turns.filter(t => t.status === 'queued')) {
        const active = [...this.active.values()];
        if (active.length >= 4 || active.filter(a => a.runId === r.id).length >= r.team.parallelism) break;
        if (started >= r.team.maxTurns) {
          this.store.update(r.id, 'budget', r => { r.status = this.isActive(r.id) ? 'pausing' : 'paused'; r.note = `Достигнут лимит ${r.team.maxTurns} ходов.`; }); break;
        }
        const p = r.participants.find(p => p.id === t.agentId)!;
        if (active.some(a => a.runId === r.id && a.agentId === p.id)) continue;
        if (p.role.access === 'execute' && active.some(a => a.write && a.workspace === r.workspace)) continue;
        this.start(r.id, t.id); started++;
      }
      const fresh = this.store.get(r.id);
      if (fresh.status === 'running' && !this.isActive(r.id) && !fresh.turns.some(t => t.status === 'queued')) {
        this.store.update(r.id, 'idle', r => {
          const unresolved = r.decisions.some(d => ['proposed', 'needs_review'].includes(d.status)) || r.topics.some(t => t.status === 'open');
          if (r.completion?.revision === r.revision && !unresolved) { r.status = 'completed'; r.finalSummary = r.completion.summary; r.note = ''; }
          else { r.status = 'waiting'; r.note = unresolved ? 'Остались открытые темы или решения. Напишите ведущему или примите решение.' : 'В очереди нет поручений. Можно написать участнику или уточнить задачу.'; }
        });
      }
    }
  }
  private start(runId: string, turnId: string) {
    const snapshot = this.store.update(runId, 'turn-start', r => {
      const t = r.turns.find(t => t.id === turnId)!; t.status = 'running'; t.startedAt = now(); t.revision = r.revision;
      for (const m of r.messages) if (t.causeIds.includes(m.id) && !m.deliveredTo.includes(t.agentId)) m.deliveredTo.push(t.agentId);
    });
    const turn = snapshot.turns.find(t => t.id === turnId)!, participant = snapshot.participants.find(p => p.id === turn.agentId)!;
    const abort = new AbortController();
    const entry = { runId, agentId: participant.id, workspace: snapshot.workspace, write: participant.role.access === 'execute', abort, done: Promise.resolve() };
    this.active.set(turnId, entry);
    let lastUpdate = 0;
    const update = (reason: string, fn: (r: Run, t: Turn) => void) => this.store.update(runId, reason, r => { const t = r.turns.find(t => t.id === turnId)!; if (t.status === 'running') fn(r, t); });
    let logger: TurnLogger | undefined, replyText: string | undefined;
    entry.done = Promise.resolve().then(() => {
      const cli = this.store.config().cli;
      this.store.beginDiagnostics(runId, turnId, { startedAt: turn.startedAt, runtime: runtimeInfo(), mode: snapshot.mode, agentId: participant.id, sessionId: participant.sessionId, revision: turn.revision, model: participant.model, cli }, snapshot.workspace);
      logger = new TurnLogger((stream, data) => this.store.appendDiagnostic(turnId, stream, data), snapshot.workspace);
      return this.adapters[snapshot.mode]({
        run: snapshot, turn, participant, cli, signal: abort.signal, logger,
        draft: text => { if (Date.now() - lastUpdate > 150) { lastUpdate = Date.now(); update('draft', (_r, t) => { t.draft = text; t.activity = 'Формулирует ответ'; }); } },
        activity: text => update('activity', (_r, t) => { if (t.activity !== text) t.activity = text; }),
        init: model => update('session', r => { const p = r.participants.find(p => p.id === participant.id)!; p.sessionStarted = true; p.initModel = model; }),
      });
    }).then(result => { replyText = result.reply.message; logger?.event({ type: 'adapter-result', ...result }); this.succeed(runId, turnId, result); }).catch(error => {
      this.store.update(runId, 'turn-error', r => {
        const t = r.turns.find(t => t.id === turnId)!;
        if (replyText) t.draft = replyText;
        else if (error instanceof ReplyError && error.publicMessage) t.draft = error.publicMessage;
        t.status = r.status === 'cancelled' ? 'cancelled' : this.closing ? 'interrupted' : 'failed';
        t.error = error instanceof Error ? error.message : 'Неизвестная ошибка агента.'; t.finishedAt = now();
        if (r.status !== 'cancelled') { r.resumeAfterRecovery = false; r.status = this.closing ? 'interrupted' : 'pausing'; r.note = t.error; }
      });
    }).finally(() => {
      logger?.end();
      const t = this.store.get(runId).turns.find(t => t.id === turnId)!;
      try { this.store.finishDiagnostics(turnId, { status: t.status, error: t.error, finishedAt: t.finishedAt, loggingError: logger?.error }, snapshot.workspace); }
      catch { console.error('Не удалось сохранить итог диагностического журнала.'); }
      this.active.delete(turnId); this.kick();
    });
  }
  private validateActions(r: Run, turn: Turn, reply: AgentReply) {
    const lead = turn.agentId === r.team.leadId;
    if (reply.actions.filter(a => a.type === 'continue').length > 1 || (reply.actions.some(a => a.type === 'continue') && reply.actions.some(a => a.type === 'finish'))) throw new Error('Нельзя одновременно завершить задачу и продолжить свой ход или запросить несколько продолжений.');
    for (const a of reply.actions) {
      if (a.type === 'send' && (a.to === turn.agentId || !r.participants.some(p => p.id === a.to))) throw new Error('Агент указал недопустимого получателя.');
      if (a.type === 'send' && a.topicId && !r.topics.some(t => t.id === a.topicId)) throw new Error('Тема сообщения не найдена.');
      if (a.type === 'open_topic' && !r.participants.some(p => p.id === a.ownerId)) throw new Error('Владелец темы не найден.');
      if (a.type === 'resolve_topic' && !r.topics.some(t => t.id === a.topicId && (lead || t.ownerId === turn.agentId))) throw new Error('Агент не может закрыть эту тему.');
      if (a.type === 'accept_decision' && (!lead || !r.decisions.some(d => d.id === a.decisionId && d.status === 'proposed' && d.revision === r.revision))) throw new Error('Агент не может принять это решение.');
      if (a.type === 'finish') {
        if (!lead) throw new Error('Завершить задачу может только ведущий.');
        const evidence = a.evidenceIds.map(id => r.messages.find(m => m.id === id));
        if (evidence.some(m => !m || m.kind !== 'agent' || m.authorId === turn.agentId || m.revision !== r.revision || m.stale)) throw new Error('Для завершения нужны актуальные сообщения коллег с результатами проверки.');
        const reviewers = r.participants.filter(p => p.role.kind === 'reviewer' && p.id !== turn.agentId);
        if (reviewers.length && !evidence.some(m => reviewers.some(p => p.id === m?.authorId))) throw new Error('Для завершения нужен результат рецензента текущей версии требований.');
      }
    }
  }
  private succeed(id: string, turnId: string, result: AgentResult) {
    const reply = replySchema.parse(result.reply);
    this.store.update(id, 'turn-complete', r => {
      const t = r.turns.find(t => t.id === turnId)!, p = r.participants.find(p => p.id === t.agentId)!;
      if (r.status === 'cancelled' || this.closing) { t.status = 'cancelled'; t.finishedAt = now(); return; }
      const stale = t.revision !== r.revision;
      if (!stale) this.validateActions(r, t, reply);
      t.status = 'succeeded'; t.finishedAt = now(); t.draft = ''; t.stale = stale; t.usage = result.usage; t.warnings = result.warnings;
      p.sessionStarted = true; p.actualModel = result.actualModel; p.cumulativeUsage = result.cumulativeUsage;
      message(r, { authorId: p.id, kind: 'agent', text: reply.message, recipientIds: [], turnId, revision: t.revision, stale });
      if (stale) {
        if (p.role.access === 'execute') { r.status = 'pausing'; r.note = 'Исполнитель завершил ход по старым требованиям. Проверьте изменения файлов перед продолжением.'; }
        return;
      }
      r.completion = undefined;
      for (const m of r.messages) if (t.causeIds.includes(m.id) && !m.appliedBy.includes(p.id)) m.appliedBy.push(p.id);
      for (const a of reply.actions) this.apply(r, t, a);
    });
  }
  private apply(r: Run, t: Turn, a: Action) {
    switch (a.type) {
      case 'continue': {
        const m = message(r, { authorId: t.agentId, kind: 'system', text: `Продолжение работы: ${a.reason}`, recipientIds: [t.agentId], turnId: t.id });
        queue(r, t.agentId, m.id, 'Продолжение работы участника'); break;
      }
      case 'send': {
        const m = message(r, { authorId: t.agentId, kind: 'agent', text: a.text, recipientIds: [a.to], turnId: t.id, topicId: a.topicId });
        queue(r, a.to, m.id, 'Сообщение коллеги'); break;
      }
      case 'open_topic': r.topics.push({ id: uid(), title: a.title, ownerId: a.ownerId, status: 'open', createdAt: now() }); break;
      case 'resolve_topic': r.topics.find(t => t.id === a.topicId)!.status = 'resolved'; break;
      case 'propose_decision':
        r.decisions.push({ id: uid(), title: a.title, rationale: a.rationale, authorId: t.agentId, status: 'proposed', revision: r.revision, createdAt: now() });
        if (r.team.checkpoints === 'manual') { r.resumeAfterRecovery = false; r.status = 'pausing'; r.note = 'Команда предложила решение. Проверьте его и продолжите работу.'; } break;
      case 'accept_decision': r.decisions.find(d => d.id === a.decisionId)!.status = 'accepted'; break;
      case 'artifact': r.artifacts.push({ id: uid(), title: a.title, content: a.content, authorId: t.agentId, revision: r.revision, createdAt: now() }); break;
      case 'finish': r.completion = { summary: a.summary, evidenceIds: a.evidenceIds, revision: r.revision }; break;
    }
  }
  async close() { this.closing = true; for (const a of this.active.values()) a.abort.abort(); await Promise.allSettled([...this.active.values()].map(a => a.done)); }
}
