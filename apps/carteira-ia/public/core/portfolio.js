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
import { scoreAsset } from './ranking.js';
import { sectorOf, isDiversified } from './sectors.js';
import { optimizeBuys } from './optimizer.js';

export const DEFAULT_SETTINGS = {
  targets: { acoes: 0.4, fiis: 0.3, internacional: 0.3 },
  usdBrl: 5.0,
  includeAguardar: false,
  respectAi: true,
  fractionalIntl: true,
  respectCeiling: true, // não compra acima do preço teto/justo do relatório
  maxOrders: 5,         // concentra o aporte nos N ativos mais abaixo do peso (0 = sem limite)
  respectAiWait: true,  // "aguardar" da pesquisa (com web) também tira o ativo da compra
  preferOwned: true,    // dentro do segmento, reforça o que você já tem antes de abrir posição nova
  maxNew: 2,            // no máximo N posições novas por aporte
  aporteAmount: 500,    // valor padrão do aporte do mês (editável, fica salvo)
  usdCash: 0,           // dólares já parados na corretora no exterior: pagam as compras do internacional
  dollarReserve: 0,     // reais guardados na "caixinha do dólar" esperando o envio mínimo
  minRemitUSD: 50,      // envio mínimo para o exterior (Nomad: US$ 50); 0 = envia todo mês
  lock: null,           // senha de acesso: { salt, hash, iterations, hint } (só o hash, nunca a senha)
  autoLockMin: 15,      // bloqueia sozinho depois de N minutos parado (0 = nunca)
  startHidden: false,   // abrir sempre com os valores ocultos
  // Limites de concentração, em fração da classe (configuráveis). Ativo já acima do limite
  // é mantido, mas não recebe aporte que aumente o seu peso. Nada é vendido.
  limits: { acoes: 0.15, fiis: 0.12, internacional: 0.20, etfAmplo: 0.40, setor: 0.20 },
  limitMargin: 0.01,     // folga: compra até 1 ponto abaixo de cada limite (espaço para a cotação subir)
  requireResearch: true, // sem pesquisa atual da IA (com web), o ativo não entra na proposta
  sectorOverrides: {},   // correções de setor por ticker, ex.: { "XYZW3": "Bancos" }
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

/** Segmento de um ativo: o do relatório; senão o que você informou na posição; senão "Outros". */
export function segmentOfAsset(ticker, report, holdings = []) {
  return report?.assets.find((x) => x.ticker === ticker)?.segment || holdings.find((h) => h.ticker === ticker)?.segment || 'Outros';
}
const short = (t, n = 140) => { const s = String(t ?? '').split(/(?<=[.!?])\s/)[0]; return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const pctBR = (x, d) => `${(x * 100).toFixed(d).replace('.', ',')}%`;
const fxFor = (type, settings) => (ASSET_TYPES[type]?.currency === 'USD' ? Number(settings.usdBrl) || 0 : 1);

/** Preço atual na moeda do ativo: o informado na posição > IA > relatório > preço médio. */
export function priceOf(ticker, universe, holding, overrides = {}) {
  const u = universe.get(ticker);
  return overrides?.[ticker] || holding?.price || u?.analysis?.price || u?.asset?.price || holding?.avgPrice || null;
}

function holdingRows(holdings, universe, settings) {
  return holdings.map((h) => {
    const price = priceOf(h.ticker, universe, h, settings.prices);
    const fx = fxFor(h.type, settings);
    const value = price ? h.qty * price * fx : 0;
    const cost = h.avgPrice ? h.qty * h.avgPrice * fx : null;
    const segment = universe.get(h.ticker)?.asset?.segment || h.segment || 'Outros';
    return { ...h, priceUsed: price, value, cost, segment };
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
    else if (r.frozen && !u) alerts.push({ ticker: r.ticker, kind: 'congelado', message: `${r.ticker}: congelado (antigo, fora do relatório). Mantido no patrimônio, sem aporte; se voltar ao relatório, volta a valer sozinho.` });
    else if (r.frozen && u) alerts.push({ ticker: r.ticker, kind: 'voltou', message: `${r.ticker}: voltou ao relatório (${u.asset.rec}) e saiu do congelado neste mês.` });
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
  const brl = Math.max(0, Number(amount) || 0); // reais do aporte
  // Caixa em dólar já no exterior: faz parte do patrimônio e paga o internacional sem remessa.
  const usdCash = Math.max(0, Number(settings.usdCash) || 0);
  const usdBrl = Number(settings.usdBrl) || 0;
  const usdCashBRL = usdCash * usdBrl;
  // Caixinha do dólar: a parte do internacional em reais junta aqui até dar o envio mínimo.
  const reserve = Math.max(0, Number(settings.dollarReserve) || 0);
  const minRemit = settings.minRemitUSD === undefined ? 50 : Math.max(0, Number(settings.minRemitUSD) || 0);
  const totalBefore = cmp.total + usdCashBRL + reserve;
  const totalAfter = totalBefore + brl;

  const excluded = { ceiling: [], ai: [], aiWait: [], aiNoWeb: [], noPrice: [], user: [], house: [], noData: [] };
  const today = settings.today ? new Date(settings.today) : new Date();
  const reportOf = (t) => reports.find((r) => r.assets.some((a) => a.ticker === t));
  // Congelado = posição antiga, fora do relatório: fica na carteira sem aporte. Se o ativo voltar
  // ao relatório do mês, ele volta a valer normalmente (as regras de compra decidem).
  const frozenBack = holdings.filter((h) => h.frozen && universe.has(h.ticker)).map((h) => h.ticker);
  const include = new Set(settings.include ?? []); // você mandou incluir (ex.: sugestão da IA)
  const exclude = new Set(settings.exclude ?? []); // você tirou da proposta
  const queue = [];
  const isEligible = (a) => {
    if (exclude.has(a.ticker)) { excluded.user.push(a.ticker); return false; }
    if (include.has(a.ticker) && a.rec !== 'VENDER') {
      const p = priceOf(a.ticker, universe, holdings.find((h) => h.ticker === a.ticker), settings.prices);
      if (p) return true;
    }
    if (a.weight <= 0) return false;
    const recOk = a.rec === 'COMPRAR' || (settings.includeAguardar && (a.rec === 'AGUARDAR' || a.rec === 'MANTER'));
    if (!recOk) { if (a.rec !== 'VENDER') excluded.house.push(a.ticker); return false; }
    const price = priceOf(a.ticker, universe, holdings.find((h) => h.ticker === a.ticker), settings.prices);
    if (!price) { excluded.noPrice.push(a.ticker); return false; }
    const an = analyses[a.ticker];
    // Sem pesquisa atual (com web e depois da leitura do relatório): pede revisão antes de recomendar.
    if (settings.requireResearch === true) {
      const rep = reportOf(a.ticker);
      const at = an?.analyzedAt ? new Date(an.analyzedAt) : null;
      const why = !an ? 'sem pesquisa da IA' : an.searched === false ? 'pesquisa sem web (sem dados atuais)'
        : at && rep?.importedAt && at < new Date(rep.importedAt) ? 'pesquisa feita antes do relatório deste mês'
        : at && (today - at) / 86400000 > 45 ? `pesquisa de ${at.toLocaleDateString('pt-BR')} (mais de 45 dias)` : null;
      if (why) { excluded.noData.push({ ticker: a.ticker, why }); return false; }
    }
    if (settings.respectAi && (an?.verdict === 'DISCORDA' || an?.aiRec === 'VENDER')) {
      // Só bloqueia quem foi avaliado com pesquisa na web; sem dados atuais vira só um aviso.
      if (an.searched === false) excluded.aiNoWeb.push(a.ticker);
      else { excluded.ai.push({ ticker: a.ticker, why: an.summary }); return false; }
    }
    if (settings.respectCeiling !== false && a.ceiling && price > a.ceiling) { excluded.ceiling.push(a.ticker); return false; }
    // A casa diz comprar, mas a pesquisa (com web) diz aguardar/manter: fica em atenção, sem compra.
    if (settings.respectAiWait !== false && an && an.searched !== false && (an.aiRec === 'AGUARDAR' || an.aiRec === 'MANTER')) {
      excluded.aiWait.push({ ticker: a.ticker, why: an.summary }); return false;
    }
    // PARCIAL não quer dizer "comprar": sem recomendação clara da IA, fica em atenção.
    if (settings.respectAiWait !== false && an && an.searched !== false && an.verdict === 'PARCIAL' && !an.aiRec) {
      excluded.aiWait.push({ ticker: a.ticker, why: `a IA concorda só em parte e não deu recomendação clara. ${an.summary ?? ''}`.trim() }); return false;
    }
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
  const intlItem = classItems.find((c) => c.key === 'internacional');
  // Dois bolsos: o internacional só gasta dólar (o caixa lá fora + a remessa do mês, se houver);
  // ações e FIIs só gastam reais.
  const split = Boolean(intlItem);
  let perClass; let intlShare = 0; let pending = reserve; let remitNow = false;
  if (intlItem) {
    // O que já está lá fora ou na caixinha conta como internacional para a divisão entre classes.
    perClass = allocate(brl, classItems.map((c) => (c.key === 'internacional' ? { ...c, current: c.current + usdCashBRL + reserve } : c)));
    intlShare = perClass.get('internacional') ?? 0;
    pending = reserve + intlShare;
    remitNow = pending > 0.01 && usdBrl > 0 && pending / usdBrl >= minRemit - 1e-9;
    perClass.set('internacional', usdCashBRL + (remitNow ? pending : 0));
  } else {
    perClass = allocate(brl, classItems);
    if (usdCashBRL > 0) warnings.push(`Há US$ ${usdCash.toFixed(2).replace('.', ',')} na corretora no exterior, mas nenhum ativo internacional pode ser comprado este mês: o caixa fica parado lá.`);
  }
  const brlForBR = brl - intlShare;
  const usdPool = intlItem ? usdCashBRL + (remitNow ? pending : 0) : 0;
  amount = brlForBR + usdPool; // tudo o que pode ser investido agora
  const poolOf = (l) => (split && l.type === 'internacional' ? 'usd' : 'brl');

  // 2) escolha das compras olhando a carteira resultante (optimizer.js): metas por classe,
  //    qualidade e riscos de cada ativo, peso recomendado pela casa e limites de concentração
  //    por ativo e por setor. Combina até `maxOrders` ativos (no máximo `maxNew` novos).
  const lim = { ...DEFAULT_SETTINGS.limits, ...(settings.limits ?? {}) };
  // Folga: o otimizador compra até um pouco abaixo de cada limite (a cotação pode subir depois).
  const margin = Math.max(0, Math.min(0.1, Number(settings.limitMargin) || 0));
  const buyLimit = (x) => Math.max(0.01, x - margin);
  const overrides = settings.sectorOverrides ?? {};
  const holdingValue = new Map(cmp.rows.map((r) => [r.ticker, r.value]));
  const sectorOfRow = (r) => sectorOf(r.ticker, reports.find((rep) => rep.type === r.type)?.assets.find((a) => a.ticker === r.ticker)?.segment || r.segment, overrides);
  const optClasses = {};
  for (const c of cmp.classes) {
    const assets = new Map(); const sectors = new Map();
    for (const r of cmp.rows.filter((x) => x.type === c.type)) {
      assets.set(r.ticker, r.value);
      const sec = sectorOfRow(r);
      sectors.set(sec, (sectors.get(sec) ?? 0) + r.value);
    }
    const isIntl = c.type === 'internacional';
    // No internacional, comprar só troca caixa reservado por posição: o peso da classe não muda.
    optClasses[c.type] = { invested: c.value, reserved: isIntl ? usdCashBRL + reserve + intlShare : 0, fixed: isIntl, target: targets[c.type], assets, sectors };
  }
  const candidates = [];
  for (const ci of classItems) {
    const weights = classWeights(ci.report);
    const fx = fxFor(ci.key, settings);
    for (const a of ci.eligible) {
      const own = holdings.find((h) => h.ticker === a.ticker);
      const price = priceOf(a.ticker, universe, own, settings.prices);
      const an = analyses[a.ticker];
      const sc = scoreAsset(a, an);
      const sector = sectorOf(a.ticker, a.segment, overrides);
      const diversified = isDiversified(sector);
      candidates.push({
        ticker: a.ticker, type: ci.key, sector, diversified, limit: buyLimit(diversified ? lim.etfAmplo : lim[ci.key] ?? 0.15), fullLimit: diversified ? lim.etfAmplo : lim[ci.key] ?? 0.15,
        unitBRL: price * fx, fractional: ci.key === 'internacional' && Boolean(settings.fractionalIntl),
        current: holdingValue.get(a.ticker) ?? 0, owned: (holdingValue.get(a.ticker) ?? 0) > 0, forced: include.has(a.ticker),
        q: Math.max(-1, Math.min(1, (sc.score - 55) / 40)), score: sc.score, houseW: weights.get(a.ticker) ?? 0,
        pool: poolOf({ type: ci.key }), asset: a, sc, price, an, own,
      });
    }
  }
  const maxNew = settings.maxNew === undefined ? 2 : Number(settings.maxNew);
  const maxOrders = Number(settings.maxOrders) || 0;
  const optInput = {
    candidates, classes: optClasses,
    pools: split ? { brl: brlForBR, usd: usdPool } : { brl: amount, usd: 0 },
    totalBefore: totalBefore + (intlItem ? intlShare : 0),
    opts: { maxNew, maxOrders, preferOwned: settings.preferOwned, sectorLimit: buyLimit(lim.setor) },
  };
  const opt = optimizeBuys(optInput);
  // Abrir posição nova compensa? Compara com a melhor proposta só reforçando o que você já tem.
  let onlyOwned = null;
  if (maxNew !== 0 && candidates.some((c) => opt.qty.get(c.ticker) && !c.owned)) {
    const owned = candidates.filter((c) => c.owned); // só o que você já tem (nem os incluídos novos)
    const alt = optimizeBuys({ ...optInput, candidates: owned, opts: { ...optInput.opts, maxNew: 0 } });
    const buys = owned.filter((c) => alt.qty.get(c.ticker)).map((c) => ({ ticker: c.ticker, qty: alt.qty.get(c.ticker), amount: alt.qty.get(c.ticker) * c.unitBRL }));
    const inv = buys.reduce((s2, b) => s2 + b.amount, 0);
    onlyOwned = { buys, invested: inv, leftover: Math.max(0, amount - inv), better: opt.score > alt.score + 1e-9 };
  }

  // Posição nova num setor onde você já tem ativo: por que ela e não reforçar o que já tem?
  const sameSectorNote = (c) => {
    const mates = cmp.rows.filter((r) => r.type === c.type && r.ticker !== c.ticker && r.value > 0 && sectorOfRow(r) === c.sector);
    if (!mates.length || c.diversified) return '';
    return mates.map((r) => {
      const other = candidates.find((o) => o.ticker === r.ticker);
      if (!other) return `${r.ticker} (que você já tem, mesmo setor) não está liberado para compra este mês`;
      const bought = opt.qty.get(r.ticker);
      const flag = other.sc.flags?.[0]?.label;
      return `${r.ticker} (que você já tem, mesmo setor) teve nota ${other.score} contra ${c.score}${other.an?.verdict === 'PARCIAL' ? ', com a IA concordando só em parte' : ''}${flag ? ` e alerta de ${flag}` : ''}${bought ? '; também recebe parte do aporte' : ''}`;
    }).join(' · ') + `. Juntos, o setor fica dentro do limite de ${pctBR(lim.setor, 0)} da classe.`;
  };

  // Linhas da proposta, com o porquê de cada compra.
  const lines = [];
  const pctTxt = (x, d = 0) => pctBR(x, d);
  const classAddOf = (t) => candidates.filter((c) => c.type === t).reduce((s2, c) => s2 + (opt.amounts.get(c.ticker) || 0), 0);
  for (const c of candidates) {
    const qty = opt.qty.get(c.ticker) || 0;
    if (!qty) continue;
    const amountBRL = qty * c.unitBRL;
    const cl = optClasses[c.type];
    const clAfter = cl.invested + classAddOf(c.type);
    const secAdd = candidates.filter((o) => o.type === c.type && o.sector === c.sector).reduce((s2, o) => s2 + (opt.amounts.get(o.ticker) || 0), 0);
    const wBefore = cl.invested ? c.current / cl.invested : 0;
    const wAfter = clAfter ? (c.current + amountBRL) / clAfter : 0;
    const sBefore = cl.invested ? (cl.sectors.get(c.sector) ?? 0) / cl.invested : 0;
    const sAfter = clAfter ? ((cl.sectors.get(c.sector) ?? 0) + secAdd) / clAfter : 0;
    const up = c.asset.ceiling && c.price ? c.asset.ceiling / c.price - 1 : null;
    const clsBefore = (cl.invested + cl.reserved) / (totalBefore || 1);
    const firstSentence = (t) => String(t ?? '').split(/(?<=[.!?])\s/)[0].slice(0, 200);
    const why = {
      motivo: [
        cl.fixed ? `usa o dólar/caixinha já reservado para o internacional` : `${ASSET_TYPES[c.type].short} em ${pctTxt(clsBefore)} do patrimônio, alvo ${pctTxt(targets[c.type])}`,
        `nota ${c.score}${c.an?.verdict ? ` · IA ${c.an.verdict === 'CONCORDA' ? 'concorda' : 'concorda em parte'}${c.an.aiRec ? ` (${c.an.aiRec.toLowerCase()})` : ''}` : ''}`,
        c.owned ? 'reforço de posição que você já tem' : 'posição nova',
        up !== null ? `${up >= 0 ? '+' : ''}${Math.round(up * 100)}% até o teto` : '',
      ].filter(Boolean).join(' · '),
      peso: `${pctTxt(wBefore, 1)} → ${pctTxt(wAfter, 1)} da classe (limite ${pctTxt(c.fullLimit)}${margin ? `, compra até ${pctTxt(c.limit)}` : ''})`,
      setor: c.diversified ? 'ETF amplo: já diversificado' : `${c.sector}: ${pctTxt(sBefore)} → ${pctTxt(sAfter)} da classe (limite ${pctTxt(lim.setor)}${margin ? `, compra até ${pctTxt(buyLimit(lim.setor))}` : ''})`,
      fundamento: firstSentence(c.an?.fundamentals?.[0] || c.an?.summary) || '—',
      alternativa: c.owned ? '' : sameSectorNote(c),
      risco: c.sc.flags?.[0]?.label ? `${c.sc.flags[0].label}${c.an?.risks?.[0] ? ` — ${firstSentence(c.an.risks[0])}` : ''}` : (firstSentence(c.an?.risks?.[0]) || 'nenhum risco relevante apontado'),
    };
    lines.push({
      score: c.score, segment: c.sector, sector: c.sector, forced: c.forced,
      ownedQty: c.own?.qty ?? 0, ownedValue: c.current,
      ticker: c.ticker, name: c.asset.name, type: c.type, rec: c.asset.rec, verdict: c.an?.verdict ?? null,
      price: c.price, currency: ASSET_TYPES[c.type].currency, unitBRL: c.unitBRL, fractional: c.fractional,
      priceSource: settings.prices?.[c.ticker] ? 'informado por você' : c.own?.price ? 'informado em Minha carteira' : c.an?.price ? `pesquisa${c.an.analyzedAt ? ` de ${new Date(c.an.analyzedAt).toLocaleDateString('pt-BR')}` : ''}` : 'relatório da casa',
      qty, amount: amountBRL, weightBefore: wBefore, weightAfter: wAfter, sectorBefore: sBefore, sectorAfter: sAfter,
      why, reason: why.motivo,
    });
  }
  queue.push(...opt.explain.filter((x) => x.category !== 'concentracao' && x.category !== 'setor').map((x) => x.ticker));

  const bought = lines.filter((l) => l.qty > 0).sort((a, b) => b.amount - a.amount);
  const invested = bought.reduce((s, l) => s + l.amount, 0);
  const intlBought = bought.filter((l) => l.type === 'internacional').reduce((s, l) => s + l.amount, 0);
  const remitted = remitNow ? pending : 0; // reais para mandar ao exterior agora (inclui a caixinha)
  const toReserve = intlItem && !remitNow ? intlShare : 0; // reais deste mês que vão para a caixinha
  const reserveAfter = intlItem ? (remitNow ? 0 : pending) : reserve; // caixinha depois de fazer este aporte
  const usdLeftBRL = Math.max(0, usdPool - intlBought) + (intlItem ? 0 : usdCashBRL);
  const brSpent = invested - intlBought;
  const brlLeftover = Math.max(0, brlForBR - brSpent);
  const totalFinal = totalBefore + brl - brlLeftover;
  const classes = cmp.classes.map((c) => {
    const add = bought.filter((l) => l.type === c.type).reduce((s, l) => s + l.amount, 0);
    const isIntl = c.type === 'internacional';
    const cash = isIntl ? usdCashBRL + reserve : 0; // dólar parado lá fora e caixinha contam no internacional
    const before = c.value + cash;
    const after = isIntl ? c.value + add + usdLeftBRL + reserveAfter : before + add;
    const targetValue = totalAfter * targets[c.type];
    return {
      targetValue, need: Math.max(0, targetValue - before), hasReport: c.hasReport, cash,
      type: c.type, label: c.label, before, added: add, after,
      pctBefore: totalBefore ? before / totalBefore : 0, pctAfter: totalFinal ? after / totalFinal : 0, target: targets[c.type],
    };
  });
  const fmt = (v) => v.toFixed(2).replace('.', ',');
  const usdOf = (v) => (usdBrl ? v / usdBrl : 0);
  if (remitNow) warnings.push(`Envio para o exterior neste mês: R$ ${fmt(pending)} (≈ US$ ${fmt(usdOf(pending))}${reserve > 0 ? `, dos quais R$ ${fmt(reserve)} já estavam na caixinha do dólar` : ''}). Passa do envio mínimo de US$ ${fmt(minRemit)}; a conversão paga IOF de 1,1% e o spread, então chegam um pouco menos dólares — use no campo "Dólar" a cotação da corretora.`);
  else if (toReserve > 1) warnings.push(`A parte do internacional em reais (R$ ${fmt(toReserve)}) vai para a caixinha do dólar: com ela, a caixinha fica com R$ ${fmt(pending)} (≈ US$ ${fmt(usdOf(pending))}), abaixo do envio mínimo de US$ ${fmt(minRemit)}. Faltam ≈ US$ ${fmt(Math.max(0, minRemit - usdOf(pending)))} (≈ R$ ${fmt(Math.max(0, minRemit * usdBrl - pending))}); quando passar, o app propõe o envio. Se preferir já mandar este mês, complete a caixinha com essa diferença e informe o novo valor acima.${usdCashBRL > 0 ? ' Enquanto isso, o internacional deste mês usa só o dólar que já está na corretora.' : ''}`);
  const minUnit = Math.min(...candidates.filter((c) => c.pool === 'brl').map((c) => c.unitBRL), Infinity);
  if (brlLeftover > 1 && brlLeftover >= minUnit) warnings.push(`Sobraram ${brlLeftover.toFixed(2).replace('.', ',')} reais: nenhuma outra compra melhorava a carteira sem passar dos limites de concentração ou comprar algo de nota baixa. Fica em caixa para o próximo aporte.`);
  if (frozenBack.length) warnings.push(`${frozenBack.join(', ')} voltou ao relatório deste mês: saiu do congelado e segue as regras normais de compra.`);
  // Quem ficou de fora pelos filtros vai, com o motivo, na lista agrupada (excludedItems), sem repetir aqui.
  if (excluded.aiNoWeb.length) warnings.push(`A IA discorda de ${excluded.aiNoWeb.join(', ')}, mas sem pesquisa na web; não bloqueei. Confirme com a análise por copiar e colar.`);
  if (excluded.noPrice.length) warnings.push(`Sem preço para calcular: ${excluded.noPrice.join(', ')}.`);
  return {
    amount, invested, leftover: Math.max(0, amount - invested), totalBefore, totalAfter,
    brlAmount: brl, brlForBR, brlInvested: brSpent, brlLeftover,
    usdCash, usdCashBRL, usdLeftover: usdOf(usdLeftBRL), remitted, remitNow,
    reserve, toReserve, reserveAfter, minRemit, intlShare,
    excludedItems: [
      ...opt.explain,
      ...excluded.ceiling.map((t) => ({ ticker: t, category: 'teto', detail: 'preço acima do teto da casa' })),
      ...excluded.house.map((t) => ({ ticker: t, category: 'casa', detail: 'a casa recomenda aguardar' })),
      ...excluded.ai.map((x) => ({ ticker: x.ticker, category: 'ia', detail: `a IA discorda${x.why ? `: ${short(x.why)}` : ''}` })),
      ...excluded.aiWait.map((x) => ({ ticker: x.ticker, category: 'ia', detail: `a IA pede para aguardar${x.why ? `: ${short(x.why)}` : ''}` })),
      ...excluded.noData.map((x) => ({ ticker: x.ticker, category: 'dados', detail: x.why })),
      ...excluded.noPrice.map((t) => ({ ticker: t, category: 'dados', detail: 'sem preço' })),
    ],
    combosTried: opt.tried, limits: lim, limitMargin: margin, onlyOwned,
    investedBefore: cmp.total, reservedBefore: usdCashBRL + reserve,
    attention: excluded.aiWait.map((x) => x.ticker),
    attentionItems: excluded.aiWait,
    queue, userExcluded: excluded.user, included: [...include],
    lines: bought, classes, warnings,
    sellAlerts: cmp.alerts.filter((a) => a.kind === 'vender'),
  };
}
