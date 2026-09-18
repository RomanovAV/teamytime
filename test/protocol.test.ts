import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponseTimeoutError, StreamDecoder, publicDraft, parseReply, ReplyError } from '../src/server/agents/protocol';

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
  assert.equal(publicDraft('public response'), 'public response');
});
test('terminal result and schema validation are mandatory', () => {
  const d = new StreamDecoder('a', () => {}, () => {}, () => {});
  d.feed(Buffer.from('{"type":"stream_event","event":{"type":"message_stop"}}\n'));
  assert.throws(() => d.end(), /без итогового/);
  assert.throws(() => d.feed(Buffer.from('{"type":"system","session_id":"b"}\n')), /другую сессию/);
  assert.throws(() => parseReply('{"message":"ok","actions":[{"type":"shell","command":"oops"}]}'), /вне протокола/);
});

test('API timeout markers use an already completed assistant reply or request recovery', () => {
  const completed = new StreamDecoder('a', () => {}, () => {}, () => {});
  completed.feed(Buffer.from([
    { type: 'assistant', session_id: 'a', message: { content: [{ type: 'text', text: '@send marina\nГотово\n@end' }] } },
    { type: 'result', session_id: 'a', subtype: 'success', result: '[API Error: Request timeout after 11s.]' },
  ].map(value => JSON.stringify(value)).join('\n')));
  assert.deepEqual(completed.end().reply.actions, [{ type: 'send', to: 'marina', text: 'Готово' }]);

  const missing = new StreamDecoder('a', () => {}, () => {}, () => {});
  missing.feed(Buffer.from(JSON.stringify({ type: 'result', session_id: 'a', subtype: 'success', result: '[API Error: Request timeout after 11s.]' })));
  assert.throws(() => missing.end(), error => error instanceof ResponseTimeoutError);
});

