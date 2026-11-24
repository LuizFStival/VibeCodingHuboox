// Setores econômicos padronizados, para medir concentração de risco.
//
// Cada casa escreve o segmento do seu jeito ("Petróleo e Gás", "Petrolífero", "Bancos",
// "Financeiro"...). Aqui eles viram um agrupamento só: duas empresas do mesmo setor não
// diversificam o risco. ETFs amplos (índice) contam como "diversificado" e têm limite próprio.

export const DIVERSIFIED = 'Diversificado (índice amplo)';

// Tickers cujo setor não sai do segmento do relatório (ETFs e casos conhecidos).
const BY_TICKER = {
  VOO: DIVERSIFIED, IVV: DIVERSIFIED, SPY: DIVERSIFIED, VTI: DIVERSIFIED, VT: DIVERSIFIED, ACWI: DIVERSIFIED,
  VXUS: DIVERSIFIED, EEM: DIVERSIFIED, VWO: DIVERSIFIED, IEMG: DIVERSIFIED, QQQ: DIVERSIFIED, SCHD: DIVERSIFIED,
  DIVO11: DIVERSIFIED, BOVA11: DIVERSIFIED, SMAL11: DIVERSIFIED, IVVB11: DIVERSIFIED, BOVV11: DIVERSIFIED, PIBB11: DIVERSIFIED,
  GLD: 'Ouro', IAU: 'Ouro', GOLD11: 'Ouro',
  CPER: 'Metais industriais', COPX: 'Metais industriais',
  SGOV: 'Renda fixa EUA', BIL: 'Renda fixa EUA', SHV: 'Renda fixa EUA', TLT: 'Renda fixa EUA',
  IBIT: 'Cripto', FBTC: 'Cripto', HASH11: 'Cripto',
  BORR: 'Petróleo e gás',
  KO: 'Consumo', PEP: 'Consumo',
};

// Segmento (como vem do relatório ou da posição) → setor padronizado. A primeira regra que casa vence.
const RULES = [
  [/petr[oó]l|[oó]leo|\bg[aá]s\b|perfura|drilling|offshore/i, 'Petróleo e gás'],
  [/banc|financ/i, 'Bancos'],
  [/segur/i, 'Seguros'],
  [/el[eé]tric|energia/i, 'Energia elétrica'],
  [/saneam|[aá]gua/i, 'Saneamento'],
  [/minera|min[eé]rio|sider|metal/i, 'Mineração e siderurgia'],
  [/ibov|[ií]ndice|etf amplo/i, DIVERSIFIED],
  [/log[ií]st|galp/i, 'Logístico'],
  [/papel|receb[ií]v|\bcri\b|cr[eé]dito/i, 'Papel (crédito imobiliário)'],
  [/h[ií]brid/i, 'Híbrido'],
  [/laje|corporativ|escrit/i, 'Lajes corporativas'],
  [/shopping|mall/i, 'Shopping'],
  [/renda urbana/i, 'Renda urbana'],
  [/agro|terra/i, 'Agronegócio'],
  [/reit/i, 'Imóveis EUA (REIT)'],
  [/cripto|bitcoin/i, 'Cripto'],
  [/industr|bens de capital|m[aá]quin/i, 'Industrial'],
  [/consumo|bebida|aliment|varejo/i, 'Consumo'],
];

/**
 * Setor padronizado de um ativo. `overrides` (configurações) permite corrigir um ticker.
 * Sem segmento conhecido, o ativo fica num setor só dele (não é agrupado por engano).
 */
export function sectorOf(ticker, segment = '', overrides = {}) {
  const t = String(ticker ?? '').toUpperCase();
  if (overrides[t]) return overrides[t];
  if (BY_TICKER[t]) return BY_TICKER[t];
  const s = String(segment ?? '').trim();
  if (/^(etf|stock|a[cç][aã]o|a[cç][oõ]es|fii|outros?)$/i.test(s)) return `Outros (${t})`; // genérico demais para agrupar
  for (const [re, name] of RULES) if (re.test(s)) return name;
  return s ? s[0].toUpperCase() + s.slice(1) : `Outros (${t})`;
}

export const isDiversified = (sector) => sector === DIVERSIFIED;
