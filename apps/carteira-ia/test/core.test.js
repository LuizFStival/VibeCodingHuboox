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
const settings = { targets: { acoes: 0.5, fiis: 0, internacional: 0.5 }, usdBrl: 5, includeAguardar: false, respectAi: true, fractionalIntl: true, bySegment: false, maxNew: -1 };

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

  // sem os filtros, BBBB3 (aguardar) e CCCC3 (IA discorda) viram candidatos (o otimizador decide se compra)
  const loose = planAporte({ amount: 10000, holdings: [], reports: reports(), analyses, settings: { ...settings, respectAi: false, includeAguardar: true, respectCeiling: false } });
  const blocked = (p, t) => p.excludedItems.some((x) => x.ticker === t && ['casa', 'ia', 'teto'].includes(x.category));
  assert.ok(blocked(plan, 'BBBB3') && blocked(plan, 'CCCC3'));
  assert.ok(!blocked(loose, 'BBBB3') && !blocked(loose, 'CCCC3'));
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
  // o internacional não foi pesquisado: com "exigir pesquisa" (padrão) fica de fora, pedindo revisão
  const strict = svc.plan('2026-10', 3000);
  assert.ok(strict.excludedItems.some((x) => x.ticker === 'ETFA' && x.category === 'dados'));
  assert.ok(!strict.lines.some((l) => l.type === 'internacional'));
  svc.updateSettings({ requireResearch: false });
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

test('aporte: não compra acima do teto, respeita o limite de compras e explica cada uma', () => {
  const r = [normalizeReport({ assets: [
    { ticker: 'AAAA3', allocationPct: 25, price: 10, ceilingPrice: 12, recommendation: 'COMPRAR' },
    { ticker: 'BBBB3', allocationPct: 25, price: 20, ceilingPrice: 18, recommendation: 'COMPRAR' }, // acima do teto
    { ticker: 'CCCC3', allocationPct: 25, price: 5, ceilingPrice: 9, recommendation: 'COMPRAR' },
    { ticker: 'DDDD3', allocationPct: 25, price: 8, ceilingPrice: 9, recommendation: 'COMPRAR' },
  ] }, { type: 'acoes', month: '2026-10' })];
  const st = { targets: { acoes: 1, fiis: 0, internacional: 0 }, usdBrl: 5, respectAi: true, includeAguardar: false, respectCeiling: true, maxOrders: 2, maxNew: -1 };
  const plan = planAporte({ amount: 300, holdings: [{ id: '1', ticker: 'AAAA3', type: 'acoes', qty: 10, avgPrice: 10 }], reports: r, settings: st });
  const t = plan.lines.map((l) => l.ticker);
  assert.ok(!t.includes('BBBB3'));
  assert.ok(t.length >= 1 && t.length <= 2, 'no máximo 2 compras');
  assert.ok(plan.excludedItems.some((x) => x.ticker === 'BBBB3' && x.category === 'teto'));
  for (const l of plan.lines) { assert.match(l.why.motivo, /até o teto/); assert.match(l.why.peso, /→/); assert.ok(l.why.setor && l.why.fundamento && l.why.risco); }
  assert.ok(plan.invested > 280 && plan.invested <= 300);
});

test('veredito da IA sem pesquisa na web não bloqueia o aporte', () => {
  const st = { targets: { acoes: 0.5, fiis: 0, internacional: 0.5 }, usdBrl: 5, respectAi: true, respectCeiling: false, maxOrders: 0, bySegment: false, maxNew: -1 };
  const noWeb = planAporte({ amount: 5000, holdings: [], reports: reports(), analyses: { CCCC3: { verdict: 'DISCORDA', searched: false } }, settings: st });
  assert.ok(!noWeb.excludedItems.some((x) => x.ticker === 'CCCC3' && x.category === 'ia'));
  assert.ok(noWeb.warnings.some((w) => /sem pesquisa na web.*não bloqueei/.test(w)));
  const web = planAporte({ amount: 5000, holdings: [], reports: reports(), analyses: { CCCC3: { verdict: 'DISCORDA', searched: true } }, settings: st });
  assert.ok(!web.lines.some((l) => l.ticker === 'CCCC3'));
  assert.ok(web.excludedItems.some((x) => x.ticker === 'CCCC3' && x.category === 'ia'));
});

test('concentração respeita as classes: cada classe com fatia relevante recebe', () => {
  const r = [
    normalizeReport({ assets: [1, 2, 3, 4].map((i) => ({ ticker: `ACA${i}3`.replace(/\d3$/, `${i}3`).slice(0, 4).padEnd(4, 'A') + '3', allocationPct: 25, price: 10, ceilingPrice: 12, recommendation: 'COMPRAR' })) }, { type: 'acoes', month: '2026-10' }),
    normalizeReport({ assets: ['FIIA', 'FIIB', 'FIIC', 'FIID', 'FIIE', 'FIIF', 'FIIG', 'FIIH'].map((t) => ({ ticker: `${t}11`, allocationPct: 12.5, price: 10, ceilingPrice: 12, recommendation: 'COMPRAR' })) }, { type: 'fiis', month: '2026-10' }),
  ];
  const st = { targets: { acoes: 0.5, fiis: 0.5, internacional: 0 }, usdBrl: 5, respectAi: true, respectCeiling: true, maxOrders: 4, bySegment: false, maxNew: -1 };
  const plan = planAporte({ amount: 1000, holdings: [], reports: r, settings: st });
  const fiis = plan.lines.filter((l) => l.type === 'fiis').reduce((a, l) => a + l.amount, 0);
  const acoes = plan.lines.filter((l) => l.type === 'acoes').reduce((a, l) => a + l.amount, 0);
  assert.equal(plan.lines.length, 4);
  assert.ok(fiis > 400 && acoes > 400, `fiis ${fiis} acoes ${acoes}`);
});

// ---------------------------------------------------------------- ranking e pareceres

import { buildRanking, scoreAsset } from '../public/core/ranking.js';

