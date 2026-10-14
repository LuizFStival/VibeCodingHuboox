import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectMonth, detectType, normalizeReport, parseNumber, upside, reportStats } from '../public/core/report.js';
import { parseJsonLoose, createGemini } from '../public/core/gemini.js';
import { createService as createSvc } from '../public/core/service.js';
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
  const g = createGemini({ apiKey: 'k', model: 'gemini-2.5-flash', fetch: fakeFetch, minIntervalMs: 0 });
  const res = await g.generate({ parts: [{ text: 'oi' }], search: true, schema: { type: 'OBJECT' } });
  assert.match(sent.url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(sent.init.headers['x-goog-api-key'], 'k');
  assert.deepEqual(sent.body.tools, [{ google_search: {} }]);
  assert.equal(sent.body.generationConfig.responseSchema, undefined); // schema + search não combinam
  assert.deepEqual(res.json(), { ok: true });
  assert.deepEqual(res.sources, [{ uri: 'https://ex.com/a', title: 'A' }]);

  assert.equal(res.searched, true);
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

  const loose = planAporte({ amount: 10000, holdings: [], reports: reports(), analyses, settings: { ...settings, respectAi: false, includeAguardar: true, respectCeiling: false } });
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
      return { json: () => ({ visaoGeral: 'cenário', ativos: tickers.map((t) => ({ ticker: t, veredito: t === 'DDDD3' ? 'DISCORDA' : 'CONCORDA' })) }), sources: [{ uri: 'https://n', title: 'n' }], searched: true };
    },
  };
  const r = await svc.extractReport(fake, { images: [{ mimeType: 'image/jpeg', data: 'AA==' }], type: 'acoes', month: '2026-10', filename: 'a.pdf' });
  assert.equal(r.id, '2026-10:acoes');
  assert.equal(calls[0].parts[1].text, 'Página 1');
  assert.equal(calls[0].parts[2].inlineData.mimeType, 'image/jpeg');
  assert.equal(calls[0].fast, true);
  assert.equal(calls[0].parallel, true);
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

// ---------------------------------------------------------------- robustez da API

const okBody = (text, grounding) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] }, groundingMetadata: grounding }] }) });
const errBody = (status, error) => ({ ok: false, status, json: async () => ({ error }) });
const rateErr = { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded. Please retry in 7.2s.', details: [
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }] };
const dailyErr = { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded', details: [
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] };

test('429 por minuto: espera o retryDelay da API e tenta de novo', async () => {
  const waits = []; const retries = [];
  let n = 0;
  const g = createGemini({ apiKey: 'k', minIntervalMs: 0, sleep: async (ms) => { waits.push(ms); }, fetch: async () => (++n < 3 ? errBody(429, rateErr) : okBody('{"ok":1}')) });
  const res = await g.generate({ parts: [{ text: 'x' }], onRetry: (m) => retries.push(m) });
  assert.deepEqual(res.json(), { ok: 1 });
  assert.equal(n, 3);
  assert.deepEqual(waits, [7500, 7500]);
  assert.match(retries[0], /por minuto.*8 s/);
});

test('cota diária, modelo inexistente e erro 5xx', async () => {
  const sleep = async () => {};
  let calls = 0;
  const daily = createGemini({ apiKey: 'k', minIntervalMs: 0, sleep, fetch: async () => { calls++; return errBody(429, dailyErr); } });
  await assert.rejects(daily.generate({ parts: [{ text: 'x' }] }), (e) => e.daily && /diária/.test(e.message));
  assert.equal(calls, 1, 'não insiste quando a cota do dia acabou');
  const missing = createGemini({ apiKey: 'k', model: 'gemini-velho', minIntervalMs: 0, sleep, fetch: async () => errBody(404, { message: 'models/gemini-velho is not found' }) });
  await assert.rejects(missing.generate({ parts: [{ text: 'x' }] }), (e) => e.status === 404 && /gemini-velho/.test(e.message));
  let k = 0;
  const flaky = createGemini({ apiKey: 'k', minIntervalMs: 0, sleep, fetch: async () => (++k === 1 ? errBody(503, { message: 'overloaded' }) : okBody('ok')) });
  assert.equal((await flaky.generate({ parts: [{ text: 'x' }] })).text, 'ok');
});

