// Carteira do usuário × carteiras recomendadas, e a distribuição de um aporte.
// Funções puras: recebem relatórios, análises da IA, posições e configurações.
//
// Regra do aporte (nunca vende, só compra):
//   1. Alvo de cada classe = (patrimônio atual + aporte) × % alvo da classe.
//      O aporte vai primeiro para as classes mais abaixo do alvo.
//   2. Dentro da classe, o alvo de cada ativo segue o peso da carteira recomendada;
//      o dinheiro vai para os ativos elegíveis mais abaixo do alvo.
//   3. Elegível = recomendação COMPRAR (AGUARDAR/MANTER só se a opção estiver ligada)
//      e, se "respeitar a IA" estiver ligado, sem veredito DISCORDA.
//   4. Ações e FIIs em cotas inteiras; internacional pode ser fracionado.
//   5. Preço atual acima do preço teto → não compra (margem de segurança da casa).
//   6. Aporte pequeno não se pulveriza: no máximo `maxOrders` ativos por mês, os mais
//      abaixo do peso; o rebalanceamento completo acontece ao longo dos meses.

import { ASSET_TYPES, TYPE_IDS } from './report.js';

export const DEFAULT_SETTINGS = {
  targets: { acoes: 0.4, fiis: 0.3, internacional: 0.3 },
  usdBrl: 5.0,
  includeAguardar: false,
  respectAi: true,
  fractionalIntl: true,
  respectCeiling: true, // não compra acima do preço teto/justo do relatório
  maxOrders: 5,         // concentra o aporte nos N ativos mais abaixo do peso (0 = sem limite)
  aporteAmount: 757.4,  // valor padrão do aporte do mês (editável, fica salvo)
};

/** ticker → { ticker, type, asset, analysis } a partir dos relatórios do mês. */
export function buildUniverse(reports, analyses = {}) {
  const map = new Map();
  for (const r of reports) {
    for (const a of r.assets) map.set(a.ticker, { ticker: a.ticker, type: r.type, asset: a, analysis: analyses[a.ticker] ?? null });
  }
  return map;
}

/** Classe de um ticker: pelo relatório, senão pelo formato do código. */
export function classifyTicker(ticker, universe = new Map()) {
  const t = String(ticker).toUpperCase();
  if (universe.has(t)) return universe.get(t).type;
  if (/^[A-Z]{4}11$/.test(t)) return 'fiis';
  if (/^[A-Z]{4}\d{1,2}F?$/.test(t)) return 'acoes';
  return 'internacional';
}

const pctBR = (x, d) => `${(x * 100).toFixed(d).replace('.', ',')}%`;
const fxFor = (type, settings) => (ASSET_TYPES[type]?.currency === 'USD' ? Number(settings.usdBrl) || 0 : 1);

/** Preço atual na moeda do ativo: o informado na posição > IA > relatório > preço médio. */
export function priceOf(ticker, universe, holding) {
  const u = universe.get(ticker);
  return holding?.price || u?.analysis?.price || u?.asset?.price || holding?.avgPrice || null;
}

function holdingRows(holdings, universe, settings) {
  return holdings.map((h) => {
    const price = priceOf(h.ticker, universe, h);
    const fx = fxFor(h.type, settings);
    const value = price ? h.qty * price * fx : 0;
    const cost = h.avgPrice ? h.qty * h.avgPrice * fx : null;
    return { ...h, priceUsed: price, value, cost };
  });
}

/** Pesos alvo dentro da classe (somam 1) — só ativos com peso > 0. */
function classWeights(report) {
  const active = report.assets.filter((a) => a.weight > 0);
  const total = active.reduce((s, a) => s + a.weight, 0);
  return new Map(active.map((a) => [a.ticker, total ? a.weight / total : 0]));
}

function normalizedTargets(settings) {
  const raw = Object.fromEntries(TYPE_IDS.map((t) => [t, Math.max(0, Number(settings.targets?.[t]) || 0)]));
  const sum = Object.values(raw).reduce((s, v) => s + v, 0);
  return Object.fromEntries(TYPE_IDS.map((t) => [t, sum ? raw[t] / sum : 1 / TYPE_IDS.length]));
}