test('ranking: grupos e nota explicável', () => {
  const r = [normalizeReport({ assets: [
    { ticker: 'AAAA3', allocationPct: 25, price: 10, ceilingPrice: 13, dividendYieldPct: 8, recommendation: 'COMPRAR' },
    { ticker: 'BBBB3', allocationPct: 25, price: 20, ceilingPrice: 21, recommendation: 'COMPRAR' },
    { ticker: 'CCCC3', allocationPct: 25, price: 10, ceilingPrice: 9, recommendation: 'AGUARDAR' },
    { ticker: 'DDDD3', allocationPct: 25, price: 10, ceilingPrice: 14, recommendation: 'COMPRAR' },
  ] }, { type: 'acoes', month: '2026-10' })];
  const an = {
    AAAA3: { verdict: 'CONCORDA', aiRec: 'COMPRAR', confidence: 'alta', searched: true },
    BBBB3: { verdict: 'PARCIAL', aiRec: 'AGUARDAR', confidence: 'media', searched: true },
    DDDD3: { verdict: 'DISCORDA', aiRec: 'AGUARDAR', confidence: 'media', searched: true, summary: 'lucro caindo' },
  };
  const rk = buildRanking(r, an);
  const g = Object.fromEntries(rk.map((x) => [x.ticker, x.group]));
  // BBBB3: a casa diz comprar, mas a IA (com web) diz aguardar → grupo "aguardar" (não entra no aporte)
  assert.deepEqual(g, { AAAA3: 'oportunidade', BBBB3: 'aguardar', CCCC3: 'aguardar', DDDD3: 'risco' });
  assert.equal(rk[0].ticker, 'AAAA3');
  assert.ok(rk[0].parts.some((p) => /margem até o teto \+30%/.test(p.why)));
  // a margem até o teto pesa pouco: no máximo +6 pontos
  assert.ok(rk[0].parts.find((p) => /margem/.test(p.why)).pts <= 6);
  // pesquisa sem web pesa menos
  const web = scoreAsset(r[0].assets[0], { verdict: 'CONCORDA', aiRec: 'COMPRAR', confidence: 'alta', searched: true }).score;
  const noWeb = scoreAsset(r[0].assets[0], { verdict: 'CONCORDA', aiRec: 'COMPRAR', confidence: 'alta', searched: false }).score;
  assert.ok(web > noWeb);
});

test('pareceres: pedido com os dados certos, salvo por mês', async () => {
  const svc = createSvc(createStore(memoryStorage()));
  svc.importReportJson(fixture('acoes.json').assets ? { ...fixture('acoes.json'), type: 'acoes', month: '2026-10' } : null);
  svc.importHoldingsText('AAAA3 10 45');
  const p = svc.reviewPromptFor('portfolio', '2026-10', { web: true });
  assert.match(p, /AAAA3/);
  assert.match(p, /pesquise rapidamente na web/);
  assert.doesNotMatch(svc.reviewPromptFor('ranking', '2026-10'), /pesquise rapidamente/);
  const fake = { model: 'Claude', async generate(req) { assert.match(req.parts[0].text, /parecer do mês/); return { text: '- VALE3 é a melhor.' }; } };
  await svc.askReview(fake, 'ranking', '2026-10');
  assert.equal(svc.note('2026-10', 'ranking').text, '- VALE3 é a melhor.');
  svc.saveNote('2026-10', 'plan', 'ok do GPT', 'GPT');
  assert.equal(svc.note('2026-10', 'plan').by, 'GPT');
  assert.throws(() => svc.saveNote('2026-10', 'plan', '   ', 'GPT'), /Cole a resposta/);
});

test('"aguardar" da pesquisa tira da compra e vai para atenção; aguardar da casa nunca compra', () => {
  const r = [normalizeReport({ assets: [
    { ticker: 'AAAA3', allocationPct: 50, price: 10, ceilingPrice: 13, recommendation: 'COMPRAR' },
    { ticker: 'BBBB3', allocationPct: 30, price: 10, ceilingPrice: 13, recommendation: 'COMPRAR' },
    { ticker: 'CCCC3', allocationPct: 20, price: 10, ceilingPrice: 13, recommendation: 'AGUARDAR' },
  ] }, { type: 'acoes', month: '2026-10' })];
  const an = { BBBB3: { verdict: 'PARCIAL', aiRec: 'AGUARDAR', searched: true, summary: 'preço perto do teto' }, CCCC3: { verdict: 'DISCORDA', aiRec: 'COMPRAR', searched: true } };
  const st = { targets: { acoes: 1, fiis: 0, internacional: 0 }, usdBrl: 5, respectAi: true, maxOrders: 0, bySegment: false, maxNew: -1 };
  const plan = planAporte({ amount: 1000, holdings: [], reports: r, analyses: an, settings: st });
  assert.deepEqual(plan.lines.map((l) => l.ticker), ['AAAA3']);
  assert.deepEqual(plan.attention, ['BBBB3']);
  assert.equal(plan.attentionItems[0].why, 'preço perto do teto');
  const acoes = plan.classes.find((c) => c.type === 'acoes');
  assert.ok(acoes.need > 990 && acoes.targetValue > 990);
  const off = planAporte({ amount: 1000, holdings: [], reports: r, analyses: an, settings: { ...st, respectAiWait: false } });
  assert.ok(!off.attention.includes('BBBB3') && !off.excludedItems.some((x) => x.ticker === 'BBBB3' && x.category === 'ia'));
  assert.ok(!off.lines.some((l) => l.ticker === 'CCCC3'), 'aguardar da casa nunca entra, mesmo com a IA dizendo comprar');
});

