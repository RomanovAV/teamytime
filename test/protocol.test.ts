import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamDecoder, publicDraft, parseReply, ReplyError } from '../src/server/agents/protocol';

test('streaming ignores thinking, UTF-8 boundaries and full-response duplication', () => {
  const drafts: string[] = [], init: string[] = [];
  const decoder = new StreamDecoder('session-a', x => drafts.push(x), m => init.push(m!), () => {});
  const raw = JSON.stringify({ message: 'Привет, команда!\nПроверим «план».', actions: [] });
  const records = [
    { type: 'system', subtype: 'init', session_id: 'session-a', model: 'CodeChat' },
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: 'PRIVATE' } } },
    ...Array.from(raw).map(text => ({ type: 'stream_event', event: { delta: { type: 'text_delta', text } } })),
    { type: 'assistant', message: { model: 'Qwen', content: [{ type: 'thinking', thinking: 'PRIVATE' }, { type: 'text', text: raw }] } },
    { type: 'result', subtype: 'success', result: raw, usage: { input_tokens: 29563, output_tokens: 150, cache_read_input_tokens: 100, total_tokens: 29713 } },
  ];
  const bytes = Buffer.from(records.map(x => JSON.stringify(x)).join('\n'));
  for (let i = 0; i < bytes.length; i += 7) decoder.feed(bytes.subarray(i, i + 7));
  const result = decoder.end({ input: 14766, output: 82, cachedInput: 40, total: 14848 });
  assert.equal(result.reply.message, 'Привет, команда!\nПроверим «план».');
  assert.equal(drafts.at(-1), result.reply.message); assert(!drafts.join('').includes('PRIVATE'));
  assert.deepEqual(result.usage, { input: 14797, output: 68, cachedInput: 60, total: 14865 });
  assert.equal(result.initModel, 'CodeChat'); assert.equal(result.actualModel, 'Qwen'); assert.deepEqual(init, ['CodeChat']);
});
test('incomplete JSON string escapes never expose actions', () => {
  assert.equal(publicDraft('{"message":"one\\n\\u0410\\'), 'one\nА');
  assert.equal(publicDraft('{"message":"Hi","actions":[{"type":"send"}]}'), 'Hi');
  assert.equal(publicDraft('my internal notes'), '');
});
test('terminal result and schema validation are mandatory', () => {
  const d = new StreamDecoder('a', () => {}, () => {}, () => {});
  d.feed(Buffer.from('{"type":"stream_event","event":{"type":"message_stop"}}\n'));
  assert.throws(() => d.end(), /без итогового/);
  assert.throws(() => d.feed(Buffer.from('{"type":"system","session_id":"b"}\n')), /другую сессию/);
  assert.throws(() => parseReply('{"message":"ok","actions":[{"type":"shell","command":"oops"}]}'), /вне протокола/);
});
test('usage counter reset starts a fresh baseline', () => {
  const d = new StreamDecoder('a', () => {}, () => {}, () => {});
  d.feed(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', result: '{"message":"ok","actions":[]}', usage: { input_tokens: 10, output_tokens: 2 } })));
  assert.equal(d.end({ input: 100, output: 20, cachedInput: 0, total: 120 }).usage?.total, 12);
});

test('prose and fences around one JSON reply are accepted, ambiguity is rejected', () => {
  const reply = { message: 'Скобки { и } и "кавычки"', actions: [{ type: 'send', to: 'marina', text: 'Готово' }] };
  const raw = JSON.stringify(reply);
  assert.deepEqual(parseReply(`Рецензия готова.\n\`\`\`json\n${raw}\n\`\`\`\nКонец.`), reply);
  assert.equal(publicDraft(`Вступление\n${raw}`), reply.message);
  assert.throws(() => parseReply(`${raw}\n${raw}`), /однозначный/);
  assert.throws(() => parseReply(`Вступление {"message":"ok","actions":[{"type":"shell"}]} конец`), /actions/);
  assert.throws(() => parseReply(`Вступление {"message":"Сохранить текст","actions":[{"type":"shell"}]} конец`), error => error instanceof ReplyError && error.publicMessage === 'Сохранить текст');
  assert.throws(() => parseReply(`{"wrapper":${raw}}`), /вне протокола/);
});

test('successful reply survives permission denials with visible warning; CLI failure still fails', () => {
  for (const failed of [false, true]) {
    const d = new StreamDecoder('a', () => {}, () => {}, () => {});
    d.feed(Buffer.from(JSON.stringify({ type: 'result', subtype: failed ? 'error' : 'success', is_error: failed,
      result: '{"message":"Проверка Git недоступна","actions":[]}',
      permission_denials: [{ tool_name: 'run_shell_command', tool_input: { command: 'SECRET' } }] })));
    if (failed) assert.throws(() => d.end(), /ошибке выполнения/);
    else { const result = d.end(); assert.equal(result.reply.message, 'Проверка Git недоступна'); assert.equal(result.warnings?.length, 1); assert(!result.warnings![0].includes('SECRET')); }
  }
});