export function comparePortfolio({ holdings, reports, analyses = {}, settings = DEFAULT_SETTINGS }) {
  const universe = buildUniverse(reports, analyses);
  const rows = holdingRows(holdings, universe, settings);
  const total = rows.reduce((s, r) => s + r.value, 0);
  const targets = normalizedTargets(settings);
  const byTicker = new Map(rows.map((r) => [r.ticker, r]));

  const classes = TYPE_IDS.map((type) => {
    const report = reports.find((r) => r.type === type) ?? null;
    const mine = rows.filter((r) => r.type === type);
    const value = mine.reduce((s, r) => s + r.value, 0);
    const weights = report ? classWeights(report) : new Map();
    const assets = (report?.assets ?? []).map((a) => {
      const h = byTicker.get(a.ticker);
      const myValue = h?.value ?? 0;
      const myWeight = value ? myValue / value : 0;
      const targetWeight = weights.get(a.ticker) ?? 0;
      return {
        ticker: a.ticker, name: a.name, rec: a.rec, verdict: analyses[a.ticker]?.verdict ?? null,
        targetWeight, myValue, myWeight, gap: targetWeight - myWeight, owned: Boolean(h),
      };
    });
    return {
      type, label: ASSET_TYPES[type].label, hasReport: Boolean(report),
      value, pct: total ? value / total : 0, target: targets[type],
      assets, outside: mine.filter((h) => !report?.assets.some((a) => a.ticker === h.ticker)),
    };
  });

  const alerts = [];
  for (const r of rows) {
    const u = universe.get(r.ticker);
    if (u?.asset.rec === 'VENDER') alerts.push({ ticker: r.ticker, kind: 'vender', message: `${r.ticker}: o relatório recomenda VENDER.` });
    else if (u?.analysis?.verdict === 'DISCORDA') alerts.push({ ticker: r.ticker, kind: 'discorda', message: `${r.ticker}: a IA discorda da recomendação (${u.asset.rec}).` });
    else if (!u && reports.some((rep) => rep.type === r.type)) alerts.push({ ticker: r.ticker, kind: 'fora', message: `${r.ticker}: não está na carteira recomendada de ${ASSET_TYPES[r.type].short} deste mês. Continua no seu patrimônio; só não recebe aporte novo.` });
    if (!r.priceUsed) alerts.push({ ticker: r.ticker, kind: 'preco', message: `${r.ticker}: sem preço — informe o preço atual para entrar nas contas.` });
  }
  for (const c of classes) {
    const missing = c.assets.filter((a) => !a.owned && a.targetWeight > 0 && a.rec === 'COMPRAR').map((a) => a.ticker);
    if (missing.length) alerts.push({ tickers: missing, kind: 'falta', message: `${ASSET_TYPES[c.type].short} com recomendação de compra que você ainda não tem: ${missing.join(', ')}.` });
  }
  return { total, rows, classes, alerts };
}

/**
 * Divide `amount` entre itens { key, current, target, weight }:
 * primeiro cobre o que falta para o alvo; se sobrar, divide pelo peso.
 */
export function allocate(amount, items) {
  const out = new Map(items.map((i) => [i.key, 0]));
  if (amount <= 0 || !items.length) return out;
  const deficits = items.map((i) => Math.max(0, i.target - i.current));
  const D = deficits.reduce((s, d) => s + d, 0);
  if (D >= amount) {
    items.forEach((i, k) => out.set(i.key, (amount * deficits[k]) / D));
    return out;
  }
  const W = items.reduce((s, i) => s + i.weight, 0);
  items.forEach((i, k) => out.set(i.key, deficits[k] + (amount - D) * (W ? i.weight / W : 1 / items.length)));
  return out;
}

