// Servidor estático mínimo só para rodar localmente (na Vercel quem serve é a CDN).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = fileURLToPath(new URL('../public', import.meta.url));
const PORT = Number(process.env.PORT ?? 3333);
// Mesmos cabeçalhos de segurança da Vercel, para o ambiente local se comportar igual.
const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const HEADERS = Object.fromEntries(vercel.headers[0].headers.map((h) => [h.key, h.value]));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const file = resolve(root, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`);
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...HEADERS, 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('Não encontrado');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Fatura Dashboard em http://127.0.0.1:${PORT}`));
