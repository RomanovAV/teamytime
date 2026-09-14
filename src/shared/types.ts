export type RoleKind = 'coordinator' | 'researcher' | 'executor' | 'reviewer' | 'custom';
export interface Role {
  id: string; name: string; description: string; instructions: string;
  kind: RoleKind; access: 'discuss' | 'execute';
}
export interface Member { id: string; name: string; roleId: string; model: string; notes: string }
export interface Team {
  id: string; name: string; members: Member[]; leadId: string;
  parallelism: number; maxTurns: number; checkpoints: 'auto' | 'manual';
}
export interface Configuration {
  roles: Role[]; teams: Team[]; cli: { command: string; timeoutSeconds: number };
}
export type RunStatus = 'running' | 'pausing' | 'paused' | 'waiting' | 'completed' | 'cancelled' | 'interrupted';
export type TurnStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled' | 'skipped';
export interface Usage { input: number; output: number; cachedInput: number; total: number }
export interface Participant extends Member {
  role: Role; sessionId: string; sessionStarted: boolean;
  initModel?: string; actualModel?: string; cumulativeUsage?: Usage;
}
export interface Message {
  id: string; authorId: string | null; kind: 'user' | 'agent' | 'system'; text: string;
  recipientIds: string[]; deliveredTo: string[]; appliedBy: string[];
  revision: number; createdAt: string; turnId?: string; topicId?: string; stale?: boolean;
}
export interface Turn {
  id: string; agentId: string; causeIds: string[]; status: TurnStatus; reason: string;
  createdAt: string; startedAt?: string; finishedAt?: string; revision?: number;
  draft: string; activity?: string; error?: string; stale?: boolean; usage?: Usage;
}
export interface Topic { id: string; title: string; ownerId: string; status: 'open' | 'resolved'; createdAt: string }
export interface Decision {
  id: string; title: string; rationale: string; authorId: string;
  status: 'proposed' | 'accepted' | 'needs_review' | 'rejected'; revision: number; createdAt: string;
}
export interface Artifact {
  id: string; title: string; content: string; authorId: string; revision: number; createdAt: string;
}
export interface Completion { summary: string; evidenceIds: string[]; revision: number }
export interface Run {
  id: string; title: string; prompt: string; mode: 'demo' | 'gigacode'; status: RunStatus;
  note: string; revision: number; createdAt: string; updatedAt: string; workspace: string;
  team: Team; participants: Participant[]; messages: Message[]; turns: Turn[];
  topics: Topic[]; decisions: Decision[]; artifacts: Artifact[];
  completion?: Completion; finalSummary?: string;
}
export interface RunSummary {
  id: string; title: string; status: RunStatus; mode: Run['mode'];
  updatedAt: string; teamName: string; messageCount: number;
}
export type Action =
  | { type: 'send'; to: string; text: string; topicId?: string }
  | { type: 'open_topic'; title: string; ownerId: string }
  | { type: 'resolve_topic'; topicId: string }
  | { type: 'propose_decision'; title: string; rationale: string }
  | { type: 'accept_decision'; decisionId: string }
  | { type: 'artifact'; title: string; content: string }
  | { type: 'finish'; summary: string; evidenceIds: string[] };
export interface AgentReply { message: string; actions: Action[] }
export interface AppEvent { id: number; runId: string | null; reason: string; createdAt: string }
export interface Bootstrap {
  config: Configuration; runs: RunSummary[]; cursor: number;
  cli: { available: boolean; command: string }; dataDirectory: string;
}

export const statusLabels: Record<RunStatus, string> = {
  running: 'В работе', pausing: 'Завершает текущие ходы', paused: 'На паузе',
  waiting: 'Ждёт сообщения', completed: 'Завершено', cancelled: 'Остановлено', interrupted: 'Прервано',
};
