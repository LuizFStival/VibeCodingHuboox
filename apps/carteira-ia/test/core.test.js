import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectMonth, detectType, normalizeReport, parseNumber, upside, reportStats } from '../public/core/report.js';
import { parseJsonLoose, createGemini } from '../public/core/gemini.js';
import { normalizeAnalysis } from '../public/core/prompts.js';
import { allocate, planAporte, comparePortfolio, classifyTicker } from '../public/core/portfolio.js';
import { createService } from '../public/core/service.js';
import { createStore, memoryStorage } from '../public/core/store.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('tipo e mês pelo nome do arquivo', () => {
  assert.equal(detectType('Carteira_Fiis_-_Outubro26.pdf'), 'fiis');
  assert.equal(detectType('Carteira_Internacional_-_Outubro26.pdf'), 'internacional');
  assert.equal(detectType('Carteira_Ações_-_Outubro26.pdf'), 'acoes');
  assert.equal(detectType('d248989a-Carteira_A__es_-_Outubro26.pdf'), 'acoes');
  assert.equal(detectType('relatorio.pdf'), null);
  assert.equal(detectMonth('Carteira_Fiis_-_Outubro26.pdf'), '2026-10');
  assert.equal(detectMonth('carteira-dezembro-2025.pdf'), '2025-12');
  assert.equal(detectMonth('acoes_2027-01.pdf'), '2027-01');
  assert.equal(detectMonth('sem-data.pdf'), null);
});

test('números em formato brasileiro', () => {
  assert.equal(parseNumber('R$ 1.234,56'), 1234.56);
  assert.equal(parseNumber('5,26%'), 5.26);
  assert.equal(parseNumber('US$ 707.54'), 707.54);
  assert.equal(parseNumber('*'), null);
  assert.equal(parseNumber(12), 12);
});

test('normaliza relatório extraído', () => {
  const r = normalizeReport(fixture('acoes.json'), { type: 'acoes', month: '2026-10' });
  assert.equal(r.assets.length, 5);
  const itau = r.assets.find((a) => a.ticker === 'AAAA3');
  assert.equal(itau.weight, 0.4);
  assert.equal(itau.dy, 0.065);
  assert.equal(itau.rec, 'COMPRAR');
  // venda zera o peso mesmo se o PDF trouxer algum
  assert.equal(r.assets.find((a) => a.ticker === 'EEEE3').weight, 0);
  assert.ok(Math.abs(upside(itau) - (60 / 50 - 1)) < 1e-9);
  const st = reportStats(r);
  assert.equal(st.buy, 3);
  assert.equal(st.sell, 1);
  assert.equal(normalizeReport({ assets: [{ ticker: 'US:VOO', allocationPct: 10, recommendation: 'Comprar' }] }, { type: 'internacional', month: '2026-10' }).assets[0].ticker, 'VOO');
  assert.throws(() => normalizeReport({ assets: [] }, { type: 'acoes', month: '2026-10' }), /Nenhum ativo/);
});

test('JSON da IA com cercas e texto em volta', () => {
  assert.deepEqual(parseJsonLoose('Aqui está:\n```json\n{"a": [1, "}"]}\n```\nfim'), { a: [1, '}'] });
  assert.throws(() => parseJsonLoose('{"a": [1, 2'), /incompleto/);
});

test('cliente Gemini monta a requisição e lê fontes', async () => {
  let sent;
  const fakeFetch = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://ex.com/a', title: 'A' } }, { web: { uri: 'javascript:alert(1)' } }] } }] }),
    };
  };
  const g = createGemini({ apiKey: 'k', model: 'gemini-2.5-flash', fetch: fakeFetch });
  const res = await g.generate({ parts: [{ text: 'oi' }], search: true, schema: { type: 'OBJECT' } });
  assert.match(sent.url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(sent.init.headers['x-goog-api-key'], 'k');
  assert.deepEqual(sent.body.tools, [{ google_search: {} }]);
  assert.equal(sent.body.generationConfig.responseSchema, undefined); // schema + search não combinam
  assert.deepEqual(res.json(), { ok: true });
  assert.deepEqual(res.sources, [{ uri: 'https://ex.com/a', title: 'A' }]);

  const bad = createGemini({ apiKey: 'k', fetch: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) }) });
  await assert.rejects(bad.generate({ parts: [{ text: 'x' }] }), /Limite de uso/);
  assert.throws(() => createGemini({ apiKey: '' }), /chave/);
});

test('normaliza análise e ignora tickers não pedidos', () => {
  const a = normalizeAnalysis({ visaoGeral: 'ok', ativos: [
    { ticker: 'AAAA3', veredito: 'Discorda', recomendacaoIA: 'aguardar', precoAtual: '51,2', fundamentos: ['ROE 20%'], noticias: [{ titulo: 'X', impacto: 'Negativo' }] },
    { ticker: 'ZZZZ3', veredito: 'CONCORDA' },
  ] }, ['AAAA3'], [{ uri: 'https://s', title: 's' }]);
  assert.deepEqual(Object.keys(a.items), ['AAAA3']);
  assert.equal(a.items.AAAA3.verdict, 'DISCORDA');
  assert.equal(a.items.AAAA3.aiRec, 'AGUARDAR');
  assert.equal(a.items.AAAA3.price, 51.2);
  assert.equal(a.items.AAAA3.news[0].impact, 'negativo');
});

test('allocate: cobre déficits e divide a sobra pelo peso', () => {
  const r = allocate(100, [{ key: 'a', current: 0, target: 30, weight: 1 }, { key: 'b', current: 50, target: 30, weight: 1 }]);
  assert.equal(r.get('a'), 30 + 35);
  assert.equal(r.get('b'), 35);
  const s = allocate(10, [{ key: 'a', current: 0, target: 30, weight: 1 }, { key: 'b', current: 0, target: 10, weight: 1 }]);
  assert.equal(s.get('a'), 7.5);
  assert.equal(s.get('b'), 2.5);
});

