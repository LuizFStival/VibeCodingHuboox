import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openRepository } from '../src/db/repository.js';
import { createService } from '../src/service.js';
import { createApp } from '../src/http/server.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
let server;
let base;

before(async () => {
  const repo = openRepository(':memory:');
  server = createApp(createService(repo), fileURLToPath(new URL('../public', import.meta.url)));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body, type = 'application/json') => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': type } : {},
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('fluxo completo: importar, corrigir categoria, regra vale para o próximo mês', async () => {
  let r = await call('POST', '/api/import?filename=Nubank_2026-09-02.csv', fixture('Nubank_2026-09-02.csv'), 'text/csv');
  assert.equal(r.status, 200);
  assert.equal(r.body.month, '2026-09');

  let dash = (await call('GET', '/api/months/2026-09')).body;
  const fulano = dash.transactions.find((t) => t.title === 'Fulanodetal');
  assert.equal(fulano.category, 'Outros');

  r = await call('PATCH', `/api/transactions/${fulano.id}`, { category: 'Pessoas / Pix', scope: 'merchant' });
  assert.equal(r.status, 200);
  assert.equal(r.body.category, 'Pessoas / Pix');
  assert.equal(r.body.categorySource, 'regra');

  // Próxima fatura: a mesma despesa já chega categorizada.
  await call('POST', '/api/import?filename=Nubank_2026-10-02.csv', fixture('Nubank_2026-10-02.csv'), 'text/csv');
  dash = (await call('GET', '/api/months/2026-10')).body;
  const next = dash.transactions.find((t) => t.title === 'Fulanodetal');
  assert.equal(next.category, 'Pessoas / Pix');
  assert.equal(next.categorySource, 'regra');

  assert.equal(dash.summary.totalCents, 18990 + 1250 + 1250 + 17223 + 5000 + 3290 + 7215 + 25000 + 10000);
  assert.equal(dash.comparison.month, '2026-09');
  assert.equal(dash.installments.futureCommittedCents, 9 * 25000);
  assert.ok(dash.recurring.some((x) => x.merchantKey === 'apple com bill'));

  const months = (await call('GET', '/api/months')).body;
  assert.deepEqual(months.map((m) => m.month), ['2026-10', '2026-09']);
  const hist = (await call('GET', '/api/history')).body;
  assert.equal(hist.months.length, 2);
  const all = (await call('GET', '/api/transactions')).body;
  assert.equal(all.length, 16);
});

test('correção pontual sobrevive à reimportação da mesma fatura', async () => {
  const dash = (await call('GET', '/api/months/2026-10')).body;
  const uber = dash.transactions.find((t) => t.merchantKey.startsWith('uber'));
  await call('PATCH', `/api/transactions/${uber.id}`, { category: 'Viagem', scope: 'single' });
  const r = await call('POST', '/api/import?filename=Nubank_2026-10-02.csv', fixture('Nubank_2026-10-02.csv'), 'text/csv');
  assert.equal(r.body.replaced, true);
  const after = (await call('GET', '/api/months/2026-10')).body.transactions;
  assert.equal(after.find((t) => t.id === uber.id).category, 'Viagem');
  assert.equal(after.filter((t) => t.merchantKey.startsWith('uber') && t.category === 'Transporte').length, 1);
});

test('validação e erros', async () => {
  assert.equal((await call('POST', '/api/import?filename=x.csv', 'date,title,amount\n', 'text/csv')).status, 400);
  assert.equal((await call('POST', '/api/import?month=2026-13x', 'a', 'text/csv')).status, 400);
  assert.equal((await call('GET', '/api/months/2020-01')).status, 404);
  assert.equal((await call('PATCH', '/api/transactions/0000000000000000', { category: 'X', scope: 'merchant' })).status, 404);
  assert.equal((await call('GET', '/../package.json')).status, 404);
  assert.notEqual((await call('GET', '/%2e%2e/package.json')).status, 200);
  assert.notEqual((await call('GET', '/..%2fpackage.json')).status, 200);
});

test('excluir fatura mantém as regras', async () => {
  assert.equal((await call('DELETE', '/api/months/2026-09')).status, 200);
  const rules = (await call('GET', '/api/rules')).body;
  assert.equal(rules.length, 1);
  assert.equal((await call('GET', '/api/months')).body.length, 1);
});
