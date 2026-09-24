import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createService } from '../public/core/service.js';
import { createStore, memoryStorage } from '../public/core/store.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const storage = memoryStorage();
const svc = createService(createStore(storage));

test('fluxo completo: importar, corrigir categoria, regra vale para o próximo mês', () => {
  const r = svc.importCsv({ text: fixture('Nubank_2026-09-02.csv'), filename: 'Nubank_2026-09-02.csv' });
  assert.deepEqual([r.bank, r.month, r.replaced], ['nubank', '2026-09', false]);

  const fulano = svc.dashboard('2026-09').transactions.find((t) => t.title === 'Fulanodetal');
  assert.equal(fulano.category, 'Outros');
  const updated = svc.updateCategory(fulano.id, { category: 'Pessoas / Pix', scope: 'merchant' });
  assert.equal(updated.category, 'Pessoas / Pix');
  assert.equal(updated.categorySource, 'regra');

  // Próxima fatura: a mesma despesa já chega categorizada.
  svc.importCsv({ text: fixture('Nubank_2026-10-02.csv'), filename: 'Nubank_2026-10-02.csv' });
  const dash = svc.dashboard('2026-10');
  const next = dash.transactions.find((t) => t.title === 'Fulanodetal');
  assert.equal(next.category, 'Pessoas / Pix');
  assert.equal(next.categorySource, 'regra');

  assert.equal(dash.summary.totalCents, 18990 + 1250 + 1250 + 17223 + 5000 + 3290 + 7215 + 25000 + 10000);
  assert.equal(dash.comparison.month, '2026-09');
  assert.equal(dash.installments.futureCommittedCents, 9 * 25000);
  assert.ok(dash.recurring.some((x) => x.merchantKey === 'apple com bill'));

  assert.deepEqual(svc.listMonths().map((m) => m.month), ['2026-10', '2026-09']);
  assert.equal(svc.history().months.length, 2);
  assert.equal(svc.transactions().length, 16);
});

test('dados persistem no storage (recarregar a página)', () => {
  const reloaded = createService(createStore(storage));
  assert.deepEqual(reloaded.listMonths().map((m) => m.month), ['2026-10', '2026-09']);
  assert.equal(reloaded.rules().length, 1);
});

test('correção pontual sobrevive à reimportação da mesma fatura', () => {
  const uber = svc.dashboard('2026-10').transactions.find((t) => t.merchantKey.startsWith('uber'));
  svc.updateCategory(uber.id, { category: 'Viagem', scope: 'single' });
  const r = svc.importCsv({ text: fixture('Nubank_2026-10-02.csv'), filename: 'Nubank_2026-10-02.csv' });
  assert.equal(r.replaced, true);
  const after = svc.dashboard('2026-10').transactions;
  assert.equal(after.find((t) => t.id === uber.id).category, 'Viagem');
  assert.equal(after.filter((t) => t.merchantKey.startsWith('uber') && t.category === 'Transporte').length, 1);
});

test('validações', () => {
  assert.throws(() => svc.importCsv({ text: 'date,title,amount\n', filename: 'x.csv', month: '2026-01' }));
  assert.throws(() => svc.importCsv({ text: 'a', filename: 'x.csv' }), /mês/);
  assert.throws(() => svc.importCsv({ text: 'a', filename: 'x.csv', month: '2026-01', bank: 'bb' }), /ainda não disponível/);
  assert.equal(svc.dashboard('2020-01'), null);
  assert.equal(svc.updateCategory('0000000000000000', { category: 'X', scope: 'merchant' }), null);
  assert.throws(() => svc.updateCategory('x', { category: '', scope: 'merchant' }));
});

test('backup: exportar e restaurar em outro navegador', () => {
  const backup = svc.exportBackup();
  const other = createService(createStore(memoryStorage()));
  other.importBackup(JSON.parse(JSON.stringify(backup)));
  assert.equal(other.transactions().length, svc.transactions().length);
  assert.throws(() => other.importBackup({ version: 99 }));
  assert.equal(other.transactions().length, svc.transactions().length);
});

test('excluir fatura mantém as regras', () => {
  assert.equal(svc.deleteStatement('nubank', '2026-09'), true);
  assert.equal(svc.rules().length, 1);
  assert.equal(svc.listMonths().length, 1);
});
