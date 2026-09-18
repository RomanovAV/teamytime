import { StringDecoder } from 'node:string_decoder';
import { homedir, release } from 'node:os';
import pkg from '../../package.json';

export type DiagnosticStream = 'stdout' | 'stderr' | 'event' | 'evidence';
export const diagnosticLimits = { lineBytes: 1024 * 1024, streamBytes: 512 * 1024, streamEntries: 512, evidenceBytes: 8 * 1024 * 1024, evidenceEntries: 4096 };
export const runtimeInfo = () => ({ appVersion: pkg.version, node: process.version, platform: process.platform, arch: process.arch, osRelease: release() });
const secretKey = /^(?:authorization|proxy.authorization|cookie|set.cookie|password|passwd|client.secret|api.?key|(?:access|refresh|id).?token|token|secret|user.code|device.code|verification.uri(?:.complete)?|login.url|auth.url)$/i;
const secretAssignment = /((?:authorization|cookie|password|passwd|client_secret|api[_-]?key|access_token|refresh_token|id_token|token|secret|user_code|device_code)\s*["']?\s*[:=]\s*["']?)([^\s"'\\,;}\]]+)/gi;

// Diagnostic copies only: the live conversation and CLI inputs are not modified.
export function redact(value: unknown, workspace?: string): unknown {
  const paths = [[workspace, '[WORKSPACE]'], [homedir(), '[HOME]']]
    .filter((entry): entry is [string, string] => !!entry[0] && entry[0] !== '/')
    .sort((a, b) => b[0].length - a[0].length);
  const text = (input: string) => {
    let result = input.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/https?:\/\/[^\s<>"'`\\]+/gi, url => {
        if (/(?:auth|login|oauth|device|verify|verification)|[?&](?:code|token|key|secret|password|api_key)=/i.test(url)) return '[AUTH_URL_REDACTED]';
        return url.replace(/(https?:\/\/)[^/@\s]+@/i, '$1[REDACTED]@');
      })
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]')
      .replace(secretAssignment, '$1[REDACTED]');
    for (const [from, to] of paths) result = result.split(from).join(to);
    return result;
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 40) return '[NESTING_LIMIT]';
    if (typeof item === 'string') {
      // result.result and tool payloads can themselves contain JSON.
      if (/^\s*[\[{]/.test(item)) { try { return JSON.stringify(visit(JSON.parse(item), depth + 1)); } catch { /* Plain text. */ } }
      return text(item);
    }
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      if (typeof record.type === 'string' && /^(?:thinking|reasoning|redacted_thinking)(?:_delta)?$/.test(record.type)) return { type: record.type, content: '[OMITTED]' };
      // A credential can be split between deltas. Keep timing/type; full text and
      // tool arguments are recorded from the assembled assistant/result events.
      if (record.type === 'text_delta' || record.type === 'input_json_delta') return { type: record.type, content: '[PARTIAL_CONTENT_OMITTED]' };
      return Object.fromEntries(Object.entries(record).map(([key, child]) => [text(key), secretKey.test(key) ? '[REDACTED]' : /^(?:thinking|reasoning|signature)$/i.test(key) ? '[OMITTED]' : visit(child, depth + 1)]));
    }
    return item;
  };
  return visit(value, 0);
}

