import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AppEvent, Configuration, Run, RunSummary } from '../shared/types';
import { defaultConfiguration } from '../shared/defaults';
import { UserError } from './validation';

export class Store {
  private db: DatabaseSync;
  readonly changes = new EventEmitter();
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'teamytime.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, updated TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, reason TEXT NOT NULL, created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id,id);`);
    this.db.prepare('INSERT OR IGNORE INTO config VALUES (1,?)').run(JSON.stringify(defaultConfiguration));
  }
  config(): Configuration { return JSON.parse((this.db.prepare('SELECT json FROM config WHERE id=1').get() as { json: string }).json); }
  saveConfig(value: Configuration) {
    this.transaction(() => this.db.prepare('UPDATE config SET json=? WHERE id=1').run(JSON.stringify(value)), null, 'config');
  }
  list(): RunSummary[] {
    return this.all().map(r => ({ id: r.id, title: r.title, status: r.status, mode: r.mode, updatedAt: r.updatedAt, teamName: r.team.name, messageCount: r.messages.length }));
  }
  all(): Run[] { return (this.db.prepare('SELECT json FROM runs ORDER BY updated DESC').all() as { json: string }[]).map(r => JSON.parse(r.json)); }
  get(id: string): Run {
    const row = this.db.prepare('SELECT json FROM runs WHERE id=?').get(id) as { json: string } | undefined;
    if (!row) throw new UserError('Задача не найдена.', 404);
    return JSON.parse(row.json);
  }
  create(run: Run) {
    this.transaction(() => this.db.prepare('INSERT INTO runs VALUES (?,?,?)').run(run.id, run.updatedAt, JSON.stringify(run)), run.id, 'created');
  }
  update(id: string, reason: string, fn: (run: Run) => void): Run {
    let value!: Run;
    this.transaction(() => {
      value = this.get(id); fn(value); value.updatedAt = new Date().toISOString();
      this.db.prepare('UPDATE runs SET updated=?,json=? WHERE id=?').run(value.updatedAt, JSON.stringify(value), id);
    }, id, reason);
    return value;
  }
  private transaction(fn: () => unknown, runId: string | null, reason: string) {
    this.db.exec('BEGIN IMMEDIATE');
    let event!: AppEvent;
    try {
      fn(); const createdAt = new Date().toISOString();
      const inserted = this.db.prepare('INSERT INTO events(run_id,reason,created) VALUES (?,?,?)').run(runId, reason, createdAt);
      event = { id: Number(inserted.lastInsertRowid), runId, reason, createdAt };
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.changes.emit('change', event);
  }
  cursor(): number { return Number((this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get() as { id: number }).id); }
  eventsAfter(cursor: number): AppEvent[] {
    return (this.db.prepare('SELECT id,run_id,reason,created FROM events WHERE id>? ORDER BY id LIMIT 1001').all(cursor) as { id: number; run_id: string | null; reason: string; created: string }[])
      .map(e => ({ id: e.id, runId: e.run_id, reason: e.reason, createdAt: e.created }));
  }
  recover() {
    for (const run of this.all()) if (['running', 'pausing'].includes(run.status) || run.turns.some(t => t.status === 'running')) {
      this.update(run.id, 'recovered', r => {
        r.status = 'interrupted'; r.note = 'Сервер был остановлен. Проверьте незавершённые ходы перед продолжением.';
        for (const t of r.turns) if (t.status === 'running') {
          t.status = 'interrupted'; t.finishedAt = new Date().toISOString();
          t.error = 'Исход прерванного хода неизвестен. Повторите или пропустите его явно.';
        }
      });
    }
  }
  close() { this.db.close(); }
}