test('fila: uma requisição por vez, com intervalo mínimo', async () => {
  let active = 0; let maxActive = 0;
  const g = createGemini({ apiKey: 'k', minIntervalMs: 0, fetch: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 5)); active--; return okBody('ok'); } });
  await Promise.all([1, 2, 3].map(() => g.generate({ parts: [{ text: 'x' }] })));
  assert.equal(maxActive, 1);
});

test('análise: texto livre vira JSON, cota no meio salva progresso e dá para continuar', async () => {
  const svc = createSvc(createStore(memoryStorage()));
  svc.importReportJson({ ...fixture('acoes.json'), type: 'acoes', month: '2026-10', assets: [...fixture('acoes.json').assets, { ticker: 'FFFF3', allocationPct: 5, recommendation: 'COMPRAR' }, { ticker: 'GGGG3', allocationPct: 5, recommendation: 'COMPRAR' }] });
  const id = '2026-10:acoes';
  let quotaLeft = 1;
  const fake = {
    model: 'fake',
    async generate(req) {
      if (req.schema) { // segunda chamada: estruturar o texto
        const tickers = [...req.parts[0].text.matchAll(/\b([A-Z]{4}3)\b/g)].map((m) => m[1]);
        return { json: () => ({ ativos: [...new Set(tickers)].map((t) => ({ ticker: t, veredito: 'CONCORDA', resumo: 'ok' })) }) };
      }
      if (quotaLeft-- <= 0) { const e = new Error('Cota diária esgotada'); e.daily = true; e.status = 429; throw e; }
      const tickers = [...req.parts[0].text.matchAll(/"ticker":"([A-Z0-9]+)"/g)].map((m) => m[1]).filter((t) => t !== 'XXXX3');
      return { text: `Análise em texto: ${tickers.join(', ')} parecem bons.`, sources: [{ uri: 'https://x', title: 'x' }], searched: true, queries: ['q'], json: () => { throw new Error('A IA não devolveu JSON.'); } };
    },
  };
  const first = await svc.analyzeReport(fake, id);
  assert.equal(Object.keys(first.items).length, 5, 'primeiro lote estruturado a partir do texto');
  assert.match(first.fatal, /diária/);
  assert.deepEqual(first.pending, ['FFFF3', 'GGGG3']);
  assert.equal(svc.analysis(id).items.AAAA3.searched, true);
  assert.deepEqual(svc.analysis(id).pending, ['FFFF3', 'GGGG3']);

  quotaLeft = 1;
  const second = await svc.analyzeReport(fake, id, { tickers: svc.analysis(id).pending });
  assert.deepEqual(second.pending, []);
  assert.equal(Object.keys(svc.analysis(id).items).length, 7, 'mantém o que já tinha + o que faltava');
  assert.deepEqual(svc.analysis(id).pending, []);
});

// ---------------------------------------------------------------- modelo desativado

import { pickModel, usefulModels } from '../public/core/gemini.js';

const USER_MODELS = 'gemini-2.5-computer-use-preview-10-2025, gemini-2.5-flash, gemini-2.5-flash-image, gemini-2.5-flash-lite, gemini-2.5-flash-preview-tts, gemini-2.5-pro, gemini-2.5-pro-preview-tts, gemini-3-flash-preview, gemini-3-pro-image, gemini-3-pro-image-preview, gemini-3.1-flash-image, gemini-3.1-flash-image-preview, gemini-3.1-flash-lite, gemini-3.1-flash-lite-image, gemini-3.1-flash-lite-preview, gemini-3.1-flash-tts-preview, gemini-3.1-pro-preview, gemini-3.1-pro-preview-customtools, gemini-3.5-flash, gemini-3.5-flash-lite, gemini-3.5-transcribe, gemini-3.6-flash, gemini-3.7-flash, gemini-3.8-flash, gemini-3.8-flash-lite-tts, gemini-3.8-flash-tts, gemini-4-argon, gemini-flash-latest, gemini-flash-lite-latest, gemini-nano-banana-2.1, gemini-omni-1.1-flash, gemini-omni-flash-preview, gemini-pro-latest, gemini-robotics-er-2-preview'.split(', ');

