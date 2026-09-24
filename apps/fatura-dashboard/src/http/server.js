// Servidor HTTP mínimo (node:http): API JSON em /api/* e arquivos estáticos de /public.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { normalize, extname, resolve, sep } from 'node:path';
import { ValidationError } from '../service.js';

const MAX_BODY = 5 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const MONTH_RE = /^\d{4}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new HttpError(413, 'Arquivo grande demais (máx. 5 MB)'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)) || '{}');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'JSON inválido');
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function routes(service) {
  // [método, regex, handler(req, params, url)]
  return [
    ['GET', /^\/api\/months$/, () => service.listMonths()],
    ['POST', /^\/api\/import$/, async (req, _p, url) => {
      const month = url.searchParams.get('month') || null;
      if (month && !MONTH_RE.test(month)) throw new HttpError(400, 'Mês inválido (AAAA-MM)');
      return service.importCsv({ text: await readBody(req), filename: url.searchParams.get('filename'), month });
    }],
    ['GET', /^\/api\/months\/(\d{4}-\d{2})$/, (_r, [month]) => {
      const d = service.dashboard(month);
      if (!d) throw new HttpError(404, 'Fatura não encontrada');
      return d;
    }],
    ['DELETE', /^\/api\/months\/(\d{4}-\d{2})$/, (_r, [month]) => {
      if (!service.deleteMonth(month)) throw new HttpError(404, 'Fatura não encontrada');
      return { ok: true };
    }],
    ['GET', /^\/api\/history$/, () => service.history()],
    ['GET', /^\/api\/transactions$/, (_r, _p, url) => {
      const month = url.searchParams.get('month');
      if (month && !MONTH_RE.test(month)) throw new HttpError(400, 'Mês inválido (AAAA-MM)');
      return service.transactions(month);
    }],
    ['GET', /^\/api\/transactions$/, (_r, _p, url) => {
      const month = url.searchParams.get('month');
      if (month && !MONTH_RE.test(month)) throw new HttpError(400, 'Mês inválido (AAAA-MM)');
      return service.transactions(month);
    }],
    ['PATCH', /^\/api\/transactions\/([a-f0-9]{16})$/, async (req, [id]) => {
      const updated = service.updateCategory(id, await readJson(req));
      if (!updated) throw new HttpError(404, 'Lançamento não encontrado');
      return updated;
    }],
    ['GET', /^\/api\/categories$/, () => service.categories()],
    ['POST', /^\/api\/categories$/, async (req) => service.addCategory((await readJson(req)).name)],
    ['GET', /^\/api\/rules$/, () => service.rules()],
    ['DELETE', /^\/api\/rules\/(.+)$/, (_r, [key]) => {
      if (!service.deleteRule(decodeURIComponent(key))) throw new HttpError(404, 'Regra não encontrada');
      return { ok: true };
    }],
  ];
}

export function createApp(service, publicDir) {
  const table = routes(service);
  const root = resolve(publicDir);

  async function serveStatic(pathname, res) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = resolve(root, normalize(rel));
    if (file !== root && !file.startsWith(root + sep)) throw new HttpError(403, 'Proibido');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      throw new HttpError(404, 'Não encontrado');
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        for (const [method, re, handler] of table) {
          const m = url.pathname.match(re);
          if (m && req.method === method) return send(res, 200, await handler(req, m.slice(1), url));
        }
        throw new HttpError(404, 'Rota não encontrada');
      }
      if (req.method !== 'GET') throw new HttpError(405, 'Método não permitido');
      await serveStatic(url.pathname, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof ValidationError ? 400 : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Erro interno' : e.message });
    }
  });
}

