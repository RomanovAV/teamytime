import type { Action, AgentReply } from '../../shared/types';

function action(header: string, lines: string[]): Action {
  const [name, ...args] = header.slice(1).trim().split(/\s+/);
  let body = lines.join('\n').trim();
  // Both layouts name the artifact explicitly; never infer missing content or @end.
  if (['artifact', 'result'].includes(name) && !args.length && lines[0]?.trim()) {
    args.push(lines[0].trim()); body = lines.slice(1).join('\n').trim();
  }
  const requireArgs = (min: number, max = min) => {
    if (args.length < min || args.length > max) throw new Error(`Неверные параметры @${name}.`);
  };
  const emptyBody = () => { if (body) throw new Error(`Блок @${name} не принимает текст.`); };
  switch (name) {
    case 'send': requireArgs(1, 2); return { type: 'send', to: args[0], text: body, ...(args[1] ? { topicId: args[1] } : {}) };
    case 'continue': requireArgs(0); return { type: 'continue', reason: body };
    case 'open_topic': requireArgs(1); return { type: 'open_topic', ownerId: args[0], title: body };
    case 'resolve_topic': requireArgs(1); emptyBody(); return { type: 'resolve_topic', topicId: args[0] };
    case 'propose_decision': requireArgs(1, 120); return { type: 'propose_decision', title: args.join(' '), rationale: body };
    case 'accept_decision': requireArgs(1); emptyBody(); return { type: 'accept_decision', decisionId: args[0] };
    case 'artifact': requireArgs(1, 120); return { type: 'artifact', title: args.join(' '), content: body };
    case 'result': requireArgs(1, 120); return { type: 'result', title: args.join(' '), content: body };
    case 'publish_artifact': requireArgs(1); emptyBody(); return { type: 'publish_artifact', artifactId: args[0] };
    case 'finish': requireArgs(1, 20); return { type: 'finish', evidenceIds: args, summary: body };
    default: throw new Error(`Неизвестное действие @${name}.`);
  }
}

/** Directives are recognized only on separate lines outside Markdown code fences. */
export function textReply(raw: string, draft = false): AgentReply {
  const message: string[] = [], actions: Action[] = [];
  let header: string | undefined, body: string[] = [], fence = '', fenceLength = 0;
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], trimmed = line.trim();
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (marker) {
      if (!fence) { fence = marker[0]; fenceLength = marker.length; }
      else if (marker[0] === fence && marker.length >= fenceLength && trimmed === marker) fence = '';
      (header ? body : message).push(line); continue;
    }
    if (!fence && /^@/.test(trimmed)) {
      if (draft && i === lines.length - 1) break; // A directive may still be arriving.
      if (trimmed === '@end') {
        if (!header) { if (draft) continue; throw new Error('@end без начала блока.'); }
        if (!draft) actions.push(action(header, body));
        header = undefined; body = []; continue;
      }
      if (header && !draft) throw new Error('Вложенные действия запрещены. Закройте предыдущий блок через @end.');
      header = trimmed; body = []; continue;
    }
    (header ? body : message).push(line.replace(/^(\s*)\\@/, '$1@'));
  }
  if (header && !draft) throw new Error(`Не закрыт блок ${header}: нужна строка @end.`);
  return { message: message.join('\n').trim() || (actions.length ? 'Действия участника.' : ''), actions };
}