test('aporte: limite de novas posições, reforço do que já tem e incluir/tirar', () => {
  const r = [normalizeReport({ assets: [
    { ticker: 'LOGA11', segment: 'Logístico', allocationPct: 20, price: 100, ceilingPrice: 120, recommendation: 'COMPRAR' },
    { ticker: 'LOGB11', segment: 'Logístico', allocationPct: 20, price: 100, ceilingPrice: 130, recommendation: 'COMPRAR' },
    { ticker: 'PAPA11', segment: 'Papel', allocationPct: 20, price: 10, ceilingPrice: 12, recommendation: 'COMPRAR' },
    { ticker: 'PAPB11', segment: 'Papel', allocationPct: 20, price: 10, ceilingPrice: 12, recommendation: 'COMPRAR' },
    { ticker: 'SHOA11', segment: 'Shopping', allocationPct: 10, price: 100, ceilingPrice: 120, recommendation: 'COMPRAR' },
    { ticker: 'LAJA11', segment: 'Lajes', allocationPct: 10, price: 100, ceilingPrice: 120, recommendation: 'COMPRAR' },
  ] }, { type: 'fiis', month: '2026-10' })];
  const holdings = [
    { id: '1', ticker: 'LOGA11', type: 'fiis', qty: 3, avgPrice: 100 }, { id: '2', ticker: 'PAPX11', type: 'fiis', qty: 30, avgPrice: 10, segment: 'Papel' },
    { id: '3', ticker: 'RUAX11', type: 'fiis', qty: 3, avgPrice: 100, segment: 'Renda Urbana' }, { id: '4', ticker: 'HIBX11', type: 'fiis', qty: 3, avgPrice: 100, segment: 'Híbrido' },
  ];
  const st = { targets: { acoes: 0, fiis: 1, internacional: 0 }, usdBrl: 5, respectAi: true, maxOrders: 0, maxNew: 1, limits: { fiis: 0.3, setor: 0.4 } };
  const plan = planAporte({ amount: 400, holdings, reports: r, settings: st });
  assert.ok(plan.lines.filter((l) => !l.ownedQty).length <= 1, 'no máximo 1 novo');
  assert.ok(plan.lines.every((l) => l.sector && l.why), 'cada linha diz o setor e o porquê');
  assert.ok(plan.excludedItems.some((x) => x.category === 'novas') || plan.lines.length <= 2);
  const zero = planAporte({ amount: 400, holdings, reports: r, settings: { ...st, maxNew: 0 } });
  assert.ok(zero.lines.every((l) => l.ownedQty > 0), 'sem novos: só reforço');
  // trocar: tirar LOGA11 e incluir LOGB11 (ex.: sugestão da IA)
  const swap = planAporte({ amount: 400, holdings, reports: r, settings: { ...st, exclude: ['LOGA11'], include: ['LOGB11'] } });
  assert.ok(swap.lines.some((l) => l.ticker === 'LOGB11'));
  assert.ok(!swap.lines.some((l) => l.ticker === 'LOGA11'));
  assert.deepEqual(swap.userExcluded, ['LOGA11']);
});

test('dólar já na corretora paga o internacional; reais ficam no Brasil', () => {
  const r = [
    normalizeReport({ assets: [{ ticker: 'AAAA3', allocationPct: 100, price: 10, ceilingPrice: 20, recommendation: 'COMPRAR' }] }, { type: 'acoes', month: '2026-10' }),
    normalizeReport({ assets: [{ ticker: 'USA', allocationPct: 100, price: 50, ceilingPrice: 80, recommendation: 'COMPRAR' }] }, { type: 'internacional', month: '2026-10' }),
  ];
  // Caixa lá fora cobre o alvo do internacional: os reais vão todos para o Brasil.
  const st = { targets: { acoes: 0.5, fiis: 0, internacional: 0.5 }, usdBrl: 5, maxOrders: 0, maxNew: -1, usdCash: 100, fractionalIntl: true };
  const plan = planAporte({ amount: 1000, holdings: [], reports: r, settings: { ...st, targets: { acoes: 0.7, fiis: 0, internacional: 0.3 } } });
  const intl = plan.lines.find((l) => l.ticker === 'USA');
  assert.ok(Math.abs(intl.amount - 500) < 1, 'os US$ 100 (R$ 500) viram internacional');
  assert.equal(plan.lines.find((l) => l.ticker === 'AAAA3').amount, 1000, 'os reais vão todos para o Brasil');
  assert.equal(plan.remitted, 0);
  assert.equal(plan.toReserve, 0);
  assert.equal(plan.totalBefore, 500, 'o caixa em dólar conta no patrimônio');
});

test('caixinha do dólar: guarda a parte do internacional até dar o envio mínimo', () => {
  const r = [
    normalizeReport({ assets: [{ ticker: 'AAAA3', allocationPct: 100, price: 10, ceilingPrice: 20, recommendation: 'COMPRAR' }] }, { type: 'acoes', month: '2026-10' }),
    normalizeReport({ assets: [{ ticker: 'USA', allocationPct: 100, price: 50, ceilingPrice: 80, recommendation: 'COMPRAR' }] }, { type: 'internacional', month: '2026-10' }),
  ];
  const st = { targets: { acoes: 0.8, fiis: 0, internacional: 0.2 }, usdBrl: 5, maxOrders: 0, maxNew: -1, fractionalIntl: true, minRemitUSD: 50 };
  // 20% de R$ 1.000 = R$ 200 ≈ US$ 40 < 50: vai para a caixinha, sem compra no exterior.
  const m1 = planAporte({ amount: 1000, holdings: [], reports: r, settings: st });
  assert.ok(!m1.lines.some((l) => l.type === 'internacional'));
  assert.ok(Math.abs(m1.toReserve - 200) < 0.01 && Math.abs(m1.reserveAfter - 200) < 0.01);
  assert.ok(m1.lines.find((l) => l.ticker === 'AAAA3').amount <= 800, 'o Brasil não pega a parte do internacional');
  assert.ok(m1.warnings.some((w) => /caixinha do dólar/.test(w)));
  // Meses depois, com R$ 300 guardados (≈ US$ 60): passa do mínimo, envia tudo e compra.
  const m2 = planAporte({ amount: 1000, holdings: [], reports: r, settings: { ...st, dollarReserve: 300 } });
  assert.ok(m2.remitNow && m2.remitted > 250);
  assert.ok(Math.abs(m2.lines.find((l) => l.ticker === 'USA').amount - m2.remitted) < 1);
  assert.equal(m2.reserveAfter, 0, 'a caixinha zera quando envia');
  // Envio mínimo 0: manda todo mês.
  const now = planAporte({ amount: 1000, holdings: [], reports: r, settings: { ...st, minRemitUSD: 0 } });
  assert.ok(now.remitNow && now.lines.some((l) => l.ticker === 'USA'));
});

import { makeLock, checkPassword, maskMoney } from '../public/core/lock.js';

test('senha: guarda só o hash e confere', async () => {
  const lock = await makeLock('minha senha', 'dica');
  assert.ok(lock.hash && lock.salt && !JSON.stringify(lock).includes('minha senha'));
  assert.equal(lock.hint, 'dica');
  assert.equal(await checkPassword('minha senha', lock), true);
  assert.equal(await checkPassword('outra', lock), false);
  await assert.rejects(() => makeLock('123'), /pelo menos 4/);
});

