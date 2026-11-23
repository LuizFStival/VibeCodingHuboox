// Ranking do mês: uma nota de 0 a 100 por ativo. Junta a recomendação da casa, a leitura
// independente da IA (pesa mais quando veio com pesquisa na web e confiança alta), a QUALIDADE
// e os RISCOS que a pesquisa encontrou (lucro, dívida, dividendos sustentáveis ou não,
// inadimplência, notícias) e, com peso menor, a margem até o preço teto e o DY.
// A conta é visível de propósito: cada ativo mostra o que somou e o que tirou.

import { ASSET_TYPES } from './report.js';

export const GROUPS = {
  oportunidade: { label: 'Oportunidades', hint: 'compra recomendada, IA a favor, sem riscos relevantes e preço com margem até o teto' },
  potencial: { label: 'Potenciais (atenção)', hint: 'a casa manda comprar, mas a pesquisa tem ressalva ou encontrou riscos: entram no aporte com peso menor' },
  aguardar: { label: 'Aguardar', hint: 'casa ou IA mandam esperar um preço melhor' },
  risco: { label: 'Em risco / evitar', hint: 'venda recomendada, IA contra, ou fundamentos piorando' },
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Preço mais recente: o da pesquisa da IA, senão o do relatório. */
export const currentPrice = (asset, an) => an?.price || asset.price || null;

// Sinais de risco procurados no que a pesquisa escreveu (riscos, fundamentos, resumo e
// notícias negativas). `div` = ameaça a sustentabilidade do dividendo.
const FLAGS = [
  ['div', 'distribuição acima do resultado', /distribu\w*\s+(acima|mais)\s+do\s+que\s+(ger|o\s+result)|resultado\s+(abaixo|menor)\s+(do|que\s+o)\s+distribu|cobertura\s+(insuficiente|baixa|fraca)|(usou|consumo\s+de|queima\s+de|caíram\s+as)\s+reservas|reservas\s+(caíram|zerad|baixas)/i],
  ['div', 'rendimento com parte não recorrente', /n[aã]o[\s-]recorrente|extraordin[aá]ri|pontua(l|is)\s+(ganho|venda)|ganho\s+de\s+capital\s+(pontual|n[aã]o)/i],
  ['div', 'corte de dividendos', /cort\w*\s+(de\s+|o\s+|do\s+|nos\s+)?(rendimento|dividendo|provento|payout)|redu\w*\s+(d[oa]s?\s+)?(rendimento|dividendo|provento|payout)|payout\s+(menor|reduzid|cortad)/i],
  ['credit', 'inadimplência / risco de crédito', /inadimpl|default|calote|risco\s+de\s+cr[eé]dito\s+(alto|elevad)/i],
  ['debt', 'endividamento / alavancagem', /alavancagem\s+(alta|elevad|cresc|subiu|aument|acima)|alavancad|eleva[cç][aã]o\s+do\s+endividamento|endividamento\s+(alto|elevad|cresc)|d[ií]vida\s+(alta|elevad|cara|cresc)|crescimento\s+da\s+d[ií]vida/i],
  ['earn', 'lucro ou resultado em queda', /queda\s+(d[oa]\s+)?(lucro|resultado|receita|margem)|preju[ií]zo|lucro\s+(caiu|menor|recuou)|margens?\s+(menor|press|caiu)/i],
  ['earn', 'revisão de guidance para baixo', /guidance\s+(rebaixad|revisad\w*\s+para\s+baixo|cortad|reduzid)|rebaix\w*\s+(de\s+)?(rating|recomenda)/i],
  ['vac', 'vacância em alta', /vac[aâ]ncia\s+(alta|elevad|subiu|aument|cresc)/i],
  ['event', 'evento societário em andamento', /liquida[cç][aã]o|incorpora[cç][aã]o|fus[aã]o|reestrutura/i],
  ['gov', 'risco político / estatal', /interfer|ingerên|uso\s+pol[ií]tico|risco\s+(pol[ií]tico|estatal)/i],
];

/** Riscos encontrados na pesquisa (no máximo um por tipo) e se o dividendo parece sustentável. */
export function riskSignals(an) {
  if (!an) return { flags: [], dividendRisk: false };
  const neg = (an.news ?? []).filter((n) => n.impact === 'negativo').map((n) => n.title);
  const text = [...(an.risks ?? []), ...(an.fundamentals ?? []), an.summary ?? '', ...neg].join(' \n ');
  const flags = []; const seen = new Set();
  for (const [kind, label, re] of FLAGS) if (re.test(text) && !seen.has(label)) { seen.add(label); flags.push({ kind, label }); }
  let dividendRisk = flags.some((f) => f.kind === 'div');
  if (an.dividendQuality === 'insustentavel' || an.dividendQuality === 'incerta') dividendRisk = true;
  if (an.dividendQuality === 'sustentavel') dividendRisk = false;
  return { flags, dividendRisk };
}

export function scoreAsset(asset, an) {
  const parts = [];
  const add = (pts, why) => { if (pts) parts.push({ pts: Math.round(pts), why }); };
  const web = an && an.searched !== false;
  const stale = an?.stale === true;
  const w = an ? (web ? 1 : 0.4) * ({ alta: 1, media: 0.8, baixa: 0.5 }[an.confidence] ?? 0.8) * (stale ? 0.5 : 1) : 0;

  add({ COMPRAR: 15, AGUARDAR: 0, MANTER: -5, VENDER: -40 }[asset.rec] ?? 0, `casa: ${asset.rec.toLowerCase()}`);
  if (an) {
    if (an.aiRec) add(({ COMPRAR: 12, AGUARDAR: -8, MANTER: -6, VENDER: -30 }[an.aiRec] ?? 0) * w, `IA${web ? '' : ' (sem web)'}: ${an.aiRec.toLowerCase()}`);
    else add(-6, 'IA sem recomendação clara');
    if (an.verdict) add(({ CONCORDA: 6, PARCIAL: -5, DISCORDA: -15 }[an.verdict] ?? 0) * w, `IA ${an.verdict === 'CONCORDA' ? 'concorda' : an.verdict === 'PARCIAL' ? 'concorda em parte' : 'discorda'}`);
    if (stale) add(-5, 'pesquisa possivelmente desatualizada');
  } else {
    add(-10, 'sem pesquisa da IA');
  }

  // Qualidade e riscos (o que mais pesa depois das recomendações).
  const { flags, dividendRisk } = riskSignals(an);
  if (Number.isFinite(an?.quality)) add((clamp(an.quality, 0, 10) - 5) * 2, `qualidade ${an.quality}/10`);
  if (an?.riskLevel) add({ baixo: 3, medio: 0, alto: -6 }[an.riskLevel] ?? 0, `risco ${an.riskLevel}`);
  if (flags.length) add(-Math.min(14, flags.length * 4), `riscos: ${flags.map((f) => f.label).join(', ')}`);
  const negNews = (an?.news ?? []).filter((n) => n.impact === 'negativo').length;
  const posNews = (an?.news ?? []).filter((n) => n.impact === 'positivo').length;
  if (negNews) add(-Math.min(6, negNews * 2), `${negNews} notícia(s) negativa(s)`);
  if (posNews) add(Math.min(3, posNews * 1.5), `${posNews} notícia(s) positiva(s)`);

  // Preço: margem até o teto pesa pouco (no máximo +6); acima do teto penaliza.
  const price = currentPrice(asset, an);
  const up = asset.ceiling && price ? asset.ceiling / price - 1 : null;
  if (up !== null) add(up < 0 ? Math.max(-20, up * 100) : clamp(up, 0, 0.25) * 24, up < 0 ? `acima do teto (${(up * 100).toFixed(0)}%)` : `margem até o teto +${(up * 100).toFixed(0)}%`);
  // DY só conta se a pesquisa não viu risco no dividendo; distribuição duvidosa penaliza.
  if (asset.dy && !dividendRisk) add(clamp(asset.dy, 0, 0.12) * 25, `DY ${(asset.dy * 100).toFixed(1).replace('.', ',')}%`);
  if (dividendRisk) add(-3, 'dividendo com sustentabilidade duvidosa');

  const score = clamp(Math.round(45 + parts.reduce((s, p) => s + p.pts, 0)), 0, 100);
  let group;
  // "em risco" pede um motivo de fundamento (venda, IA contra ou nota baixa com pesquisa); só faltar pesquisa não basta
  if (asset.rec === 'VENDER' || (web && (an.verdict === 'DISCORDA' || an.aiRec === 'VENDER')) || (an && score < 30)) group = 'risco';
  else if (asset.rec !== 'COMPRAR' || (up !== null && up < 0) || (web && (an.aiRec === 'AGUARDAR' || an.aiRec === 'MANTER'))) group = 'aguardar';
  else if (score >= 75 && (!an || an.aiRec === 'COMPRAR' || an.verdict === 'CONCORDA' || (!an.aiRec && !an.verdict)) && !dividendRisk) group = 'oportunidade';
  else group = 'potencial'; // casa manda comprar, mas a IA tem ressalva, há riscos ou a margem é pequena
  return { score, group, parts, upside: up, price, flags, dividendRisk };
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
  return rows.sort((x, y) => y.score - x.score || x.ticker.localeCompare(y.ticker));
}

/** Texto curto do ranking para mandar à IA. */
export function rankingText(ranking) {
  return ranking.map((r) => `${r.ticker} (${ASSET_TYPES[r.type].short}) nota ${r.score} · ${GROUPS[r.group].label} · casa ${r.rec}${r.an ? ` · IA ${r.an.aiRec}/${r.an.verdict}${r.an.searched === false ? ' sem web' : ''}` : ''}${r.upside !== null ? ` · teto ${r.upside >= 0 ? '+' : ''}${(r.upside * 100).toFixed(0)}%` : ''}${r.flags?.length ? ` · riscos: ${r.flags.map((f) => f.label).join(', ')}` : ''}${r.an?.summary ? ` — ${r.an.summary.slice(0, 220)}` : ''}`).join('\n');
}
