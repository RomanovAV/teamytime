import { z } from 'zod';

const id = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
const short = z.string().trim().min(1).max(120);
const role = z.object({
  id, name: short, description: z.string().max(300), instructions: z.string().trim().min(1).max(6000),
  kind: z.enum(['coordinator', 'researcher', 'executor', 'reviewer', 'custom']),
  access: z.enum(['discuss', 'execute']),
}).strict();
const member = z.object({ id, name: short, roleId: id, model: z.string().trim().min(1).max(200), notes: z.string().max(3000) }).strict();
const team = z.object({
  id, name: short, members: z.array(member).min(2).max(8), leadId: id,
  parallelism: z.number().int().min(1).max(4), maxTurns: z.number().int().min(4).max(100),
  checkpoints: z.enum(['auto', 'manual']),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.members.map(m => m.id)).size !== value.members.length) ctx.addIssue({ code: 'custom', message: 'Участники должны иметь разные ID.' });
  if (!value.members.some(m => m.id === value.leadId)) ctx.addIssue({ code: 'custom', message: 'Выберите ведущего участника команды.' });
});
export const configurationSchema = z.object({
  roles: z.array(role).min(1).max(30), teams: z.array(team).min(1).max(20),
  cli: z.object({ command: z.string().trim().min(1).max(500), timeoutSeconds: z.number().int().min(10).max(1800) }).strict(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.roles.map(r => r.id)).size !== value.roles.length || new Set(value.teams.map(t => t.id)).size !== value.teams.length) ctx.addIssue({ code: 'custom', message: 'ID ролей и команд должны быть уникальны.' });
  for (const t of value.teams) for (const m of t.members) if (!value.roles.some(r => r.id === m.roleId)) ctx.addIssue({ code: 'custom', message: `Не найдена роль участника ${m.name}.` });
});
export const createRunSchema = z.object({
  prompt: z.string().trim().min(3).max(12000), teamId: id,
  mode: z.enum(['demo', 'gigacode']), workspace: z.string().trim().max(1000).default(''),
}).strict();
export const messageSchema = z.object({
  text: z.string().trim().min(1).max(6000), kind: z.enum(['update', 'message']),
  recipientId: id.optional(),
}).strict();
export const replySchema = z.object({
  message: z.string().trim().min(1).max(24000),
  actions: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('send'), to: id, text: z.string().trim().min(1).max(6000), topicId: id.optional() }).strict(),
    z.object({ type: z.literal('open_topic'), title: short, ownerId: id }).strict(),
    z.object({ type: z.literal('resolve_topic'), topicId: id }).strict(),
    z.object({ type: z.literal('propose_decision'), title: short, rationale: z.string().trim().min(1).max(6000) }).strict(),
    z.object({ type: z.literal('accept_decision'), decisionId: id }).strict(),
    z.object({ type: z.literal('artifact'), title: short, content: z.string().trim().min(1).max(50000) }).strict(),
    z.object({ type: z.literal('finish'), summary: z.string().trim().min(1).max(12000), evidenceIds: z.array(id).min(1).max(20) }).strict(),
  ])).max(8),
}).strict();

export class UserError extends Error { constructor(message: string, public status = 400) { super(message); } }
