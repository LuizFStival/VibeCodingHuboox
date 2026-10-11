// Modelo de um relatório de carteira recomendada (um PDF = um tipo × um mês).
// A extração do PDF é feita pelo Gemini (ver prompts.js); aqui só normalizamos
// e validamos o que voltou, para o resto do app trabalhar com dados confiáveis.

export const ASSET_TYPES = {
  acoes: { label: 'Ações', short: 'Ações', currency: 'BRL' },
  fiis: { label: 'Fundos imobiliários', short: 'FIIs', currency: 'BRL' },
  internacional: { label: 'Internacional', short: 'Internacional', currency: 'USD' },
};
export const TYPE_IDS = Object.keys(ASSET_TYPES);

/** Recomendações aceitas. MANTER = segurar a posição, sem novo aporte (igual a AGUARDAR para o aporte). */
export const RECS = ['COMPRAR', 'AGUARDAR', 'MANTER', 'VENDER'];

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function normalizeRec(value) {
  const s = norm(value);
  if (/vend|sell|sair|zerar/.test(s)) return 'VENDER';
  if (/compr|buy|aport/.test(s)) return 'COMPRAR';
  if (/mant|hold|segur/.test(s)) return 'MANTER';
  return 'AGUARDAR';
}

/** Tipo pelo nome do arquivo: "Carteira_Fiis_-_Outubro26.pdf" → fiis. */
export function detectType(filename) {
  const s = norm(filename);
  if (/fii|imobili/.test(s)) return 'fiis';
  if (/internac|global|exterior|dolar|usa\b|eua/.test(s)) return 'internacional';
  if (/acoes|acao|a__es|stock|_a_es/.test(s)) return 'acoes';
  return null;
}

const MONTH_NAMES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** Mês pelo nome do arquivo: "Outubro26" → 2026-10; também aceita "2026-10". */
export function detectMonth(filename) {
  const s = norm(filename);
  const iso = s.match(/(20\d\d)[-_.](0[1-9]|1[0-2])/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const named = s.match(/(jan|fev|feb|mar|abr|apr|mai|may|jun|jul|ago|aug|set|sep|out|oct|nov|dez|dec)[a-z]*[\s_.-]*(\d{4}|\d{2})(?!\d)/);
  if (!named) return null;
  const alias = { feb: 'fev', apr: 'abr', may: 'mai', aug: 'ago', sep: 'set', oct: 'out', dec: 'dez' };
  const idx = MONTH_NAMES.indexOf(alias[named[1]] ?? named[1]);
  const year = named[2].length === 2 ? `20${named[2]}` : named[2];
  return `${year}-${String(idx + 1).padStart(2, '0')}`;
}

/** "R$ 1.234,56" | "12,5%" | 12.5 → número (ou null). */
export function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value).replace(/[^\d,.-]/g, '');
  if (!/\d/.test(s)) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Percentual vindo como 12.5 (=12,5%) ou "12,5%" → fração 0.125. */
const pctToFraction = (v) => { const n = parseNumber(v); return n === null ? null : n / 100; };

const text = (v, max = 4000) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));
const list = (v) => (Array.isArray(v) ? v : []);

export function normalizeTicker(t) {
  return text(t, 20).toUpperCase().replace(/^(US|NYSE|NASDAQ|BVMF|B3)[:\s]+/, '').replace(/\s+/g, '');
}

/**
 * Normaliza o JSON extraído (formato de prompts.js → EXTRACTION_SCHEMA) e valida.
 * Lança erro com mensagem amigável se não houver ativos.
 */
export function normalizeReport(raw, { type, month } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('Relatório vazio.');
  const t = TYPE_IDS.includes(type) ? type : TYPE_IDS.includes(raw.type) ? raw.type : null;
  if (!t) throw new Error('Tipo de carteira desconhecido (ações, FIIs ou internacional).');
  const m = /^\d{4}-\d{2}$/.test(month ?? '') ? month : /^\d{4}-\d{2}$/.test(raw.month ?? '') ? raw.month : null;
  if (!m) throw new Error('Mês de referência inválido (use AAAA-MM).');

  const seen = new Set();
  const assets = [];
  for (const a of list(raw.assets)) {
    const ticker = normalizeTicker(a?.ticker);
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    const rec = normalizeRec(a.recommendation ?? a.rec);
    assets.push({
      ticker,
      name: text(a.name, 120),
      segment: text(a.segment, 60),
      weight: pctToFraction(a.allocationPct ?? a.weightPct) ?? 0,
      strategy: text(a.strategy, 60),
      dy: pctToFraction(a.dividendYieldPct ?? a.dyPct),
      price: parseNumber(a.price),
      ceiling: parseNumber(a.ceilingPrice ?? a.ceiling),
      pvp: parseNumber(a.pvp),
      rec,
      thesis: text(a.thesis, 3000),
    });
  }
  if (!assets.length) throw new Error('Nenhum ativo encontrado no relatório.');
  // Ativo com recomendação de venda não tem peso alvo, mesmo que o PDF mostre algum.
  for (const a of assets) if (a.rec === 'VENDER') a.weight = 0;

  return {
    type: t,
    month: m,
    provider: text(raw.provider, 80),
    title: text(raw.title, 160),
    summary: text(raw.summary, 3000),
    macro: list(raw.macroHighlights).map((x) => text(x, 400)).filter(Boolean).slice(0, 12),
    changes: list(raw.changes).map((c) => ({
      ticker: normalizeTicker(c?.ticker),
      action: text(c?.action, 40),
      reason: text(c?.reason, 800),
    })).filter((c) => c.ticker || c.reason).slice(0, 30),
    assets,
    performance: {
      period: text(raw.performance?.period, 80),
      items: list(raw.performance?.items).map((i) => ({
        name: text(i?.name, 60),
        returnPct: parseNumber(i?.returnPct),
      })).filter((i) => i.name && i.returnPct !== null).slice(0, 8),
    },
  };
}

export const reportId = (month, type) => `${month}:${type}`;

/** Potencial até o preço teto/justo (fração), ou null. */
export function upside(asset) {
  if (!asset.price || !asset.ceiling) return null;
  return asset.ceiling / asset.price - 1;
}

/** Indicadores resumidos de um relatório. */
export function reportStats(report) {
  const active = report.assets.filter((a) => a.weight > 0);
  const totalW = active.reduce((s, a) => s + a.weight, 0) || 1;
  const weighted = (fn) => {
    let w = 0; let sum = 0;
    for (const a of active) { const v = fn(a); if (v !== null && v !== undefined) { sum += v * a.weight; w += a.weight; } }
    return w ? sum / w : null;
  };
  const bySegment = new Map();
  for (const a of active) bySegment.set(a.segment || 'Outros', (bySegment.get(a.segment || 'Outros') ?? 0) + a.weight / totalW);
  const count = (rec) => report.assets.filter((a) => a.rec === rec).length;
  return {
    assets: active.length,
    weightSum: active.reduce((s, a) => s + a.weight, 0),
    dy: weighted((a) => a.dy),
    upside: weighted(upside),
    buy: count('COMPRAR'),
    wait: count('AGUARDAR') + count('MANTER'),
    sell: count('VENDER'),
    segments: [...bySegment.entries()].map(([name, share]) => ({ name, share })).sort((a, b) => b.share - a.share),
  };
}