const reports = () => [
  normalizeReport(fixture('acoes.json'), { type: 'acoes', month: '2026-10' }),
  normalizeReport(fixture('internacional.json'), { type: 'internacional', month: '2026-10' }),
];
const settings = { targets: { acoes: 0.5, fiis: 0, internacional: 0.5 }, usdBrl: 5, includeAguardar: false, respectAi: true, fractionalIntl: true };

test('aporte: só COMPRAR, cotas inteiras, respeita veredito da IA', () => {
  const analyses = { CCCC3: { verdict: 'DISCORDA' } };
  const plan = planAporte({ amount: 10000, holdings: [], reports: reports(), analyses, settings });
  const tickers = plan.lines.map((l) => l.ticker);
  assert.ok(!tickers.includes('BBBB3'), 'AGUARDAR não recebe');
  assert.ok(!tickers.includes('CCCC3'), 'IA discorda → não recebe');
  assert.ok(!tickers.includes('EEEE3'), 'VENDER não recebe');
  for (const l of plan.lines.filter((x) => x.type === 'acoes')) assert.equal(l.qty, Math.round(l.qty));
  assert.ok(plan.invested <= 10000 + 1e-6);
  assert.ok(plan.leftover < 50, `sobra pequena: ${plan.leftover}`);
  const acoes = plan.classes.find((c) => c.type === 'acoes');
  assert.ok(Math.abs(acoes.pctAfter - 0.5) < 0.02);

  const loose = planAporte({ amount: 10000, holdings: [], reports: reports(), analyses, settings: { ...settings, respectAi: false, includeAguardar: true } });
  assert.ok(loose.lines.some((l) => l.ticker === 'BBBB3'));
  assert.ok(loose.lines.some((l) => l.ticker === 'CCCC3'));
});

test('aporte vai para a classe abaixo do alvo', () => {
  const holdings = [{ id: '1', ticker: 'AAAA3', type: 'acoes', qty: 200, avgPrice: 40 }]; // R$ 10.000 em ações
  const plan = planAporte({ amount: 5000, holdings, reports: reports(), analyses: {}, settings });
  const intl = plan.classes.find((c) => c.type === 'internacional');
  assert.ok(intl.added > 4900, `internacional recebe quase tudo: ${intl.added}`);
  const cmp = comparePortfolio({ holdings: [...holdings, { id: '2', ticker: 'EEEE3', type: 'acoes', qty: 10 }], reports: reports(), analyses: {}, settings });
  assert.ok(cmp.alerts.some((a) => a.kind === 'vender' && a.ticker === 'EEEE3'));
  assert.ok(cmp.alerts.some((a) => a.kind === 'falta' && a.tickers.includes('DDDD3')));
});

test('classificação de tickers sem relatório', () => {
  assert.equal(classifyTicker('HGLG11'), 'fiis');
  assert.equal(classifyTicker('PETR4'), 'acoes');
  assert.equal(classifyTicker('VOO'), 'internacional');
});

test('serviço: extrai com Gemini fake, analisa em lotes, importa carteira e planeja', async () => {
  const svc = createService(createStore(memoryStorage()));
  const calls = [];
  const fake = {
    model: 'fake',
    async generate(req) {
      calls.push(req);
      if (req.schema) return { json: () => fixture('acoes.json'), sources: [] };
      const tickers = [...req.parts[0].text.matchAll(/"ticker":"([A-Z0-9]+)"/g)].map((m) => m[1]);
      return { json: () => ({ visaoGeral: 'cenário', ativos: tickers.map((t) => ({ ticker: t, veredito: t === 'DDDD3' ? 'DISCORDA' : 'CONCORDA' })) }), sources: [{ uri: 'https://n', title: 'n' }] };
    },
  };
  const r = await svc.extractReport(fake, { images: [{ mimeType: 'image/jpeg', data: 'AA==' }], type: 'acoes', month: '2026-10', filename: 'a.pdf' });
  assert.equal(r.id, '2026-10:acoes');
  assert.equal(calls[0].parts[1].inlineData.mimeType, 'image/jpeg');
  assert.deepEqual(svc.months(), ['2026-10']);

  const progress = [];
  const an = await svc.analyzeReport(fake, r.id, { onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(calls.length, 1 + 1); // 5 ativos = 1 lote
  assert.equal(an.errors.length, 0);
  assert.equal(svc.analysesFor('2026-10').DDDD3.verdict, 'DISCORDA');
  assert.deepEqual(progress.at(-1), [5, 5]);

  const imp = svc.importHoldingsText('Ticker;Qtd;PM\nAAAA3;100;45,10\nHGLG11 10 150\nVOO,2,600\nlixo');
  assert.equal(imp.count, 3);
  assert.deepEqual(svc.holdings().map((h) => [h.ticker, h.type, h.qty]), [['AAAA3', 'acoes', 100], ['HGLG11', 'fiis', 10], ['VOO', 'internacional', 2]]);

  svc.importReportJson(fixture('internacional.json'));
  svc.updateSettings({ targets: { acoes: 0.5, fiis: 0, internacional: 0.5 } });
  const plan = svc.plan('2026-10', 3000);
  assert.ok(plan.lines.length > 0);
  assert.ok(!plan.lines.some((l) => l.ticker === 'DDDD3'));

  // backup não leva a chave da API
  const store = createStore(memoryStorage());
  store.apiKey = 'segredo';
  const svc2 = createService(store);
  assert.ok(!svc2.exportBackup().includes('segredo'));
});