export function planAporte({ amount, holdings, reports, analyses = {}, settings = DEFAULT_SETTINGS }) {
  const cmp = comparePortfolio({ holdings, reports, analyses, settings });
  const universe = buildUniverse(reports, analyses);
  const targets = normalizedTargets(settings);
  const warnings = [];
  amount = Math.max(0, Number(amount) || 0);
  const totalAfter = cmp.total + amount;

  const excluded = { ceiling: [], ai: [], aiNoWeb: [], noPrice: [] };
  const isEligible = (a) => {
    if (a.weight <= 0) return false;
    const recOk = a.rec === 'COMPRAR' || (settings.includeAguardar && (a.rec === 'AGUARDAR' || a.rec === 'MANTER'));
    if (!recOk) return false;
    const price = priceOf(a.ticker, universe, holdings.find((h) => h.ticker === a.ticker));
    if (!price) { excluded.noPrice.push(a.ticker); return false; }
    const an = analyses[a.ticker];
    if (settings.respectAi && an?.verdict === 'DISCORDA') {
      // Só bloqueia quem foi avaliado com pesquisa na web; sem dados atuais vira só um aviso.
      if (an.searched === false) excluded.aiNoWeb.push(a.ticker);
      else { excluded.ai.push(a.ticker); return false; }
    }
    if (settings.respectCeiling !== false && a.ceiling && price > a.ceiling) { excluded.ceiling.push(a.ticker); return false; }
    return true;
  };

  // 1) entre classes
  const classItems = [];
  for (const c of cmp.classes) {
    const report = reports.find((r) => r.type === c.type);
    const eligible = report?.assets.filter(isEligible) ?? [];
    if (!report) { if (targets[c.type] > 0) warnings.push(`Sem relatório de ${ASSET_TYPES[c.type].short} neste mês — a classe não recebe aporte.`); continue; }
    if (!eligible.length) { warnings.push(`Nenhum ativo de ${ASSET_TYPES[c.type].short} elegível (só COMPRAR${settings.respectAi ? ' e sem veredito DISCORDA da IA' : ''}).`); continue; }
    if (c.type === 'internacional' && !(Number(settings.usdBrl) > 0)) { warnings.push('Informe a cotação do dólar para incluir a carteira internacional.'); continue; }
    classItems.push({ key: c.type, current: c.value, target: totalAfter * targets[c.type], weight: targets[c.type], eligible, report });
  }
  const perClass = allocate(amount, classItems);

  // 2) dentro de cada classe
  const lines = [];
  const holdingValue = new Map(cmp.rows.map((r) => [r.ticker, r.value]));
  for (const ci of classItems) {
    const classAmount = perClass.get(ci.key);
    const weights = classWeights(ci.report);
    const classAfter = ci.current + classAmount;
    const items = ci.eligible.map((a) => ({
      key: a.ticker, current: holdingValue.get(a.ticker) ?? 0, target: classAfter * (weights.get(a.ticker) ?? 0), weight: weights.get(a.ticker) ?? 0,
    }));
    const perAsset = allocate(classAmount, items);
    const fx = fxFor(ci.key, settings);
    for (const a of ci.eligible) {
      const price = priceOf(a.ticker, universe, holdings.find((h) => h.ticker === a.ticker));
      const it = items.find((i) => i.key === a.ticker);
      const cls = cmp.classes.find((c) => c.type === ci.key);
      const mine = cls.value ? it.current / cls.value : 0;
      const up = a.ceiling && price ? a.ceiling / price - 1 : null;
      lines.push({
        ticker: a.ticker, name: a.name, type: ci.key, rec: a.rec, verdict: analyses[a.ticker]?.verdict ?? null,
        price, currency: ASSET_TYPES[ci.key].currency, unitBRL: price * fx, ideal: perAsset.get(a.ticker),
        deficit: it.target - it.current, fractional: ci.key === 'internacional' && settings.fractionalIntl,
        qty: 0, amount: 0,
        reason: [
          `${ASSET_TYPES[ci.key].short}: ${pctBR(cls.pct, 0)} do patrimônio, alvo ${pctBR(targets[ci.key], 0)}`,
          `peso no ativo: você ${pctBR(mine, 1)}, recomendado ${pctBR(weights.get(a.ticker) ?? 0, 1)}`,
          up !== null ? `potencial ${up >= 0 ? '+' : ''}${(up * 100).toFixed(0)}% até o teto` : '',
        ].filter(Boolean).join(' · '),
      });
    }
  }

  // 2b) concentra em até N ativos, repartidos entre as classes pelo dinheiro de cada uma
  //     (toda classe com fatia relevante fica com ao menos 1); o dinheiro dos ativos que
  //     ficaram de fora vai para os escolhidos da MESMA classe, para não distorcer o alvo.
  const maxOrders = Number(settings.maxOrders) || 0;
  if (maxOrders > 0 && lines.length > maxOrders) {
    const byClass = new Map();
    for (const l of lines) { if (!byClass.has(l.type)) byClass.set(l.type, []); byClass.get(l.type).push(l); }
    const classAmt = (t) => byClass.get(t).reduce((s2, l) => s2 + l.ideal, 0);
    const relevant = [...byClass.keys()].filter((t) => classAmt(t) >= amount * 0.1 || byClass.size === 1)
      .sort((a, b) => classAmt(b) - classAmt(a));
    const quota = new Map(relevant.map((t) => [t, 1]));
    let left = maxOrders - relevant.length;
    while (left > 0) { // dá as vagas restantes a quem tem mais dinheiro por vaga
      const t = relevant.filter((c) => quota.get(c) < byClass.get(c).length).sort((a, b) => classAmt(b) / quota.get(b) - classAmt(a) / quota.get(a))[0];
      if (!t) break;
      quota.set(t, quota.get(t) + 1); left--;
    }
    const kept = []; const dropped = [];
    const sumIdeal = (ls) => ls.reduce((s2, l) => s2 + l.ideal, 0);
    for (const [t, ls] of byClass) {
      ls.sort((a, b) => b.ideal - a.ideal);
      const keep = ls.slice(0, quota.get(t) ?? 0);
      const drop = ls.slice(keep.length);
      dropped.push(...drop);
      const extra = sumIdeal(drop); const base = sumIdeal(keep);
      for (const l of keep) l.ideal += base ? extra * (l.ideal / base) : extra / keep.length;
      kept.push(...keep);
    }
    lines.length = 0; lines.push(...kept);
    // Classe com fatia pequena (menos de 10%) não ganha vaga: o dinheiro dela vai para os escolhidos.
    const lost = amount - sumIdeal(kept);
    if (lost > 0.01) { const base = sumIdeal(kept); for (const l of kept) l.ideal += base ? lost * (l.ideal / base) : lost / kept.length; }
    warnings.push(`Aporte concentrado em ${kept.length} ativos (os mais abaixo do peso em cada classe). Ficaram para os próximos meses: ${dropped.map((l) => l.ticker).join(', ')}.`);
  }

  // 3) cotas: arredonda para baixo e usa a sobra comprando cotas inteiras onde mais falta
  let leftover = amount;
  for (const l of lines) {
    l.qty = l.fractional ? Math.floor((l.ideal / l.unitBRL) * 10000) / 10000 : Math.floor(l.ideal / l.unitBRL + 1e-9);
    l.amount = l.qty * l.unitBRL;
    leftover -= l.amount;
  }
  const whole = lines.filter((l) => !l.fractional);
  for (let guard = 0; guard < 5000; guard++) {
    const candidates = whole.filter((l) => l.unitBRL <= leftover + 1e-6);
    if (!candidates.length) break;
    const best = candidates.reduce((b, l) => ((l.deficit - l.amount) > (b.deficit - b.amount) ? l : b));
    best.qty += 1; best.amount += best.unitBRL; leftover -= best.unitBRL;
  }

  const bought = lines.filter((l) => l.qty > 0).sort((a, b) => b.amount - a.amount);
  const invested = bought.reduce((s, l) => s + l.amount, 0);
  const totalFinal = cmp.total + invested;
  const classes = cmp.classes.map((c) => {
    const add = bought.filter((l) => l.type === c.type).reduce((s, l) => s + l.amount, 0);
    return {
      type: c.type, label: c.label, before: c.value, added: add, after: c.value + add,
      pctBefore: cmp.total ? c.value / cmp.total : 0, pctAfter: totalFinal ? (c.value + add) / totalFinal : 0, target: targets[c.type],
    };
  });
  if (excluded.ceiling.length) warnings.push(`Em COMPRAR, mas com preço acima do teto (não compra agora): ${excluded.ceiling.join(', ')}.`);
  if (excluded.ai.length) warnings.push(`Fora porque a IA discorda da compra: ${excluded.ai.join(', ')}.`);
  if (excluded.aiNoWeb.length) warnings.push(`A IA discorda de ${excluded.aiNoWeb.join(', ')}, mas sem pesquisa na web; não bloqueei. Confirme com a análise por copiar e colar.`);
  if (excluded.noPrice.length) warnings.push(`Sem preço para calcular: ${excluded.noPrice.join(', ')}.`);
  return {
    amount, invested, leftover: Math.max(0, amount - invested),
    lines: bought, classes, warnings,
    sellAlerts: cmp.alerts.filter((a) => a.kind === 'vender'),
  };
}