test('subagent events cannot replace the root session, draft, final reply or usage', () => {
  const drafts: string[] = [], models: string[] = [], activities: string[] = [];
  const decoder = new StreamDecoder('root', value => drafts.push(value), model => models.push(model!), value => activities.push(value));
  const feed = (event: unknown) => decoder.feed(Buffer.from(JSON.stringify(event) + '\n'));
  feed({ type: 'system', subtype: 'init', session_id: 'root', model: 'RootModel', parent_tool_use_id: null });
  feed({ type: 'stream_event', session_id: 'root', event: { delta: { type: 'text_delta', text: 'Проверяю' } } });
  for (const sessionId of ['root', 'child-session']) {
    for (const event of [
      { type: 'system', subtype: 'init', model: 'ChildModel' },
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Не публиковать' } } },
      { type: 'assistant', message: { model: 'ChildModel', content: [{ type: 'text', text: '@finish fake-id\nГотово\n@end' }] } },
      { type: 'result', subtype: 'success', result: '@continue\nЗапустить лишний ход\n@end', usage: { input_tokens: 9999 } },
    ]) feed({ ...event, session_id: sessionId, parent_tool_use_id: 'tool-agent-1' });
  }
  assert.deepEqual(models, ['RootModel']);
  assert.deepEqual(drafts, ['Проверяю']);
  assert(activities.includes('Исследует с помощью субагента'));
  assert.throws(() => decoder.end(), /без итогового события/);
  feed({ type: 'stream_event', session_id: 'root', event: { delta: { type: 'text_delta', text: ' результат' } } });
  assert.equal(drafts.at(-1), 'Проверяю результат');
  feed({ type: 'assistant', session_id: 'root', message: { model: 'RootModel', content: [{ type: 'text', text: 'Проверка завершена' }] } });
  feed({ type: 'result', session_id: 'root', subtype: 'success', usage: { input_tokens: 100, output_tokens: 20 } });
  feed({ type: 'result', session_id: 'child-session', parent_tool_use_id: 'tool-agent-1', subtype: 'error', result: 'Поздний ответ' });
  const result = decoder.end();
  assert.deepEqual(result.reply, { message: 'Проверка завершена', actions: [] });
  assert.equal(result.actualModel, 'RootModel'); assert.equal(result.usage?.total, 120);
  assert.throws(() => feed({ type: 'system', session_id: 'unexpected-root', parent_tool_use_id: null }), /другую сессию/);
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

test('text replies support every action with multiline bodies', () => {
  const result = parseReply(`Работа выполнена.
@send marina topic-1
Результат проверки
Вторая строка
@end
@continue
Следующий шаг
@end
@open_topic vera
Проверка тестов
@end
@resolve_topic topic-1
@end
@propose_decision Выбранный вариант
Основание выбора
@end
@accept_decision decision-1
@end
@artifact report.md
# Отчёт
Содержимое
@end
@finish evidence-1 evidence-2
Итог работы
@end
Последнее замечание.`);
  assert.equal(result.message, 'Работа выполнена.\nПоследнее замечание.');
  assert.deepEqual(result.actions.map(a => a.type), ['send', 'continue', 'open_topic', 'resolve_topic', 'propose_decision', 'accept_decision', 'artifact', 'finish']);
  assert.deepEqual(result.actions[0], { type: 'send', to: 'marina', topicId: 'topic-1', text: 'Результат проверки\nВторая строка' });
  assert.deepEqual(result.actions[7], { type: 'finish', evidenceIds: ['evidence-1', 'evidence-2'], summary: 'Итог работы' });
});

test('plain text works, malformed action blocks do not execute', () => {
  assert.deepEqual(parseReply('Проверка завершена.'), { message: 'Проверка завершена.', actions: [] });
  for (const raw of ['@send marina\nБез окончания', '@end', '@unknown\nx\n@end', '@send marina\n@continue\nx\n@end', '@send\nx\n@end', '@continue\n@end', '@resolve_topic t\nextra\n@end']) assert.throws(() => parseReply(raw), /протокола/);
  assert.throws(() => parseReply(Array(9).fill('@continue\nx\n@end').join('\n')), /actions/);
  assert.equal(parseReply('@send marina\nГотово\n@end').actions.length, 1);
});

test('run regressions: long review messages and artifact title on next line', () => {
  for (const length of [6075, 6179, 6665]) assert.equal(parseReply(`@send marina\n${'я'.repeat(length)}\n@end`).actions.length, 1);
  assert.deepEqual(parseReply('@artifact\nДиагностика и план.md\n# Версия 1.1\nПолный текст\n@end').actions,
    [{ type: 'artifact', title: 'Диагностика и план.md', content: '# Версия 1.1\nПолный текст' }]);
  assert.throws(() => parseReply(`@send marina\n${'x'.repeat(24001)}\n@end`), /actions.0.text: превышен лимит 24000/);
  assert.throws(() => parseReply('@artifact\n@end'), /параметры/);
  assert.throws(() => parseReply('@continue'), /Не закрыт/);
  assert.throws(() => parseReply('@send_readonly vera\nПроверь без правок\n@end'), /Неизвестное действие/);
  assert.deepEqual(parseReply('@result\nФинальный отчёт.md\n# Готово\n@end').actions,
    [{ type: 'result', title: 'Финальный отчёт.md', content: '# Готово' }]);
  assert.deepEqual(parseReply('@publish_artifact artifact-1\n@end').actions,
    [{ type: 'publish_artifact', artifactId: 'artifact-1' }]);
  assert.throws(() => parseReply('@publish_artifact artifact-1\nПояснение\n@end'), /не принимает текст/);
});

test('invalid reply retains raw text and CLI usage for repair without rerunning tools', () => {
  const d = new StreamDecoder('a', () => {}, () => {}, () => {});
  d.feed(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', result: '@continue', usage: { input_tokens: 100, output_tokens: 20 } })));
  assert.throws(() => d.end(), error => error instanceof ReplyError && error.raw === '@continue' && error.usage?.total === 120);
  const truncated = new StreamDecoder('a', () => {}, () => {}, () => {});
  truncated.feed(Buffer.from('{"type":"stream_event","event":'));
  assert.throws(() => truncated.end(), /оборвался посреди JSON/);
});

test('code examples and escaped directives stay literal; drafts hide action bodies', () => {
  const example = 'Пример:\n```text\n@send marina\nНе отправлять\n@end\n```';
  assert.deepEqual(parseReply(example), { message: example, actions: [] });
  const raw = 'Ответ.\n@artifact sample.txt\n```text\n@end\n```\n\\@send literal\n@end\nГотово.';
  const parsed = parseReply(raw);
  assert.deepEqual(parsed.actions, [{ type: 'artifact', title: 'sample.txt', content: '```text\n@end\n```\n@send literal' }]);
  assert.equal(parsed.message, 'Ответ.\nГотово.');
  assert.deepEqual(parseReply('Результат:\n@artifact data.json\n{"message":"example","actions":[]}\n@end').actions, [{ type: 'artifact', title: 'data.json', content: '{"message":"example","actions":[]}' }]);
  for (const partial of ['Ответ.\n@', 'Ответ.\n@send mar', 'Ответ.\n@send marina\nСкрытый текст', 'Ответ.\n@send marina\nСкрытый текст\n@end']) assert.equal(publicDraft(partial), 'Ответ.');
});