test('ocultar valores troca dinheiro por •••', () => {
  assert.equal(maskMoney('Total R$ 1.234,56 e US$ 114,83 · 38%'), 'Total R$ ••• e US$ ••• · 38%');
  assert.equal(maskMoney('+R$ 52'), '+R$ •••');
});

test('registrar aporte: soma às posições com preço médio e dá para desfazer', () => {
  const svc = createService(createStore(memoryStorage()));
  svc.upsertHolding({ ticker: 'VALE3', type: 'acoes', qty: 1, avgPrice: 70 });
  svc.updateSettings({ usdCash: 114.83, dollarReserve: 0 });
  const rec = svc.registerAporte('2026-10', [
    { ticker: 'VALE3', type: 'acoes', qty: 3, price: 62 },
    { ticker: 'O', type: 'internacional', qty: 0.3077, price: 55.4, segment: 'REIT' },
    { ticker: 'XXXX3', qty: 0, price: 10 },
  ], { cash: { usdCash: 0, dollarReserve: 0 }, brlAmount: 757.4 });
  const vale = svc.holdings().find((x) => x.ticker === 'VALE3');
  assert.equal(vale.qty, 4);
  assert.equal(vale.avgPrice, 64); // (70 + 3×62) / 4
  assert.equal(svc.holdings().find((x) => x.ticker === 'O').qty, 0.3077);
  assert.equal(svc.settings().usdCash, 0);
  assert.equal(svc.aportes().length, 1);
  assert.equal(rec.buys.length, 2, 'linha sem quantidade não entra');
  assert.ok(svc.snapshots().some((x) => x.month === '2026-10'), 'salva o balanço do mês');
  svc.undoAporte(rec.id);
  assert.deepEqual(svc.holdings().map((x) => [x.ticker, x.qty, x.avgPrice]), [['VALE3', 1, 70]]);
  assert.equal(svc.settings().usdCash, 114.83);
  assert.equal(svc.aportes().length, 0);
});

test('mês novo não apaga o anterior: outubro fica guardado e novembro entra ao lado', () => {
  const svc = createService(createStore(memoryStorage()));
  svc.importReportJson({ ...fixture('acoes.json'), type: 'acoes', month: '2026-10' });
  svc.upsertHolding({ ticker: 'VALE3', type: 'acoes', qty: 2, avgPrice: 68 });
  svc.togglePlan('2026-10', 'ITUB3', 'exclude');
  svc.registerAporte('2026-10', [{ ticker: 'VALE3', type: 'acoes', qty: 1, price: 66 }]);
  svc.saveNote('2026-10', 'plan', 'parecer de outubro', 'GPT');
  // novembro: mesmo tipo de carteira, outro mês
  const nov = fixture('acoes.json'); nov.assets = nov.assets.slice(0, 3);
  svc.importReportJson({ ...nov, type: 'acoes', month: '2026-11' });
  assert.deepEqual(svc.months(), ['2026-11', '2026-10']);
  assert.equal(svc.reportsFor('2026-10')[0].assets.length, fixture('acoes.json').assets.length, 'outubro intacto');
  assert.equal(svc.reportsFor('2026-11')[0].assets.length, 3);
  assert.equal(svc.note('2026-10', 'plan').text, 'parecer de outubro');
  assert.equal(svc.note('2026-11', 'plan'), null);
  assert.deepEqual(svc.planOverrides('2026-11').exclude ?? [], [], 'ajustes da proposta são de cada mês');
  assert.equal(svc.aportes().filter((a) => a.month === '2026-11').length, 0, 'novembro começa sem aporte registrado');
  assert.equal(svc.holdings().find((h) => h.ticker === 'VALE3').qty, 3, 'a carteira atual segue para novembro');
  assert.ok(svc.snapshots().some((s) => s.month === '2026-10'), 'o balanço de outubro continua no histórico');
});

test('congelar: posição antiga fica sem aporte; se voltar ao relatório, volta a valer sozinha', () => {
  const svc = createService(createStore(memoryStorage()));
  const fiis = (month, withCpts) => svc.importReportJson({ type: 'fiis', month, assets: [
    ...(withCpts ? [{ ticker: 'CPTS11', segment: 'Papel', allocationPct: 50, price: 8, ceilingPrice: 10, recommendation: 'COMPRAR' }] : []),
    { ticker: 'MXRF11', segment: 'Papel', allocationPct: 50, price: 9, ceilingPrice: 10, recommendation: 'COMPRAR' },
  ] });
  fiis('2026-11', false);
  svc.upsertHolding({ ticker: 'CPTS11', type: 'fiis', qty: 30, avgPrice: 7.86, segment: 'Papel' });
  svc.updateSettings({ targets: { acoes: 0, fiis: 1, internacional: 0 }, maxOrders: 0, requireResearch: false, limits: { fiis: 1, setor: 1 } });
  svc.setFrozen('CPTS11', true);
  svc.upsertHolding({ ticker: 'CPTS11', qty: 30, avgPrice: 7.9 }); // editar não descongela
  assert.equal(svc.holdings()[0].frozen, true);
  const nov = svc.plan('2026-11', 300);
  assert.ok(!nov.lines.some((l) => l.ticker === 'CPTS11') && nov.lines.some((l) => l.ticker === 'MXRF11'));
  assert.ok(svc.compare('2026-11').total > 200, 'continua no patrimônio');
  assert.ok(svc.compare('2026-11').alerts.some((a) => a.kind === 'congelado'));
  // dezembro: CPTS11 volta ao relatório como COMPRAR → volta a valer, sem precisar descongelar
  fiis('2026-12', true);
  const dez = svc.plan('2026-12', 300);
  assert.ok(dez.lines.some((l) => l.ticker === 'CPTS11'), 'reforça de novo o que já tem');
  assert.ok(dez.warnings.some((w) => /CPTS11 voltou ao relatório/.test(w)));
  assert.ok(svc.compare('2026-12').alerts.some((a) => a.kind === 'voltou'));
});

