// Ranking do mês: uma nota de 0 a 100 por ativo, juntando a recomendação da casa, a leitura
// da IA (pesa mais quando veio com pesquisa na web), a margem até o preço teto e o DY.
// A conta é simples e visível de propósito: cada ativo mostra o que somou e o que tirou.

import { ASSET_TYPES } from './report.js';

export const GROUPS = {
  oportunidade: { label: 'Oportunidades', hint: 'compra recomendada, IA a favor e preço com margem até o teto' },
  potencial: { label: 'Potenciais', hint: 'bons, mas com alguma ressalva (preço perto do teto ou IA em parte)' },
  aguardar: { label: 'Aguardar', hint: 'casa ou IA mandam esperar um preço melhor' },
  risco: { label: 'Em risco / evitar', hint: 'venda recomendada, IA contra, ou fundamentos piorando' },
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Preço mais recente: o da pesquisa da IA, senão o do relatório. */
export const currentPrice = (asset, an) => an?.price || asset.price || null;

export function scoreAsset(asset, an) {
  const parts = [];
  const add = (pts, why) => { if (pts) parts.push({ pts: Math.round(pts), why }); };
  const web = an && an.searched !== false;
  const w = an ? (web ? 1 : 0.4) * ({ alta: 1, media: 0.8, baixa: 0.5 }[an.confidence] ?? 0.8) : 0;

  add({ COMPRAR: 20, AGUARDAR: 0, MANTER: -5, VENDER: -40 }[asset.rec] ?? 0, `casa: ${asset.rec.toLowerCase()}`);
  if (an) {
    if (an.aiRec) add(({ COMPRAR: 15, AGUARDAR: -5, MANTER: -5, VENDER: -30 }[an.aiRec] ?? 0) * w, `IA${web ? '' : ' (sem web)'}: ${an.aiRec.toLowerCase()}`);
    if (an.verdict) add(({ CONCORDA: 5, PARCIAL: -5, DISCORDA: -15 }[an.verdict] ?? 0) * w, `IA ${an.verdict === 'CONCORDA' ? 'concorda' : an.verdict === 'PARCIAL' ? 'concorda em parte' : 'discorda'}`);
  }
  const price = currentPrice(asset, an);
  const up = asset.ceiling && price ? asset.ceiling / price - 1 : null;
  if (up !== null) add(up < 0 ? Math.max(-20, up * 100) : clamp(up, 0, 0.4) * 40, up < 0 ? `acima do teto (${(up * 100).toFixed(0)}%)` : `margem até o teto +${(up * 100).toFixed(0)}%`);
  if (asset.dy) add(clamp(asset.dy, 0, 0.15) * 40, `DY ${(asset.dy * 100).toFixed(1).replace('.', ',')}%`);

  const score = clamp(Math.round(40 + parts.reduce((s, p) => s + p.pts, 0)), 0, 100);
  let group;
  if (asset.rec === 'VENDER' || (web && (an.verdict === 'DISCORDA' || an.aiRec === 'VENDER')) || score < 30) group = 'risco';
  else if (asset.rec !== 'COMPRAR' || (up !== null && up < 0)) group = 'aguardar';
  else if (score >= 75 && (!an || an.aiRec === 'COMPRAR' || an.verdict === 'CONCORDA' || (!an.aiRec && !an.verdict))) group = 'oportunidade';
  else group = 'potencial'; // casa manda comprar, mas a IA tem ressalva ou a margem é pequena
  return { score, group, parts, upside: up, price };
}

/** Todos os ativos recomendados do mês, com nota, do melhor para o pior. */
export function buildRanking(reports, analyses = {}) {
  const rows = [];
  for (const r of reports) {
    for (const a of r.assets) {
      const an = analyses[a.ticker] ?? null;
      rows.push({ ticker: a.ticker, name: a.name, type: r.type, rec: a.rec, weight: a.weight, ceiling: a.ceiling, an, ...scoreAsset(a, an) });
    }
  }
  return rows.sort((x, y) => y.score - x.score);
}

/** Texto curto do ranking para mandar à IA. */
export function rankingText(ranking) {
  return ranking.map((r) => `${r.ticker} (${ASSET_TYPES[r.type].short}) nota ${r.score} · ${GROUPS[r.group].label} · casa ${r.rec}${r.an ? ` · IA ${r.an.aiRec}/${r.an.verdict}${r.an.searched === false ? ' sem web' : ''}` : ''}${r.upside !== null ? ` · teto ${r.upside >= 0 ? '+' : ''}${(r.upside * 100).toFixed(0)}%` : ''}${r.an?.summary ? ` — ${r.an.summary.slice(0, 220)}` : ''}`).join('\n');
}
