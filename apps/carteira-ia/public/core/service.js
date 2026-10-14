// Casos de uso do app. A interface (app.js) só fala com este módulo.
// O cliente do Gemini é passado de fora (createGemini), o que permite testar com um fake.

import { normalizeReport, reportId, TYPE_IDS, normalizeTicker, parseNumber } from './report.js';
import { EXTRACTION_SCHEMA, ANALYSIS_SCHEMA, extractionPrompt, analysisPrompt, structurePrompt, normalizeAnalysis, aporteReviewPrompt } from './prompts.js';
import { comparePortfolio, planAporte, classifyTicker, buildUniverse } from './portfolio.js';

const CHUNK = 5; // ativos por chamada de análise (respostas menores = menos cortes)
const uid = () => Math.random().toString(36).slice(2, 10);
const todayISO = () => new Date().toISOString().slice(0, 10);

export function createService(store) {
  const d = () => store.data;

  const reportsFor = (month) => TYPE_IDS.map((t) => d().reports.find((r) => r.month === month && r.type === t)).filter(Boolean);

  /** Análises da IA do mês, achatadas por ticker. */
  function analysesFor(month) {
    const out = {};
    for (const r of reportsFor(month)) Object.assign(out, d().analyses[r.id]?.items ?? {});
    return out;
  }

  function saveReport(normalized, { filename = '' } = {}) {
    const id = reportId(normalized.month, normalized.type);
    return store.update((data) => {
      const replaced = data.reports.some((r) => r.id === id);
      data.reports = data.reports.filter((r) => r.id !== id);
      data.reports.push({ id, filename, importedAt: new Date().toISOString(), ...normalized });
      // A análise antiga se refere a outros dados: descarta só os tickers que saíram.
      const an = data.analyses[id];
      if (an) for (const t of Object.keys(an.items)) if (!normalized.assets.some((a) => a.ticker === t)) delete an.items[t];
      return { id, replaced };
    });
  }

  return {
    months() {
      return [...new Set(d().reports.map((r) => r.month))].sort().reverse();
    },
    reportsFor,
    report: (id) => d().reports.find((r) => r.id === id) ?? null,
    analysis: (id) => d().analyses[id] ?? null,
    analysesFor,

    /** images: [{ mimeType, data(base64) }] das páginas do PDF. */
    async extractReport(gemini, { images, type, month, filename, signal, onStatus }) {
      const res = await gemini.generate({
        parts: [{ text: extractionPrompt(type) }, ...images.map((img) => ({ inlineData: img }))],
        schema: EXTRACTION_SCHEMA,
        temperature: 0,
        signal,
        onRetry: onStatus,
      });
      const normalized = normalizeReport(res.json(), { type, month });
      return { ...saveReport(normalized, { filename }), report: normalized };
    },

    importReportJson(json, { filename = 'importado.json' } = {}) {
      const items = Array.isArray(json) ? json : Array.isArray(json?.reports) ? json.reports : [json];
      return items.map((raw) => saveReport(normalizeReport(raw, { type: raw.type, month: raw.month }), { filename: raw.filename ?? filename }));
    },

    updateReport(id, raw) {
      const cur = this.report(id);
      if (!cur) throw new Error('Relatório não encontrado.');
      return saveReport(normalizeReport(raw, { type: cur.type, month: cur.month }), { filename: cur.filename });
    },

    removeReport(id) {
      store.update((data) => {
        data.reports = data.reports.filter((r) => r.id !== id);
        delete data.analyses[id];
      });
    },

    /**
     * Analisa um relatório com pesquisa na web, em lotes de CHUNK ativos.
     * Salva o progresso a cada lote: se a cota acabar no meio, o que já veio fica,
     * e `pending` guarda os tickers que faltam para "Continuar de onde parou".
     * onProgress(feitos, total, tickersDoLote) · onStatus(mensagem) para esperas/novas tentativas.
     */
    async analyzeReport(gemini, id, { tickers, onProgress, onStatus, signal } = {}) {
      const report = this.report(id);
      if (!report) throw new Error('Relatório não encontrado.');
      const assets = report.assets.filter((a) => !tickers || tickers.includes(a.ticker));
      const result = { at: new Date().toISOString(), model: gemini.model, overview: '', items: {}, errors: [], fatal: null, searched: 0 };

      const ask = async (chunk) => {
        const wanted = chunk.map((a) => a.ticker);
        const parts = [{ text: analysisPrompt(report, chunk, todayISO()) }];
        let res;
        try {
          res = await gemini.generate({ parts, search: true, temperature: 0.3, signal, onRetry: onStatus });
        } catch (e) {
          if (!e.searchUnsupported) throw e;
          result.errors.push(`${e.message} — análise feita sem pesquisa na web.`);
          res = await gemini.generate({ parts, schema: ANALYSIS_SCHEMA, temperature: 0.3, signal, onRetry: onStatus });
        }
        let raw;
        try {
          raw = res.json();
        } catch {
          // Com a pesquisa ligada o modelo às vezes responde em texto: pede para estruturar.
          onStatus?.(`Organizando a resposta de ${wanted.join(', ')}…`);
          raw = (await gemini.generate({ parts: [{ text: structurePrompt(res.text, wanted) }], schema: ANALYSIS_SCHEMA, temperature: 0, signal, onRetry: onStatus })).json();
        }
        const norm = normalizeAnalysis(raw, wanted, res.sources);
        for (const it of Object.values(norm.items)) { it.searched = Boolean(res.searched); it.queries = res.queries ?? []; }
        if (res.searched) result.searched += Object.keys(norm.items).length;
        return norm;
      };

      const persist = (pending) => store.update((data) => {
        const prev = data.analyses[id];
        data.analyses[id] = {
          at: result.at, model: gemini.model,
          overview: result.overview || prev?.overview || '',
          items: { ...(prev?.items ?? {}), ...result.items },
          errors: result.errors.slice(0, 20),
          pending,
        };
      });

      const pendingOf = () => assets.filter((a) => !result.items[a.ticker]).map((a) => a.ticker);
      for (let i = 0; i < assets.length; i += CHUNK) {
        const chunk = assets.slice(i, i + CHUNK);
        onProgress?.(i, assets.length, chunk.map((a) => a.ticker));
        try {
          const norm = await ask(chunk);
          Object.assign(result.items, norm.items);
          if (!result.overview && norm.overview) result.overview = norm.overview;
          const missing = chunk.filter((a) => !norm.items[a.ticker]).map((a) => a.ticker);
          if (missing.length) result.errors.push(`A IA não respondeu sobre ${missing.join(', ')}.`);
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          const msg = `${chunk.map((a) => a.ticker).join(', ')}: ${e.message}`;
          result.errors.push(e.raw && e.raw !== e.message ? `${msg} [${e.raw.slice(0, 200)}]` : msg);
          // Sem chance de dar certo nos próximos lotes: para e avisa.
          if (e.daily || e.status === 401 || e.status === 404) { result.fatal = e.message; break; }
        }
        persist(pendingOf());
      }
      const pending = pendingOf();
      persist(pending);
      result.pending = pending;
      onProgress?.(assets.length - pending.length, assets.length, []);
      return result;
    },

    // ---------------- carteira do usuário
    holdings: () => d().holdings,

    upsertHolding(h) {
      const ticker = normalizeTicker(h.ticker);
      if (!ticker) throw new Error('Informe o código do ativo.');
      const qty = parseNumber(h.qty);
      if (!(qty > 0)) throw new Error(`${ticker}: quantidade inválida.`);
      const row = {
        id: h.id ?? uid(), ticker, type: TYPE_IDS.includes(h.type) ? h.type : classifyTicker(ticker, buildUniverse(d().reports)),
        qty, avgPrice: parseNumber(h.avgPrice), price: parseNumber(h.price),
      };
      store.update((data) => {
        const i = data.holdings.findIndex((x) => x.id === row.id || x.ticker === row.ticker);
        if (i >= 0) data.holdings[i] = { ...row, id: data.holdings[i].id }; else data.holdings.push(row);
      });
      return row;
    },

    removeHolding(id) { store.update((data) => { data.holdings = data.holdings.filter((h) => h.id !== id); }); },

    /**
     * Importa texto colado: uma posição por linha, "TICKER QTD [PREÇO_MÉDIO] [PREÇO_ATUAL]",
     * separado por espaço, tab, ponto e vírgula ou vírgula (números em formato BR ou US).
     */
    importHoldingsText(text, { replace = false } = {}) {
      const universe = buildUniverse(d().reports);
      const rows = []; const errors = [];
      for (const [n, line] of String(text).split(/\r?\n/).entries()) {
        const t = line.trim();
        const cells = (/[\t; ]/.test(t) ? t.split(/\t|;|\s+|,(?=\s)/) : t.split(',')).map((c) => c.trim()).filter(Boolean);
        if (!cells.length || !/[a-z]/i.test(cells[0]) || /^(ticker|ativo|c[oó]digo)$/i.test(cells[0])) continue;
        const ticker = normalizeTicker(cells[0]);
        const qty = parseNumber(cells[1]);
        if (!(qty > 0)) { errors.push(`Linha ${n + 1}: quantidade inválida`); continue; }
        rows.push({ ticker, qty, avgPrice: parseNumber(cells[2]), price: parseNumber(cells[3]), type: classifyTicker(ticker, universe) });
      }
      if (replace) store.update((data) => { data.holdings = []; });
      for (const r of rows) this.upsertHolding(r);
      return { count: rows.length, errors };
    },

    // ---------------- configurações
    settings: () => d().settings,
    updateSettings(patch) { store.update((data) => { data.settings = { ...data.settings, ...patch, targets: { ...data.settings.targets, ...(patch.targets ?? {}) } }; }); },
    get model() { return d().model; },
    setModel(m) { store.update((data) => { data.model = m || null; }); },

    // ---------------- comparação e aporte
    compare(month) {
      return comparePortfolio({ holdings: d().holdings, reports: reportsFor(month), analyses: analysesFor(month), settings: d().settings });
    },
    plan(month, amount) {
      return planAporte({ amount, holdings: d().holdings, reports: reportsFor(month), analyses: analysesFor(month), settings: d().settings });
    },
    async reviewPlan(gemini, month, plan, { signal, onStatus } = {}) {
      const res = await gemini.generate({
        onRetry: onStatus,
        parts: [{ text: aporteReviewPrompt({ plan, reports: reportsFor(month), analyses: analysesFor(month), today: todayISO() }) }],
        search: true, temperature: 0.4, signal,
      });
      return { text: res.text, sources: res.sources };
    },

    // ---------------- backup
    exportBackup: () => JSON.stringify(d(), null, 2),
    restoreBackup(text) { store.replaceAll(JSON.parse(text)); },
    clearAll() { store.replaceAll({ ...JSON.parse(JSON.stringify(d())), reports: [], analyses: {}, holdings: [] }); },
  };
}
