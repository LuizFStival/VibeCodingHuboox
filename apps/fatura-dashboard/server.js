import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openRepository } from './src/db/repository.js';
import { createService } from './src/service.js';
import { createApp } from './src/http/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3333);
const HOST = process.env.HOST ?? '127.0.0.1'; // só local: são dados financeiros pessoais
const DB_FILE = process.env.DB_FILE ?? join(here, 'data', 'financas.db');

const repo = openRepository(DB_FILE);
const app = createApp(createService(repo), join(here, 'public'));

app.listen(PORT, HOST, () => {
  console.log(`Fatura Dashboard rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Banco de dados: ${DB_FILE}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    app.close();
    repo.close();
    process.exit(0);
  });
}