test('leitura do PDF: mês da capa vence o nome do arquivo e a tabela é achada além do limite de imagens', async () => {
  const svc = createService(createStore(memoryStorage()));
  const calls = [];
  // IA falsa: aceita 4 imagens por pedido; a tabela está na página 6; a capa (página 1) diz novembro.
  const ai = {
    model: 'fake',
    maxImages: async () => 4,
    async generate({ parts }) {
      const pages = parts.filter((p) => /^Página \d+$/.test(p.text ?? '')).map((p) => Number(p.text.slice(7)));
      calls.push(pages);
      const json = { referenceMonth: pages.includes(1) ? '2026-11' : '', summary: pages.includes(1) ? 'resumo de novembro' : '', assets: [] };
      if (pages.includes(6)) { json.assets = [{ ticker: 'MXRF11', allocationPct: 100, recommendation: 'COMPRAR', price: 8.75, ceilingPrice: 9.26, page: 6 }]; json.tablePages = [6]; }
      return { json: () => json };
    },
  };
  const images = Array.from({ length: 10 }, () => ({ mimeType: 'image/jpeg', data: 'AA==' }));
  const res = await svc.extractReport(ai, { images, pagesTotal: 10, type: 'fiis', month: '2026-10', filename: 'Carteira_Fiis_-_Outubro26.pdf' });
  assert.equal(res.report.month, '2026-11');
  assert.deepEqual(res.monthChanged, { from: '2026-10', to: '2026-11' });
  assert.equal(res.report.assets[0].ticker, 'MXRF11');
  assert.equal(res.report.summary, 'resumo de novembro');
  assert.ok(calls.every((c) => c.length <= 4), 'nunca manda mais imagens do que o limite');
  assert.deepEqual(calls[0], [1, 2, 3, 4]);
  assert.ok(calls.some((c) => c.includes(6)), 'procurou a tabela nas páginas seguintes');
  assert.deepEqual(svc.months(), ['2026-11'], 'salvou em novembro, não em outubro');
});

test('ativos aninhados no JSON da IA também são lidos', () => {
  const r = normalizeReport({ carteira: { ativos: [{ ticker: 'VOO', allocationPct: 100, recommendation: 'COMPRAR' }] } }, { type: 'internacional', month: '2026-11' });
  assert.equal(r.assets[0].ticker, 'VOO');
});

// ---------------------------------------------------------------- motor de aporte (carteira resultante)

import { sectorOf } from '../public/core/sectors.js';
import { riskSignals } from '../public/core/ranking.js';

// Cenário parecido com nov/2026: ações com dois ativos pesados (40% cada), Petrobras pequena,
// PRIO3 e CMIG4 disponíveis; FIIs com Logístico perto do limite de setor. Sem fixar quem vence.
function novCenario() {
  const ok = (extra = {}) => ({ verdict: 'CONCORDA', aiRec: 'COMPRAR', confidence: 'alta', searched: true, risks: [], fundamentals: ['lucro crescendo'], news: [], summary: 'ok', ...extra });
  const acoes = normalizeReport({ assets: [
    { ticker: 'BBAS3', segment: 'Financeiro', allocationPct: 10, price: 14.2, ceilingPrice: 18, recommendation: 'COMPRAR' },
    { ticker: 'DIVO11', segment: 'Ibov', allocationPct: 14, price: 118.35, ceilingPrice: 141.84, recommendation: 'COMPRAR' },
    { ticker: 'PETR4', segment: 'Petróleo e Gás', allocationPct: 12, price: 41.3, ceilingPrice: 57.19, recommendation: 'COMPRAR' },
    { ticker: 'PRIO3', segment: 'Petrolífero', allocationPct: 5, price: 58.22, ceilingPrice: 67.65, recommendation: 'COMPRAR' },
    { ticker: 'CMIG4', segment: 'Energia elétrica', allocationPct: 10, price: 10.78, ceilingPrice: 11.75, recommendation: 'COMPRAR' },
    { ticker: 'VALE3', segment: 'Mineração', allocationPct: 12, price: 58.41, ceilingPrice: 67.64, recommendation: 'COMPRAR' },
    { ticker: 'ITUB3', segment: 'Financeiro', allocationPct: 12, price: 43.86, ceilingPrice: 40.26, recommendation: 'AGUARDAR' },
  ] }, { type: 'acoes', month: '2026-11' });
  const fiis = normalizeReport({ assets: [
    { ticker: 'BTLG11', segment: 'Logístico', allocationPct: 20, price: 94.26, ceilingPrice: 102, recommendation: 'COMPRAR' },
    { ticker: 'GGRC11', segment: 'Logístico', allocationPct: 20, price: 8, ceilingPrice: 10.4, recommendation: 'COMPRAR' },
    { ticker: 'KNRI11', segment: 'Híbrido', allocationPct: 20, price: 140.5, ceilingPrice: 152, recommendation: 'COMPRAR' },
    { ticker: 'MCCI11', segment: 'Papel', allocationPct: 20, price: 85.99, ceilingPrice: 92, recommendation: 'COMPRAR' },
    { ticker: 'TRXF11', segment: 'Renda Urbana', allocationPct: 20, price: 52.88, ceilingPrice: 61, recommendation: 'COMPRAR' },
  ] }, { type: 'fiis', month: '2026-11' });
  const analyses = {
    BBAS3: ok({ verdict: 'DISCORDA', aiRec: 'AGUARDAR' }), DIVO11: ok(), PETR4: ok({ verdict: 'PARCIAL' }), PRIO3: ok(), CMIG4: ok({ verdict: 'PARCIAL' }),
    VALE3: ok({ verdict: 'DISCORDA', aiRec: 'AGUARDAR' }), ITUB3: ok({ aiRec: 'AGUARDAR' }),
    BTLG11: ok(), GGRC11: ok({ verdict: 'PARCIAL' }), KNRI11: ok(), MCCI11: ok(),
    TRXF11: ok({ verdict: 'DISCORDA', aiRec: 'AGUARDAR', risks: ['O fundo distribuiu mais do que gerou e usou reservas.'] }),
  };
  const h = (ticker, type, qty, segment) => ({ id: ticker, ticker, type, qty, avgPrice: null, segment });
  const holdings = [
    h('BBAS3', 'acoes', 25), h('DIVO11', 'acoes', 3), h('VALE3', 'acoes', 2), h('PETR4', 'acoes', 1), h('KEPL3', 'acoes', 4, 'Industrial'),
    h('BTLG11', 'fiis', 1), h('GGRC11', 'fiis', 12), h('TRXF11', 'fiis', 3), h('XPML11', 'fiis', 3, 'Shopping'), h('RCRB11', 'fiis', 2, 'Lajes'), h('CPTS11', 'fiis', 30, 'Papel'),
  ].map((x) => ({ ...x, price: { KEPL3: 6.45, XPML11: 83, RCRB11: 126.75, CPTS11: 7.86 }[x.ticker] ?? null }));
  const settings = { targets: { acoes: 0.35, fiis: 0.45, internacional: 0.2 }, usdBrl: 5, respectAi: true, respectAiWait: true, respectCeiling: true,
    maxOrders: 5, maxNew: 2, preferOwned: true, limits: { acoes: 0.15, fiis: 0.12, internacional: 0.2, etfAmplo: 0.4, setor: 0.2 } };
  return { reports: [acoes, fiis], analyses, holdings, settings };
}
test('setores padronizados: PETR4 (Petróleo e Gás) e PRIO3 (Petrolífero) são o mesmo risco', () => {
  assert.equal(sectorOf('PETR4', 'Petróleo e Gás'), sectorOf('PRIO3', 'Petrolífero'));
  assert.equal(sectorOf('BORR', 'Stock'), 'Petróleo e gás');
  assert.equal(sectorOf('ITUB3', 'Financeiro'), sectorOf('BBAS3', 'Bancos'));
  assert.equal(sectorOf('VOO', 'ETF'), sectorOf('DIVO11', 'Ibov'), 'ETFs amplos ficam como diversificados');
  assert.notEqual(sectorOf('GLD', 'ETF'), sectorOf('CPER', 'ETF'));
  assert.equal(sectorOf('XYZ', 'ETF'), 'Outros (XYZ)', 'segmento genérico não agrupa ativos diferentes');
  assert.equal(sectorOf('ABCD3', 'Qualquer', { ABCD3: 'Bancos' }), 'Bancos', 'correção manual por ticker');
});