test('escolhe o modelo certo na lista da chave', () => {
  const useful = usefulModels(USER_MODELS);
  assert.equal(useful[0], 'gemini-flash-latest');
  for (const bad of ['gemini-2.5-flash-image', 'gemini-3.8-flash-tts', 'gemini-3.5-transcribe', 'gemini-robotics-er-2-preview', 'gemini-nano-banana-2.1']) assert.ok(!useful.includes(bad), bad);
  assert.equal(pickModel(USER_MODELS), 'gemini-flash-latest');
  assert.equal(pickModel(USER_MODELS, 'gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(pickModel(USER_MODELS.filter((m) => !m.endsWith('-latest'))), 'gemini-3.8-flash');
});

test('modelo desativado: troca pelo recomendado pela API e repete a chamada', async () => {
  const urls = []; const changes = [];
  const fetch = async (url) => {
    urls.push(url);
    if (!url.includes(':generateContent')) return { ok: true, status: 200, json: async () => ({ models: USER_MODELS.map((m) => ({ name: `models/${m}`, supportedGenerationMethods: ['generateContent'] })) }) };
    if (url.includes('gemini-2.5-flash:')) return errBody(404, { code: 404, status: 'NOT_FOUND', message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements.' });
    return okBody('ok');
  };
  const g = createGemini({ apiKey: 'k', model: 'gemini-2.5-flash', minIntervalMs: 0, sleep: async () => {}, fetch, onModelChange: (n, o) => changes.push([o, n]) });
  const res = await g.generate({ parts: [{ text: 'x' }] });
  assert.equal(res.text, 'ok');
  assert.deepEqual(changes, [['gemini-2.5-flash', 'gemini-3.8-flash']]);
  assert.equal(g.model, 'gemini-3.8-flash');
  assert.match(urls.at(-1), /gemini-3\.8-flash:generateContent/);
});

// ---------------------------------------------------------------- pesquisa sem cota

const searchQuotaErr = { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.' };

test('429 na pesquisa sem tempo de espera = pesquisa sem cota (não insiste)', async () => {
  let calls = 0;
  const g = createGemini({ apiKey: 'k', model: 'gemini-flash-latest', minIntervalMs: 0, sleep: async () => {}, fetch: async () => { calls++; return errBody(429, searchQuotaErr); } });
  await assert.rejects(g.generate({ parts: [{ text: 'x' }], search: true }), (e) => e.searchQuota && !e.retryable && /pesquisa do Google/.test(e.message));
  assert.equal(calls, 1);
});

test('análise segue sem pesquisa quando a chave não tem cota de pesquisa', async () => {
  const svc = createSvc(createStore(memoryStorage()));
  svc.importReportJson({ ...fixture('acoes.json'), type: 'acoes', month: '2026-10', assets: [...fixture('acoes.json').assets, { ticker: 'FFFF3', allocationPct: 5, recommendation: 'COMPRAR' }] });
  const id = '2026-10:acoes';
  let searchCalls = 0;
  const fake = {
    model: 'fake',
    async generate(req) {
      if (req.search) { searchCalls++; const e = new Error('A pesquisa do Google não está liberada'); e.searchQuota = true; throw e; }
      const tickers = [...req.parts[0].text.matchAll(/"ticker":"([A-Z0-9]+)"/g)].map((m) => m[1]).filter((t) => t !== 'XXXX3');
      assert.match(req.parts[0].text, /sem acesso à web/);
      return { json: () => ({ ativos: tickers.map((t) => ({ ticker: t, veredito: 'CONCORDA', resumo: 'ok' })) }), sources: [] };
    },
  };
  const res = await svc.analyzeReport(fake, id);
  assert.equal(searchCalls, 1, 'tenta a pesquisa uma vez só');
  assert.equal(Object.keys(res.items).length, 6);
  assert.deepEqual(res.pending, []);
  assert.equal(svc.analysis(id).items.FFFF3.searched, false);
  assert.match(res.errors[0], /sem pesquisa na web/);
});

// ---------------------------------------------------------------- modo manual (copiar e colar)

test('modo manual: pedido pronto, resposta colada do chat e pedido só dos que faltam', () => {
  const svc = createSvc(createStore(memoryStorage()));
  svc.importReportJson({ ...fixture('acoes.json'), type: 'acoes', month: '2026-10' });
  const id = '2026-10:acoes';
  const first = svc.manualPrompt(id);
  assert.equal(first.count, 5);
  assert.match(first.prompt, /PESQUISE NA WEB/);
  assert.match(first.prompt, /AAAA3/);

  // Resposta típica de chat: texto em volta + bloco ```json, faltando dois ativos.
  const pasted = 'Claro! Segue a análise:\n```json\n' + JSON.stringify({ visaoGeral: 'ok', ativos: [
    { ticker: 'AAAA3', veredito: 'DISCORDA', recomendacaoIA: 'AGUARDAR', resumo: 'caro', fontes: ['https://exemplo.com/a', 'javascript:alert(1)'] },
    { ticker: 'BBBB3', veredito: 'CONCORDA', resumo: 'ok' },
    { ticker: 'CCCC3', veredito: 'PARCIAL', resumo: 'ok' },
    { ticker: 'ZZZZ9', veredito: 'CONCORDA', resumo: 'de outra carteira' },
  ] }) + '\n```\nEspero ter ajudado.';
  const res = svc.importManualAnalysis(id, pasted);
  assert.equal(res.count, 3);
  assert.deepEqual(res.pending, ['DDDD3', 'EEEE3']);
  const a = svc.analysis(id).items.AAAA3;
  assert.equal(a.verdict, 'DISCORDA');
  assert.deepEqual(a.sources.map((s) => s.uri), ['https://exemplo.com/a']);
  assert.equal(a.manual, true);

  const second = svc.manualPrompt(id);
  assert.equal(second.count, 2);
  assert.ok(second.prompt.includes('DDDD3') && !second.prompt.includes('"AAAA3"'));
  svc.importManualAnalysis(id, JSON.stringify([{ ticker: 'DDDD3', veredito: 'CONCORDA', resumo: 'x' }, { ticker: 'EEEE3', veredito: 'CONCORDA', resumo: 'x' }]));
  assert.deepEqual(svc.analysis(id).pending, []);
  assert.equal(Object.keys(svc.analysis(id).items).length, 5);

  assert.throws(() => svc.importManualAnalysis(id, 'não sei responder'), /JSON/);
  assert.throws(() => svc.importManualAnalysis(id, '{"ativos":[{"ticker":"XPTO3"}]}'), /nenhum ativo/);
});

// ---------------------------------------------------------------- conferência e velocidade

import { checkReport } from '../public/core/report.js';
import { thinkingFor } from '../public/core/gemini.js';

test('conferência aponta pesos que não fecham, preço faltando e página não indicada', () => {
  const ok = normalizeReport({ tablePages: [4], assets: [
    { ticker: 'AAAA3', allocationPct: 60, price: 10, ceilingPrice: 12, recommendation: 'COMPRAR', page: 4 },
    { ticker: 'BBBB3', allocationPct: 40, price: 20, ceilingPrice: 22, recommendation: 'AGUARDAR', page: 4 },
  ] }, { type: 'acoes', month: '2026-10' });
  assert.ok(checkReport(ok).every((c) => c.ok), JSON.stringify(checkReport(ok)));
  const bad = normalizeReport({ tablePages: [4], assets: [
    { ticker: 'AAAA3', allocationPct: 60, price: 10, ceilingPrice: 30, recommendation: 'COMPRAR', page: 4 },
    { ticker: 'BBBB3', allocationPct: 20, ceilingPrice: 22, recommendation: 'COMPRAR' },
  ] }, { type: 'acoes', month: '2026-10' });
  const msgs = checkReport(bad).filter((c) => !c.ok).map((c) => c.msg).join(' | ');
  assert.match(msgs, /somam 80\.0%/);
  assert.match(msgs, /Sem preço: BBBB3/);
  assert.match(msgs, /muito distantes.*AAAA3/);
  assert.match(msgs, /página de: BBBB3/);
});

test('leitura rápida: pouco raciocínio, fora da fila, e tenta de novo se o modelo recusar o ajuste', async () => {
  assert.deepEqual(thinkingFor('gemini-2.5-flash'), { thinkingBudget: 0 });
  assert.deepEqual(thinkingFor('gemini-flash-latest'), { thinkingLevel: 'low' });
  const bodies = [];
  const g = createGemini({ apiKey: 'k', model: 'gemini-flash-latest', minIntervalMs: 60_000, sleep: async () => { throw new Error('não deveria esperar'); }, fetch: async (url, init) => {
    const b = JSON.parse(init.body); bodies.push(b);
    if (b.generationConfig.thinkingConfig) return errBody(400, { message: 'Unknown name "thinkingLevel" at generation_config.thinking_config' });
    return okBody('{"ok":1}');
  } });
  const res = await g.generate({ parts: [{ text: 'x' }], fast: true, parallel: true });
  assert.deepEqual(res.json(), { ok: 1 });
  assert.equal(bodies.length, 2);
  assert.ok(!bodies[1].generationConfig.thinkingConfig);
});

test('503 repetido: troca para outro Flash da chave e conclui', async () => {
  const used = []; const notes = [];
  const fetch = async (url) => {
    if (!url.includes(':generateContent')) return { ok: true, status: 200, json: async () => ({ models: USER_MODELS.map((m) => ({ name: `models/${m}`, supportedGenerationMethods: ['generateContent'] })) }) };
    const m = url.match(/models\/([^:]+):/)[1]; used.push(m);
    if (m === 'gemini-flash-latest') return errBody(503, { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded. Please try again later.' });
    return okBody('{"ok":1}');
  };
  const g = createGemini({ apiKey: 'k', model: 'gemini-flash-latest', minIntervalMs: 0, sleep: async () => {}, fetch });
  const res = await g.generate({ parts: [{ text: 'x' }], fast: true, parallel: true, onRetry: (n) => notes.push(n) });
  assert.deepEqual(res.json(), { ok: 1 });
  assert.deepEqual(used, ['gemini-flash-latest', 'gemini-flash-latest', 'gemini-3.8-flash']);
  assert.ok(notes.some((n) => /sobrecarregado; tentando com gemini-3\.8-flash/.test(n)));
});

test('leitura rápida não pede teses', async () => {
  const svc = createSvc(createStore(memoryStorage()));
  let prompt = '';
  const fake = { model: 'f', async generate(req) { prompt = req.parts[0].text; return { json: () => fixture('acoes.json') }; } };
  await svc.extractReport(fake, { images: [{ mimeType: 'image/jpeg', data: 'AA==' }], pagesTotal: 17, type: 'acoes', month: '2026-10' });
  assert.match(prompt, /Deixe "thesis" vazio/);
  await svc.extractReport(fake, { images: [{ mimeType: 'image/jpeg', data: 'AA==' }], pagesTotal: 1, type: 'acoes', month: '2026-10' });
  assert.match(prompt, /tese de cada ativo/);
});

test('leitura do PDF pelo chat: pedido pronto e resposta colada', () => {
  const svc = createSvc(createStore(memoryStorage()));
  assert.match(svc.manualExtractionPrompt('fiis'), /PDF está anexado/);
  const res = svc.importManualReport('Segue:\n```json\n' + JSON.stringify(fixture('acoes.json')) + '\n```', { type: 'acoes', month: '2026-10' });
  assert.equal(res.report.assets.length, 5);
  assert.equal(svc.report('2026-10:acoes').extraction.manual, true);
  assert.throws(() => svc.importManualReport('não li', { type: 'acoes', month: '2026-10' }), /JSON/);
});

test('aporte: não compra acima do teto e concentra em poucos ativos, com motivo', () => {
  const r = [normalizeReport({ assets: [
    { ticker: 'AAAA3', allocationPct: 25, price: 10, ceilingPrice: 12, recommendation: 'COMPRAR' },
    { ticker: 'BBBB3', allocationPct: 25, price: 20, ceilingPrice: 18, recommendation: 'COMPRAR' }, // acima do teto
    { ticker: 'CCCC3', allocationPct: 25, price: 5, ceilingPrice: 9, recommendation: 'COMPRAR' },
    { ticker: 'DDDD3', allocationPct: 25, price: 8, ceilingPrice: 9, recommendation: 'COMPRAR' },
  ] }, { type: 'acoes', month: '2026-10' })];
  const st = { targets: { acoes: 1, fiis: 0, internacional: 0 }, usdBrl: 5, respectAi: true, includeAguardar: false, respectCeiling: true, maxOrders: 2 };
  const plan = planAporte({ amount: 300, holdings: [{ id: '1', ticker: 'AAAA3', type: 'acoes', qty: 10, avgPrice: 10 }], reports: r, settings: st });
  const t = plan.lines.map((l) => l.ticker);
  assert.ok(!t.includes('BBBB3'));
  assert.equal(t.length, 2);
  assert.ok(!t.includes('AAAA3'), 'quem já tem mais fica para depois');
  assert.ok(plan.warnings.some((w) => /acima do teto.*BBBB3/.test(w)));
  assert.ok(plan.warnings.some((w) => /concentrado em 2/.test(w)));
  assert.match(plan.lines[0].reason, /potencial \+\d+% até o teto/);
  assert.ok(plan.invested > 280);
});

test('veredito da IA sem pesquisa na web não bloqueia o aporte', () => {
  const st = { targets: { acoes: 0.5, fiis: 0, internacional: 0.5 }, usdBrl: 5, respectAi: true, respectCeiling: false, maxOrders: 0 };
  const noWeb = planAporte({ amount: 5000, holdings: [], reports: reports(), analyses: { CCCC3: { verdict: 'DISCORDA', searched: false } }, settings: st });
  assert.ok(noWeb.lines.some((l) => l.ticker === 'CCCC3'));
  assert.ok(noWeb.warnings.some((w) => /sem pesquisa na web.*não bloqueei/.test(w)));
  const web = planAporte({ amount: 5000, holdings: [], reports: reports(), analyses: { CCCC3: { verdict: 'DISCORDA', searched: true } }, settings: st });
  assert.ok(!web.lines.some((l) => l.ticker === 'CCCC3'));
});

test('concentração respeita as classes: cada classe com fatia relevante recebe', () => {
  const r = [
    normalizeReport({ assets: [1, 2, 3, 4].map((i) => ({ ticker: `ACA${i}3`.replace(/\d3$/, `${i}3`).slice(0, 4).padEnd(4, 'A') + '3', allocationPct: 25, price: 10, ceilingPrice: 12, recommendation: 'COMPRAR' })) }, { type: 'acoes', month: '2026-10' }),
    normalizeReport({ assets: ['FIIA', 'FIIB', 'FIIC', 'FIID', 'FIIE', 'FIIF', 'FIIG', 'FIIH'].map((t) => ({ ticker: `${t}11`, allocationPct: 12.5, price: 10, ceilingPrice: 12, recommendation: 'COMPRAR' })) }, { type: 'fiis', month: '2026-10' }),
  ];
  const st = { targets: { acoes: 0.5, fiis: 0.5, internacional: 0 }, usdBrl: 5, respectAi: true, respectCeiling: true, maxOrders: 4 };
  const plan = planAporte({ amount: 1000, holdings: [], reports: r, settings: st });
  const fiis = plan.lines.filter((l) => l.type === 'fiis').reduce((a, l) => a + l.amount, 0);
  const acoes = plan.lines.filter((l) => l.type === 'acoes').reduce((a, l) => a + l.amount, 0);
  assert.equal(plan.lines.length, 4);
  assert.ok(fiis > 400 && acoes > 400, `fiis ${fiis} acoes ${acoes}`);
});
