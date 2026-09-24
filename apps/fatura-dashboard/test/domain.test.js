import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAmountToCents } from '../public/core/money.js';
import { parseInstallment, merchantKey } from '../public/core/merchant.js';
import { parseCsv } from '../public/core/csv.js';
import { nubank } from '../public/core/banks/nubank.js';
import { BANKS, detectBank } from '../public/core/banks/index.js';
import { hashId } from '../public/core/hash.js';
import { autoCategory, resolveCategory } from '../public/core/categorizer.js';
import { installments, addMonths, buildDashboard } from '../public/core/analytics.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('valores pt-BR viram centavos exatos', () => {
  assert.equal(parseAmountToCents('146,37'), 14637);
  assert.equal(parseAmountToCents('- 3.680,70'), -368070);
  assert.equal(parseAmountToCents('1.234.567,8'), 123456780);
  assert.equal(parseAmountToCents('12.5'), 1250);
  assert.equal(parseAmountToCents('R$ 7,00'), 700);
  assert.throws(() => parseAmountToCents('abc'));
});

test('extrai parcela e normaliza o estabelecimento', () => {
  assert.deepEqual(parseInstallment('Vila Verde Centro Auto - Parcela 1/10'), {
    baseTitle: 'Vila Verde Centro Auto', installment: { current: 1, total: 10 },
  });
  assert.equal(parseInstallment('Posto Felicita').installment, null);
  assert.equal(merchantKey('Farmácia Dro*Nissei*86 - Parcela 2/3'), 'farmacia dro nissei 86');
  assert.equal(merchantKey('Loja Virus - Parcela 6/10'), merchantKey('Loja Virus - Parcela 7/10'));
});

test('parser de CSV respeita aspas e vírgulas internas', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","1,5"\n'), [['a', 'b'], ['x, y', '1,5']]);
});

test('mês de referência vem do nome do arquivo', () => {
  assert.equal(nubank.monthFromFilename('Nubank_2026-10-02.csv'), '2026-10');
  assert.equal(nubank.monthFromFilename('fatura.csv'), null);
});

test('importa a fatura: créditos separados e ids estáveis para duplicatas', () => {
  const { transactions, errors } = nubank.parse(fixture('Nubank_2026-10-02.csv'), '2026-10');
  assert.equal(errors.length, 0);
  assert.equal(transactions.length, 10);
  assert.equal(transactions.filter((t) => t.kind === 'credit').length, 1);
  const ubers = transactions.filter((t) => t.merchantKey.startsWith('uber'));
  assert.equal(ubers.length, 2);
  assert.notEqual(ubers[0].id, ubers[1].id);
  const again = nubank.parse(fixture('Nubank_2026-10-02.csv'), '2026-10').transactions;
  assert.deepEqual(again.map((t) => t.id), transactions.map((t) => t.id));
});

test('registro de bancos: Nubank ativo, Banco do Brasil em breve', () => {
  assert.deepEqual(BANKS.map((b) => [b.id, b.status]), [['nubank', 'active'], ['bb', 'soon']]);
  assert.equal(detectBank(fixture('Nubank_2026-10-02.csv'), 'fatura.csv').id, 'nubank');
  assert.throws(() => BANKS[1].parse('x', '2026-10'), /ainda não está disponível/);
});

test('hash de id é estável e com 16 hex', () => {
  assert.equal(hashId('abc'), hashId('abc'));
  assert.notEqual(hashId('abc'), hashId('abd'));
  assert.match(hashId('abc'), /^[0-9a-f]{16}$/);
});

test('linhas inválidas viram aviso, não quebram a importação', () => {
  const { transactions, errors } = nubank.parse('date,title,amount\n2026-01-01,Ok,"1,00"\nlixo,X,Y\n', '2026-01');
  assert.equal(transactions.length, 1);
  assert.equal(errors.length, 1);
});

test('categorização automática por palavra-chave', () => {
  const cases = {
    'Posto Felicita': 'Combustível',
    'Festival Santa Felicid': 'Mercado',
    'Mercadolivre*Mercadol': 'Compras Online',
    'Ifd*Wikimaki Batel': 'Delivery',
    'Uber Uber *Trip Help.U': 'Transporte',
    'Armazem Garagem Bar': 'Restaurantes & Bares',
    'Farmacia Nissei': 'Saúde & Bem-estar',
    'Dl*Starlink Braz': 'Assinaturas & Serviços',
    'Vila Verde Centro Auto - Parcela 1/10': 'Automóvel',
    'Nuv*Almarejoias - Parcela 1/5': 'Vestuário & Acessórios',
    Ticketmais: 'Lazer & Eventos',
    '50085420joao': 'Pessoas / Pix',
    Henriquepereira: 'Outros',
  };
  for (const [title, expected] of Object.entries(cases)) assert.equal(autoCategory(title), expected, title);
});

test('prioridade: manual > regra do estabelecimento > automático', () => {
  const tx = { title: 'Henriquepereira', merchantKey: 'henriquepereira', categoryOverride: null };
  const rules = new Map([['henriquepereira', 'Pessoas / Pix']]);
  assert.deepEqual(resolveCategory(tx, new Map()), { category: 'Outros', source: 'auto' });
  assert.deepEqual(resolveCategory(tx, rules), { category: 'Pessoas / Pix', source: 'regra' });
  assert.deepEqual(resolveCategory({ ...tx, categoryOverride: 'Lazer & Eventos' }, rules), { category: 'Lazer & Eventos', source: 'manual' });
});

test('parcelas: projeção do comprometido nos próximos meses', () => {
  assert.equal(addMonths('2026-11', 3), '2027-02');
  const expenses = [
    { id: 'a', baseTitle: 'A', category: 'X', amountCents: 1000, installmentCurrent: 1, installmentTotal: 3 },
    { id: 'b', baseTitle: 'B', category: 'X', amountCents: 500, installmentCurrent: 2, installmentTotal: 2 },
    { id: 'c', baseTitle: 'C', category: 'X', amountCents: 9999, installmentCurrent: null, installmentTotal: null },
  ];
  const r = installments(expenses, '2026-10');
  assert.equal(r.thisMonthCents, 1500);
  assert.equal(r.futureCommittedCents, 2000);
  assert.equal(r.finishingNow, 1);
  assert.equal(r.newPurchases, 1);
  assert.deepEqual(r.projection, [
    { month: '2026-11', totalCents: 1000, count: 1 },
    { month: '2026-12', totalCents: 1000, count: 1 },
  ]);
});

test('dashboard compara com o mês anterior', () => {
  const mk = (month, amountCents, category = 'Mercado') => ({
    id: `${month}${amountCents}`, month, date: `${month}-01`, title: 'X', baseTitle: 'X', merchantKey: 'x',
    amountCents, kind: amountCents < 0 ? 'credit' : 'expense', category, installmentCurrent: null, installmentTotal: null,
  });
  const d = buildDashboard({
    month: '2026-10',
    transactions: [mk('2026-10', 3000), mk('2026-10', -5000)],
    previous: { month: '2026-09', transactions: [mk('2026-09', 2000)] },
    previousKeys: new Map([['x', 1]]),
  });
  assert.equal(d.summary.totalCents, 3000);
  assert.equal(d.summary.creditsCents, 5000);
  assert.equal(d.comparison.deltaCents, 1000);
  assert.equal(d.categories[0].deltaCents, 1000);
  assert.equal(d.recurring.length, 1);
});