test('motor: não passa dos limites de ativo e setor, nem compra AGUARDAR/acima do teto/IA contra', () => {
  const { reports, analyses, holdings, settings } = novCenario();
  for (const maxNew of [0, 2, 5]) {
    const plan = planAporte({ amount: 450, holdings, reports, analyses, settings: { ...settings, maxNew } });
    const t = plan.lines.map((l) => l.ticker);
    for (const bad of ['ITUB3', 'BBAS3', 'VALE3', 'TRXF11']) assert.ok(!t.includes(bad), `${bad} não pode ser comprado`);
    assert.ok(plan.lines.filter((l) => !l.ownedQty).length <= maxNew, 'limite de novos');
    assert.ok(plan.lines.length <= 5, 'limite de compras');
    assert.ok(plan.invested <= 450 + 1e-6, 'orçamento');
    for (const l of plan.lines) {
      if (l.type !== 'internacional') assert.equal(l.qty, Math.round(l.qty), 'cotas inteiras');
      const lim = l.sector.startsWith('Diversificado') ? 0.4 : settings.limits[l.type];
      assert.ok(l.weightAfter <= Math.max(lim, l.weightBefore) + 1e-9, `${l.ticker}: ${l.weightAfter} > limite`);
      if (!l.sector.startsWith('Diversificado')) assert.ok(l.sectorAfter <= Math.max(0.2, l.sectorBefore) + 1e-9, `${l.ticker}: setor ${l.sectorAfter}`);
    }
    // Petrobras + PRIO juntas no mesmo setor: a soma não passa de 20% da classe
    const oil = plan.lines.filter((l) => l.sector === 'Petróleo e gás');
    if (oil.length) assert.ok(Math.max(...oil.map((l) => l.sectorAfter)) <= 0.2 + 1e-9);
  }
});

test('motor: reprodutível e porcentagens recalculadas', () => {
  const { reports, analyses, holdings, settings } = novCenario();
  const a = planAporte({ amount: 450, holdings, reports, analyses, settings });
  const b = planAporte({ amount: 450, holdings, reports, analyses, settings });
  assert.deepEqual(a.lines.map((l) => [l.ticker, l.qty]), b.lines.map((l) => [l.ticker, l.qty]));
  const sum = a.classes.reduce((s, c) => s + c.pctAfter, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `as classes somam 100% depois do aporte (${sum})`);
  for (const c of a.classes) assert.ok(Math.abs(c.after - (c.before + c.added)) < 1e-6 || c.type === 'internacional');
});

test('motor: deixa dinheiro parado quando não há combinação adequada', () => {
  const { reports, analyses, holdings, settings } = novCenario();
  // limites apertados: quase nada cabe → sobra em vez de forçar compra
  const tight = planAporte({ amount: 450, holdings, reports, analyses, settings: { ...settings, maxNew: 0, limits: { acoes: 0.05, fiis: 0.05, internacional: 0.05, etfAmplo: 0.05, setor: 0.05 } } });
  assert.ok(tight.leftover > 300, `sobra ${tight.leftover}`);
  assert.ok(tight.warnings.some((w) => /Sobraram/.test(w)));
  assert.ok(tight.excludedItems.some((x) => ['concentracao', 'setor'].includes(x.category)));
});

test('IA: PARCIAL+COMPRAR entra com penalidade; PARCIAL sem compra ou AGUARDAR fica de fora; pesquisa velha pede revisão', () => {
  const a = { ticker: 'AAAA3', rec: 'COMPRAR', price: 10, ceiling: 12, dy: 0.06 };
  const base = { aiRec: 'COMPRAR', confidence: 'alta', searched: true, risks: [], news: [] };
  assert.ok(scoreAsset(a, { ...base, verdict: 'PARCIAL' }).score < scoreAsset(a, { ...base, verdict: 'CONCORDA' }).score);
  const r = [normalizeReport({ assets: [
    { ticker: 'AAAA3', allocationPct: 34, price: 10, ceilingPrice: 12, recommendation: 'COMPRAR' },
    { ticker: 'BBBB3', allocationPct: 33, price: 10, ceilingPrice: 12, recommendation: 'COMPRAR' },
    { ticker: 'CCCC3', allocationPct: 33, price: 10, ceilingPrice: 12, recommendation: 'COMPRAR' },
  ] }, { type: 'acoes', month: '2026-11' })];
  r[0].importedAt = '2026-11-11T00:00:00Z';
  const an = {
    AAAA3: { ...base, verdict: 'PARCIAL', analyzedAt: '2026-11-20T00:00:00Z' },
    BBBB3: { ...base, verdict: 'PARCIAL', aiRec: 'AGUARDAR', analyzedAt: '2026-11-20T00:00:00Z' },
    CCCC3: { ...base, verdict: 'CONCORDA', analyzedAt: '2026-09-01T00:00:00Z' }, // antes do relatório do mês
  };
  const st = { targets: { acoes: 1, fiis: 0, internacional: 0 }, usdBrl: 5, respectAi: true, maxOrders: 0, maxNew: -1, requireResearch: true, today: '2026-11-23' };
  const plan = planAporte({ amount: 300, holdings: [], reports: r, analyses: an, settings: st });
  assert.deepEqual(plan.lines.map((l) => l.ticker), ['AAAA3']);
  assert.ok(plan.excludedItems.some((x) => x.ticker === 'BBBB3' && x.category === 'ia'));
  assert.ok(plan.excludedItems.some((x) => x.ticker === 'CCCC3' && x.category === 'dados' && /antes do relatório/.test(x.detail)));
});