/** Frame before redacting so UTF-8 and credentials split across pipe chunks survive. */
export class TurnLogger {
  error?: string;
  private filtered = { streamEvents: 0, nestedEvents: 0, duplicateMessages: 0 };
  private channels = {
    stdout: { decoder: new StringDecoder('utf8'), buffer: '', dropping: false },
    stderr: { decoder: new StringDecoder('utf8'), buffer: '', dropping: false },
  };
  constructor(private persist: (stream: DiagnosticStream, data: unknown) => void, private workspace: string) {}
  private write(stream: DiagnosticStream, data: unknown) {
    if (this.error) return;
    try { this.persist(stream, data); }
    catch { this.error = 'Не удалось сохранить часть диагностического журнала.'; console.error(this.error); }
  }
  event(data: unknown) { this.write('event', redact(data, this.workspace)); }
  feed(stream: 'stdout' | 'stderr', chunk: Buffer) { this.consume(stream, this.channels[stream].decoder.write(chunk)); }
  end() {
    for (const stream of ['stdout', 'stderr'] as const) {
      this.consume(stream, this.channels[stream].decoder.end());
      const channel = this.channels[stream];
      if (channel.buffer && !channel.dropping) this.line(stream, channel.buffer);
      channel.buffer = ''; channel.dropping = false;
    }
    if (Object.values(this.filtered).some(Boolean)) {
      this.write('event', { type: 'output-filtered', ...this.filtered });
      this.filtered = { streamEvents: 0, nestedEvents: 0, duplicateMessages: 0 };
    }
  }
  private consume(stream: 'stdout' | 'stderr', text: string) {
    const channel = this.channels[stream];
    for (const [index, part] of text.split('\n').entries()) {
      if (index > 0) {
        if (!channel.dropping && channel.buffer) this.line(stream, channel.buffer);
        channel.buffer = ''; channel.dropping = false;
      }
      if (channel.dropping) continue;
      if (Buffer.byteLength(channel.buffer) + Buffer.byteLength(part) > diagnosticLimits.lineBytes) {
        channel.buffer = ''; channel.dropping = true;
        this.write(stream, { omitted: 'line_too_large', limitBytes: diagnosticLimits.lineBytes });
      } else channel.buffer += part;
    }
  }
  private line(stream: 'stdout' | 'stderr', line: string) {
    let data: unknown = line;
    if (stream === 'stdout') { try { data = JSON.parse(line); } catch { /* Preserve malformed output for diagnosis. */ } }
    if (stream === 'stdout' && data && typeof data === 'object') {
      const compact = this.compactStdout(data as Record<string, unknown>);
      if (!compact) return;
      data = compact;
    }
    const type = data && typeof data === 'object' ? (data as { type?: string }).type : undefined;
    // Tool evidence and terminal metadata have their own budget.
    const important = stream === 'stdout' && ['assistant', 'user', 'result', 'system'].includes(type ?? '');
    this.write(important ? 'evidence' : stream, redact(data, this.workspace));
  }
  private compactStdout(data: Record<string, unknown>): Record<string, unknown> | undefined {
    if (typeof data.parent_tool_use_id === 'string' && data.parent_tool_use_id) {
      this.filtered.nestedEvents++;
      return;
    }
    if (data.type === 'stream_event') {
      this.filtered.streamEvents++;
      return;
    }
    if (data.type === 'assistant' || data.type === 'user') {
      const message = data.message && typeof data.message === 'object' ? data.message as Record<string, unknown> : {};
      const content = Array.isArray(message.content) ? message.content.filter(item => {
        if (!item || typeof item !== 'object') return false;
        const type = (item as { type?: string }).type;
        return data.type === 'assistant' ? type === 'tool_use' : type === 'tool_result';
      }) : [];
      if (!content.length) {
        this.filtered.duplicateMessages++;
        return;
      }
      return {
        type: data.type,
        ...(data.session_id === undefined ? {} : { session_id: data.session_id }),
        message: { ...(message.model === undefined ? {} : { model: message.model }), content },
      };
    }
    if (data.type === 'system' && data.subtype === 'init') {
      return Object.fromEntries(['type', 'subtype', 'session_id', 'model'].flatMap(key => data[key] === undefined ? [] : [[key, data[key]]]));
    }
    if (data.type === 'result') {
      const resultChars = typeof data.result === 'string' ? data.result.length
        : data.result === undefined ? 0 : JSON.stringify(data.result).length;
      return Object.fromEntries([
        'type', 'subtype', 'session_id', 'is_error', 'duration_ms', 'duration_api_ms',
        'num_turns', 'usage', 'total_cost_usd', 'permission_denials',
      ].flatMap(key => data[key] === undefined ? [] : [[key, data[key]]]).concat([['resultChars', resultChars]]));
    }
    return data;
  }
}
