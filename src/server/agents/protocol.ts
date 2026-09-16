import { StringDecoder } from 'node:string_decoder';
import type { AgentReply, Usage } from '../../shared/types';
import { replySchema } from '../validation';
import { textReply } from './text-reply';

export class ReplyError extends Error {
  publicMessage: string;
  constructor(message: string, raw: string) {
    super(message);
    this.publicMessage = publicDraft(raw).slice(0, 24000);
  }
}

// Old sessions may still answer in JSON during the transition.
function legacyReply(raw: string): boolean {
  // A text action may contain JSON examples or a JSON artifact as its body.
  if (/^\s*@/m.test(raw)) return false;
  return /^\s*(?:\{|\[|```json)/.test(raw) || /\{\s*"(?:message|actions)"\s*:/.test(raw);
}
export function parseReply(raw: string): AgentReply {
  if (legacyReply(raw)) return parseLegacyReply(raw);
  try {
    const result = replySchema.safeParse(textReply(raw));
    if (!result.success) throw new Error(`Проверьте поля ${result.error.issues.map(i => i.path.join('.') || 'ответ').join(', ')}.`);
    return result.data;
  } catch (error) { throw new ReplyError(`Ответ вне протокола команды: ${(error as Error).message}`, raw); }
}
export function publicDraft(raw: string): string {
  return legacyReply(raw) ? legacyDraft(raw) : textReply(raw, true).message;
}

// Locate top-level objects without interpreting braces inside JSON strings.
function objects(raw: string): string[] {
  const found: string[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (start < 0) { if (c === '{') { start = i; depth = 1; } continue; }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { found.push(raw.slice(start, i + 1)); start = -1; }
  }
  return found;
}

function parseLegacyReply(raw: string): AgentReply {
  const text = raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { /* Allow prose around one reply object. */ }
  const candidates = parsed !== undefined ? [parsed] : objects(text).flatMap(text => {
    try { return [JSON.parse(text)]; } catch { return []; }
  }).filter(value => value && ('message' in value || 'actions' in value));
  if (candidates.length !== 1) throw new ReplyError('Ответ вне протокола команды: нужен один однозначный JSON-объект с message и actions.', raw);
  const result = replySchema.safeParse(candidates[0]);
  if (!result.success) throw new ReplyError(`Ответ вне протокола команды: проверьте поля ${result.error.issues.map(i => i.path.join('.') || 'ответ').join(', ')}.`, raw);
  return result.data;
}

// Show only the public message, including while its JSON string is incomplete.
function legacyDraft(raw: string): string {
  const match = /\{\s*"message"\s*:\s*"/.exec(raw);
  if (!match) return '';
  let encoded = '';
  for (let i = match.index + match[0].length; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') break;
    if (c === '\\') {
      if (i + 1 >= raw.length) break;
      const length = raw[i + 1] === 'u' ? 6 : 2;
      if (i + length > raw.length) break;
      encoded += raw.slice(i, i + length); i += length - 1;
    } else encoded += c;
  }
  try { return JSON.parse(`"${encoded}"`); } catch { return ''; }
}

function usage(value: any): Usage | undefined {
  if (!value || typeof value.input_tokens !== 'number') return;
  const input = Math.max(0, value.input_tokens), output = Math.max(0, value.output_tokens ?? 0);
  return { input, output, cachedInput: Math.max(0, value.cache_read_input_tokens ?? 0), total: Math.max(0, value.total_tokens ?? input + output) };
}

export class StreamDecoder {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private size = 0;
  private partial = '';
  private assistantText = '';
  private terminal: any;
  initModel?: string;
  actualModel?: string;
  initialized = false;
  constructor(private sessionId: string, private onDraft: (value: string) => void, private onInit: (model?: string) => void, private onActivity: (value: string) => void) {}
  feed(chunk: Buffer) {
    this.size += chunk.length;
    if (this.size > 8 * 1024 * 1024) throw new Error('Вывод CLI превысил лимит 8 МБ.');
    this.buffer += this.decoder.write(chunk);
    let end: number;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      this.line(this.buffer.slice(0, end)); this.buffer = this.buffer.slice(end + 1);
    }
  }
  end(previous?: Usage) {
    this.buffer += this.decoder.end(); if (this.buffer.trim()) this.line(this.buffer);
    if (!this.terminal) throw new Error('CLI завершился без итогового события result.');
    if (this.terminal.is_error || this.terminal.subtype !== 'success') throw new Error('GigaCode сообщил об ошибке выполнения хода.');
    const warnings = this.terminal.permission_denials?.length
      ? ['GigaCode отклонил отдельные вызовы инструментов. Ответ сохранён, но отклонённые проверки не выполнены. Подробности — в отчёте запуска.'] : undefined;
    const cumulative = usage(this.terminal.usage);
    let delta = cumulative;
    if (cumulative && previous) {
      const reset = (Object.keys(cumulative) as (keyof Usage)[]).some(k => cumulative[k] < previous[k]);
      delta = reset ? cumulative : Object.fromEntries(Object.keys(cumulative).map(k => [k, cumulative[k as keyof Usage] - previous[k as keyof Usage]])) as unknown as Usage;
    }
    const raw = typeof this.terminal.result === 'string' ? this.terminal.result : this.assistantText || this.partial;
    return { reply: parseReply(raw), warnings, usage: delta, cumulativeUsage: cumulative, initModel: this.initModel, actualModel: this.actualModel };
  }
  private line(line: string) {
    if (!line.trim()) return;
    let data: any;
    try { data = JSON.parse(line); } catch { throw new Error('CLI прислал некорректный stream-json.'); }
    if (data.session_id && data.session_id !== this.sessionId) throw new Error('CLI вернул другую сессию. Продолжение остановлено.');
    if (data.type === 'system' && data.subtype === 'init') {
      this.initialized = true; this.initModel = data.model; this.onInit(this.initModel);
    }
    if (data.type === 'stream_event') {
      if (data.event?.type === 'message_start') this.partial = '';
      if (data.event?.delta?.type === 'text_delta') {
        this.partial += data.event.delta.text ?? ''; this.onDraft(publicDraft(this.partial));
      }
      if (data.event?.content_block?.type === 'tool_use') this.onActivity('Работает с инструментами');
    }
    if (data.type === 'assistant') {
      this.actualModel = data.message?.model ?? this.actualModel;
      this.assistantText = (data.message?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
      if (this.assistantText) this.onDraft(publicDraft(this.assistantText));
      if (data.message?.content?.some((c: any) => c.type === 'tool_use')) this.onActivity('Работает с инструментами');
    }
    if (data.type === 'result') this.terminal = data;
  }
}
