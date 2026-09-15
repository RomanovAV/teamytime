import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ZodError } from 'zod';
import { Store } from './store';
import { Engine } from './engine';
import { executable } from './agents/adapter';
import { configurationSchema, UserError } from './validation';
import type { AppEvent } from '../shared/types';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { runReport } from './report';

const compress = promisify(gzip);

async function body(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new UserError('Требуется JSON.', 415);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new UserError('Запрос слишком большой.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new UserError('Некорректный JSON.'); }
}
function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data));
}

export function createApplication(store: Store, engine: Engine, webDirectory: string) {
  const streams = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    void (async () => {
      const port = (server.address() as { port: number }).port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host ?? '')) throw new UserError('Недопустимый адрес сервера.', 403);
      if (req.headers.origin && !hosts.some(h => req.headers.origin === `http://${h}`)) throw new UserError('Запрос с другого сайта запрещён.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new UserError('Запрос с другого сайта запрещён.', 403);
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method;
      if (url.pathname === '/api/bootstrap' && method === 'GET') {
        const config = store.config(); return json(res, { config, runs: store.list(), cursor: store.cursor(), cli: { available: !!executable(config.cli.command), command: config.cli.command }, dataDirectory: store.directory });
      }
      if (url.pathname === '/api/config' && method === 'PUT') { store.saveConfig(configurationSchema.parse(await body(req))); return json(res, store.config()); }
      if (url.pathname === '/api/events' && method === 'GET') {
        const cursor = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new UserError('Некорректный курсор.');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
        const send = (e: AppEvent) => { if (res.writableLength > 1024 * 1024) { res.destroy(); return; } res.write(`id: ${e.id}\nevent: change\ndata: ${JSON.stringify(e)}\n\n`); };
        streams.add(res);
        const events = store.eventsAfter(cursor);
        if (events.length > 1000 || cursor > store.cursor()) res.write(`id: ${store.cursor()}\nevent: reset\ndata: {}\n\n`);
        else events.forEach(send);
        res.write(': connected\n\n');
        store.changes.on('change', send);
        const timer = setInterval(() => res.write(': heartbeat\n\n'), 15000); timer.unref();
        res.on('close', () => { clearInterval(timer); store.changes.off('change', send); streams.delete(res); }); return;
      }
      if (parts[0] === 'api' && parts[1] === 'runs') {
        if (parts.length === 2 && method === 'POST') return json(res, engine.create(await body(req)), 201);
        const id = parts[2];
        if (parts.length === 3 && method === 'GET') return json(res, store.get(id));
        if (parts.length === 4 && parts[3] === 'report' && method === 'GET') {
          const report = runReport(store, id);
          const content = await compress(JSON.stringify(report, null, 2));
          const filename = `teamytime-run-${id.replace(/[^a-zA-Z0-9-]/g, '_')}.json.gz`;
          res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
          res.end(content); return;
        }
        if (parts.length === 4 && method === 'POST') {
          if (parts[3] === 'messages') return json(res, engine.send(id, await body(req)));
          if (parts[3] === 'control') return json(res, engine.control(id, (await body(req)).action));
        }
        if (parts.length === 5 && method === 'POST') {
          if (parts[3] === 'turns') return json(res, engine.resolveTurn(id, parts[4], (await body(req)).action));
          if (parts[3] === 'decisions') return json(res, engine.decide(id, parts[4], (await body(req)).action));
        }
        if (parts.length === 5 && parts[3] === 'artifacts' && method === 'GET') {
          const a = store.get(id).artifacts.find(a => a.id === parts[4]); if (!a) throw new UserError('Результат не найден.', 404);
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="result.md"; filename*=UTF-8''${encodeURIComponent(a.title.replace(/[\r\n/\\]/g, '_'))}` }); res.end(a.content); return;
        }
      }
      if (method === 'GET' && ['/', '/app.js', '/app.css', '/favicon.svg'].includes(url.pathname)) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
        const content = await readFile(path.join(webDirectory, file));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' }); res.end(content); return;
      }
      throw new UserError('Не найдено.', 404);
    })().catch(error => {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof ZodError) return json(res, { error: 'Проверьте поля формы: ' + error.issues.map(i => `${i.path.join('.')}: ${i.message}`).slice(0, 3).join('; ') }, 400);
      if (error instanceof UserError) return json(res, { error: error.message }, error.status);
      console.error('Request failed:', error instanceof Error ? error.message : 'unknown');
      json(res, { error: 'Ошибка сервера. Подробности в терминале.' }, 500);
    });
  });
  return { server, closeStreams() { for (const res of streams) res.end(); } };
}