test('qualidade: dividendo insustentável não conta como positivo; riscos e notícias pesam na nota', () => {
  const a = { ticker: 'FIIX11', rec: 'COMPRAR', price: 50, ceiling: 70, dy: 0.2 };
  const base = { verdict: 'CONCORDA', aiRec: 'COMPRAR', confidence: 'alta', searched: true, news: [] };
  const clean = scoreAsset(a, { ...base, risks: ['vacância baixa'], fundamentals: ['resultado cobre a distribuição'] });
  const bad = scoreAsset(a, { ...base, risks: ['O fundo distribuiu mais do que gerou e usou reservas.'], fundamentals: ['rendimento com ganho não recorrente de venda de imóvel'] });
  assert.equal(riskSignals({ risks: ['distribuiu mais do que gerou'] }).dividendRisk, true);
  assert.ok(bad.dividendRisk && !clean.dividendRisk);
  assert.ok(!bad.parts.some((p) => /^DY/.test(p.why)), 'DY alto não soma quando o dividendo é duvidoso');
  assert.ok(clean.score - bad.score >= 10, `${clean.score} vs ${bad.score}`);
  assert.notEqual(bad.group, 'oportunidade');
  const neg = scoreAsset(a, { ...base, risks: [], news: [{ title: 'lucro despenca', impact: 'negativo' }, { title: 'rebaixamento', impact: 'negativo' }] });
  assert.ok(neg.score < clean.score);
  // alavancagem negativa (caixa líquido) não é sinal de risco
  assert.equal(riskSignals({ fundamentals: ['alavancagem líquida reportada próxima de -6%'] }).flags.length, 0);
});

test('motor: explica cada compra e o motivo de quem ficou de fora', () => {
  const { reports, analyses, holdings, settings } = novCenario();
  const plan = planAporte({ amount: 450, holdings, reports, analyses, settings });
  assert.ok(plan.lines.length > 0);
  for (const l of plan.lines) for (const k of ['motivo', 'peso', 'setor', 'fundamento', 'risco']) assert.ok(l.why[k], `${l.ticker} sem ${k}`);
  const cats = new Set(plan.excludedItems.map((x) => x.category));
  assert.ok(cats.has('casa') && cats.has('ia'), [...cats].join(','));
  assert.ok(plan.excludedItems.every((x) => x.detail));
});

test('pesquisa estruturada: qualidade, dividendo e risco viram números na nota', () => {
  const n = normalizeAnalysis({ ativos: [{ ticker: 'AAAA3', veredito: 'CONCORDA', recomendacaoIA: 'COMPRAR', resumo: 'ok', qualidade: 8, sustentabilidadeDividendo: 'insustentável', nivelRisco: 'alto', dataDados: '2026-11-20' }] }, ['AAAA3']);
  const it = n.items.AAAA3;
  assert.deepEqual([it.quality, it.dividendQuality, it.riskLevel, it.dataDate], [8, 'insustentavel', 'alto', '2026-11-20']);
  const asset = { ticker: 'AAAA3', rec: 'COMPRAR', price: 10, ceiling: 12, dy: 0.1 };
  const good = scoreAsset(asset, { ...it, quality: 9, dividendQuality: 'sustentavel', riskLevel: 'baixo', searched: true });
  const bad = scoreAsset(asset, { ...it, searched: true });
  assert.ok(good.score > bad.score + 10 && bad.dividendRisk && !good.dividendRisk);
});

test('novo × reforço: mostra a alternativa só com o que já tem e explica o ativo novo do mesmo setor', () => {
  const { reports, analyses, holdings, settings } = novCenario();
  const plan = planAporte({ amount: 450, holdings, reports, analyses, settings });
  const novos = plan.lines.filter((l) => !l.ownedQty);
  if (!novos.length) return; // nada novo: nada a comparar
  assert.ok(plan.onlyOwned, 'compara com a proposta só de reforço');
  assert.ok(plan.onlyOwned.invested <= 450 && plan.onlyOwned.buys.every((b) => holdings.some((h) => h.ticker === b.ticker)));
  const prio = plan.lines.find((l) => l.ticker === 'PRIO3');
  if (prio) assert.match(prio.why.alternativa, /PETR4 \(que você já tem, mesmo setor\)/);
  const zero = planAporte({ amount: 450, holdings, reports, analyses, settings: { ...settings, maxNew: 0 } });
  assert.equal(zero.onlyOwned, null);
});

import { parseAiAdjustments, planSummaryText } from '../public/core/prompts.js';

test('retorno da IA: lê o bloco JSON ou frases "trocar X por Y"', () => {
  const j = parseAiAdjustments('Análise...\n```json\n{"veredito":"ajustar","tirar":["prio3"],"incluir":["PETR4"],"limites":{"setor":15,"fii":0.1},"maxNovos":1,"motivos":["duas petroleiras"]}\n```');
  assert.deepEqual([j.tirar, j.incluir, j.limites, j.maxNovos, j.veredito, j.source], [['PRIO3'], ['PETR4'], { setor: 0.15, fiis: 0.1 }, 1, 'ajustar', 'json']);
  const t = parseAiAdjustments('Eu trocaria: trocar PRIO3 por PETR4. Também tirar CMIG4. Não vou trocar o plano por outro.');
  assert.deepEqual([t.tirar, t.incluir, t.source], [['PRIO3', 'CMIG4'], ['PETR4'], 'texto']);
  assert.equal(parseAiAdjustments('Está ótimo, sem comentários.'), null);
  assert.equal(parseAiAdjustments('```json\n{"veredito":"aprovar","tirar":[],"incluir":[]}\n```').veredito, 'aprovar');
});

test('retorno da IA: recalcula a proposta com os ajustes, mantém as regras e dá para desfazer', () => {
  const { reports, analyses, holdings, settings } = novCenario();
  const svc = createService(createStore(memoryStorage()));
  for (const r of reports) svc.importReportJson({ ...r, assets: r.assets.map((a) => ({ ticker: a.ticker, segment: a.segment, allocationPct: a.weight * 100, price: a.price, ceilingPrice: a.ceiling, recommendation: a.rec })) });
  for (const h of holdings) svc.upsertHolding(h);
  svc.updateSettings({ ...settings, requireResearch: false });
  const plan0 = svc.plan('2026-11', 450);
  const sum = planSummaryText(plan0, { month: '2026-11' });
  assert.match(sum, /BALANÇO USADO/); assert.match(sum, /COMO O APP CHEGOU/); assert.match(sum, /ONDE COLOCAR O DINHEIRO/);
  assert.match(svc.reviewPromptFor('plan', '2026-11', { web: true, plan: plan0 }), /```json/);
  const first = plan0.lines[0]?.ticker;
  assert.ok(first);
  const ai = svc.applyAiReview('2026-11', `\`\`\`json\n{"tirar":["${first}"],"incluir":["ITUB3","ZZZZ3"],"limites":{"setor":15}}\n\`\`\``, { amount: 450, before: plan0.lines.map((l) => ({ ticker: l.ticker, qty: l.qty })) });
  assert.deepEqual(ai.exclude, [first]);
  assert.deepEqual(ai.unknown, ['ZZZZ3'], 'ticker fora das carteiras não é aplicado');
  const plan1 = svc.plan('2026-11', 450);
  assert.ok(!plan1.lines.some((l) => l.ticker === first), 'a IA tirou');
  assert.ok(!plan1.lines.some((l) => l.ticker === 'ITUB3'), 'AGUARDAR da casa continua fora mesmo com a IA pedindo');
  assert.equal(plan1.limits.setor, 0.15, 'limite da IA vale só neste mês');
  assert.equal(svc.settings().limits.setor, 0.2, 'configuração geral não muda');
  svc.clearAiReview('2026-11');
  assert.deepEqual(svc.plan('2026-11', 450).lines.map((l) => l.ticker), plan0.lines.map((l) => l.ticker));
  assert.throws(() => svc.applyAiReview('2026-11', 'gostei'), /Não encontrei ajustes/);
});

test('ETF amplo não sofre limite de setor (só o limite próprio de ETF amplo); ETF temático sofre', () => {
  // ações: 4 posições; DIVO11 (índice) já em 40% e setor "Diversificado" seria 40% → mesmo assim pode receber até o limite de ETF amplo
  const r = [normalizeReport({ assets: [
    { ticker: 'DIVO11', segment: 'Ibov', allocationPct: 50, price: 100, ceilingPrice: 150, recommendation: 'COMPRAR' },
    { ticker: 'PETR4', segment: 'Petróleo e Gás', allocationPct: 50, price: 40, ceilingPrice: 60, recommendation: 'COMPRAR' },
  ] }, { type: 'acoes', month: '2026-11' })];
  const holdings = [
    { id: 'a', ticker: 'DIVO11', type: 'acoes', qty: 3, price: 100 }, { id: 'b', ticker: 'BBAS3', type: 'acoes', qty: 10, price: 15, segment: 'Bancos' },
    { id: 'c', ticker: 'VALE3', type: 'acoes', qty: 2, price: 60, segment: 'Mineração' }, { id: 'd', ticker: 'PRIO3', type: 'acoes', qty: 3, price: 50, segment: 'Petrolífero' },
  ]; // total 750: DIVO11 40%, PRIO3 20% (petróleo já no limite de 20%)
  const st = { targets: { acoes: 1, fiis: 0, internacional: 0 }, usdBrl: 5, maxOrders: 0, maxNew: -1, limits: { acoes: 0.15, etfAmplo: 0.6, setor: 0.2 } };
  const plan = planAporte({ amount: 300, holdings, reports: r, settings: st });
  const divo = plan.lines.find((l) => l.ticker === 'DIVO11');
  assert.ok(divo && divo.weightAfter > 0.4, 'DIVO11 recebe acima de 40% (passaria do "setor" de 20% se fosse tratado como empresa)');
  assert.ok(divo.weightAfter <= 0.6 + 1e-9, 'respeita o limite de ETF amplo');
  assert.match(divo.why.setor, /ETF amplo/);
  // uma empresa comum (PETR4) sofre o limite de setor: com PRIO3 já em 20% do setor petróleo, não entra
  const only = planAporte({ amount: 100, holdings, reports: [normalizeReport({ assets: [r[0].assets[1]].map((x) => ({ ticker: x.ticker, segment: x.segment, allocationPct: 100, price: x.price, ceilingPrice: x.ceiling, recommendation: 'COMPRAR' })) }, { type: 'acoes', month: '2026-11' })], settings: st });
  assert.equal(only.lines.length, 0);
  assert.ok(only.excludedItems.some((x) => x.ticker === 'PETR4' && x.category === 'setor'), JSON.stringify(only.excludedItems));
  // ETF temático (ouro, cobre, renda fixa, cripto) não é diversificado: tem setor próprio e sofre o limite
  assert.equal(sectorOf('GLD', 'ETF'), 'Ouro');
  assert.equal(sectorOf('IBIT', 'ETF'), 'Cripto');
});

test('retorno da IA só com recomendações (sem trocas) e JSON sem cercas também é aceito', () => {
  const gpt = `{
  "veredito": "ajustar",
  "tirar": [],
  "incluir": [],
  "limites": {},
  "motivos": ["Manter os quatro ativos selecionados.", "Atualizar as cotações antes de executar."]
}`;
  const adj = parseAiAdjustments(gpt);
  assert.ok(adj, 'aceita');
  assert.deepEqual([adj.veredito, adj.tirar, adj.incluir, adj.motivos.length, adj.source], ['ajustar', [], [], 2, 'json']);
  const svc = createService(createStore(memoryStorage()));
  svc.importReportJson({ ...fixture('acoes.json'), type: 'acoes', month: '2026-11' });
  const ai = svc.applyAiReview('2026-11', gpt, { amount: 450, before: [] });
  assert.deepEqual([ai.exclude, ai.include, ai.motivos.length], [[], [], 2]);
});
