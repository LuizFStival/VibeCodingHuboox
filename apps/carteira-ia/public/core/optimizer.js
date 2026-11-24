// Escolha das compras do mês olhando a CARTEIRA RESULTANTE, não só a nota de cada ativo.
//
// Como funciona:
//   1. Recebe os candidatos já liberados pelos filtros (casa, teto, IA), com nota de qualidade,
//      setor padronizado, limites de concentração e o "bolso" que paga cada um (reais ou dólar).
//   2. Simula combinações de até `maxOrders` ativos (com no máximo `maxNew` posições novas).
//   3. Em cada combinação, compra cota por cota (fração no internacional) sempre onde a carteira
//      mais melhora, respeitando orçamento e limites de concentração por ativo e por setor.
//      Para quando nenhuma compra melhora a carteira: sobrar dinheiro é aceitável.
//   4. Compara as combinações pela mesma nota de carteira e fica com a melhor. Mesmos dados e
//      parâmetros → mesmo resultado (sem aleatoriedade; empates resolvidos pela ordem dos tickers).
//
// A nota da carteira junta: proximidade das metas por classe, qualidade do que foi comprado,
// aproximação dos pesos recomendados pela casa, folga nos limites de concentração, uso do
// orçamento e uma pequena penalidade por posição nova (não inflar a carteira).

const W = {
  classFit: 150,   // metas por classe (desvio quadrático)
  quality: 1,      // nota do ativo (de -1 a 1) × fração do orçamento
  houseFit: 2,     // peso recomendado pela casa dentro da classe
  softConc: 40,    // aproximar-se do limite de concentração custa um pouco
  budget: 0.25,    // usar o orçamento é bom, mas vale menos que qualidade e metas
  newPos: 0.06,    // cada posição nova numa classe já formada (0.02 se "reforçar o que já tenho" estiver desligado)
  spread: 0.15,    // numa classe começando (menos de 3 posições), espalha a compra em vez de pôr tudo num ativo
};

const MAX_COMBOS = 8000;

/**
 * @param {object} p
 * @param {Array} p.candidates  [{ ticker, type, sector, diversified, limit, unitBRL, fractional, current, owned, forced, q, houseW, pool }]
 * @param {object} p.classes    { [type]: { invested, reserved, target, assets: Map(ticker → valor), sectors: Map(setor → valor) } }
 * @param {object} p.pools      { brl, usd } dinheiro disponível em cada bolso
 * @param {number} p.totalBefore patrimônio (investido + reservado) antes do aporte
 * @param {object} p.opts       { maxNew, maxOrders, preferOwned, sectorLimit, perClass }
 */
export function optimizeBuys({ candidates, classes, pools, totalBefore, opts }) {
  const budget = (pools.brl || 0) + (pools.usd || 0);
  const empty = { qty: new Map(), amounts: new Map(), score: 0, tried: 0 };
  if (budget <= 0.01 || !candidates.length) return { ...empty, explain: explainOut(candidates, null, opts, classes, pools) };
  const maxOrders = opts.maxOrders > 0 ? Math.min(opts.maxOrders, 8) : 6;
  const maxNew = opts.maxNew < 0 ? Infinity : opts.maxNew;
  const newPenalty = opts.preferOwned === false ? 0.02 : W.newPos;

  // Pré-seleção: os melhores de cada classe (e os incluídos por você), para a busca caber no navegador.
  const sorted = [...candidates].sort((a, b) => b.q - a.q || a.ticker.localeCompare(b.ticker));
  let perClass = opts.perClass ?? 6;
  let pool = [];
  for (;;) {
    const byType = new Map();
    pool = sorted.filter((c) => {
      if (c.forced) return true;
      const n = byType.get(c.type) ?? 0;
      if (n >= perClass) return false;
      byType.set(c.type, n + 1); return true;
    }).sort((a, b) => a.ticker.localeCompare(b.ticker));
    if (countCombos(pool, maxOrders, maxNew) <= MAX_COMBOS || perClass <= 2) break;
    perClass -= 1;
  }
  const forced = pool.filter((c) => c.forced);
  // Metas comparadas só entre as classes que podem receber dinheiro neste mês (ex.: sem dólar
  // disponível, o internacional fica de fora da conta), na proporção dos alvos.
  const active = new Set(pool.filter((c) => (pools[c.pool] || 0) > 0.01).map((c) => c.type));
  const targetSum = [...active].reduce((s2, t) => s2 + (classes[t]?.target || 0), 0);
  const totalAfter = [...active].reduce((s2, t) => s2 + classes[t].invested + classes[t].reserved, 0) + (pools.brl || 0);
  // Em quantos ativos uma classe começando deveria se espalhar: até 3, conforme os candidatos.
  const spreadK = {};
  for (const c of pool) spreadK[c.type] = Math.min(3, (spreadK[c.type] || 0) + 1);

  // Nota da carteira para um conjunto de compras (amounts: Map ticker → R$).
  // withNew=false: sem a penalidade por posição nova (usada só para comparar combinações,
  // senão a primeira fração de um ativo novo nunca "compensa" na compra cota a cota).
  // spreadK: em quantos ativos de cada classe começando a combinação pode espalhar (até 3).
  const evaluate = (amounts, withNew = true, spreadK = {}) => {
    let spent = 0; const classAdd = {}; const sectorAdd = {};
    for (const c of pool) {
      const x = amounts.get(c.ticker) || 0;
      if (!x) continue;
      spent += x;
      classAdd[c.type] = (classAdd[c.type] || 0) + x;
      const key = `${c.type}|${c.sector}`;
      sectorAdd[key] = (sectorAdd[key] || 0) + x;
    }
    // Metas medidas contra o patrimônio FINAL (antes + todo o dinheiro novo; a sobra conta como caixa),
    // para cada cota mover a carteira na direção certa sem a conta "pular" com patrimônio pequeno.
    const total = totalAfter;
    let f = 0;
    // 1) metas por classe (entre as que podem receber)
    if (targetSum > 0) for (const t of active) {
      const cl = classes[t];
      const w = (cl.invested + cl.reserved + (cl.fixed ? 0 : classAdd[t] || 0)) / (total || 1);
      f -= W.classFit * (w - cl.target / targetSum) ** 2;
    }
    // 2) qualidade, peso da casa, concentração e posições novas
    let newCount = 0; const startSq = {};
    for (const c of pool) {
      const x = amounts.get(c.ticker) || 0;
      if (!x) continue;
      const cl = classes[c.type];
      const clAfter = cl.invested + (classAdd[c.type] || 0);
      const wBefore = cl.invested ? c.current / cl.invested : 0;
      const wAfter = (c.current + x) / (clAfter || 1);
      f += W.quality * c.q * (x / budget);
      // Peso da casa e folga nos limites só fazem sentido numa classe já formada (3+ posições);
      // numa classe começando, a primeira cota é sempre "100% da classe".
      if (held(cl.assets) >= 3) {
        if (c.houseW > 0) f += W.houseFit * ((c.houseW - wBefore) ** 2 - (c.houseW - wAfter) ** 2);
        const lim = effLimit(c.limit, countAfter(cl.assets, pool, amounts, c.type), held(cl.assets));
        f -= W.softConc * Math.max(0, wAfter - 0.8 * lim) ** 2;
        if (!c.owned) newCount += 1; // posição nova só "infla" uma classe que já existe
      } else {
        startSq[c.type] = (startSq[c.type] || 0) + x * x;
      }
    }
    for (const [key, add] of Object.entries(sectorAdd)) {
      const [t, sector] = key.split('|');
      const cand = pool.find((c) => c.type === t && c.sector === sector);
      if (cand?.diversified) continue;
      const cl = classes[t];
      if (held(cl.sectors) < 3) continue;
      const share = ((cl.sectors.get(sector) || 0) + add) / ((cl.invested + (classAdd[t] || 0)) || 1);
      const lim = effLimit(opts.sectorLimit, sectorsAfter(cl.sectors, pool, amounts, t), held(cl.sectors));
      f -= W.softConc * Math.max(0, share - 0.8 * lim) ** 2;
    }
    // classe começando: concentração do que foi comprado nela (Σx²/Σx), em fração do orçamento
    // (Σx²/Σx − Σx/k: zero quando o dinheiro está igual entre k ativos; cresce se concentrar num só)
    for (const [t, sq] of Object.entries(startSq)) {
      const k = Math.max(1, spreadK[t] || 1);
      f -= W.spread * Math.max(0, sq / (classAdd[t] || 1) - (classAdd[t] || 0) / k) / budget;
    }
    f += W.budget * (spent / budget) - (withNew ? newPenalty * newCount : 0);
    return f;
  };

  // Pode comprar mais `chunk` reais de c sem estourar orçamento nem limites?
  const allowed = (c, amounts, chunk, left) => {
    if (chunk > left[c.pool] + 1e-6) return false;
    const cl = classes[c.type];
    let classAdd = 0; let sectorAdd = 0;
    for (const o of pool) {
      if (o.type !== c.type) continue;
      const x = amounts.get(o.ticker) || 0;
      classAdd += x;
      if (o.sector === c.sector) sectorAdd += x;
    }
    // Classe começando (menos de 3 posições): sem limite rígido; o termo de espalhar cuida disso.
    if (held(cl.assets) < 3) return true;
    const den = cl.invested + classAdd + chunk;
    const next = new Map(amounts); next.set(c.ticker, (amounts.get(c.ticker) || 0) + chunk);
    const wBefore = cl.invested ? c.current / cl.invested : 0;
    const wAfter = (c.current + (amounts.get(c.ticker) || 0) + chunk) / den;
    if (wAfter > Math.max(effLimit(c.limit, countAfter(cl.assets, pool, next, c.type), held(cl.assets)), wBefore) + 1e-9) return false;
    if (!c.diversified) {
      const sBefore = cl.invested ? (cl.sectors.get(c.sector) || 0) / cl.invested : 0;
      const sAfter = ((cl.sectors.get(c.sector) || 0) + sectorAdd + chunk) / den;
      if (sAfter > Math.max(effLimit(opts.sectorLimit, sectorsAfter(cl.sectors, pool, next, c.type), held(cl.sectors)), sBefore) + 1e-9) return false;
    }
    return true;
  };

  const step = (c, left) => {
    if (!c.fractional) return { chunk: c.unitBRL, qty: 1 };
    const chunk = Math.min(left[c.pool], Math.max(20, budget / 15));
    const qty = Math.floor((chunk / c.unitBRL) * 10000) / 10000;
    return { chunk: qty * c.unitBRL, qty };
  };

  // Enche uma combinação: compra onde a carteira mais melhora, até nada mais melhorar.
  const fill = (subset) => {
    const amounts = new Map(); const qty = new Map();
    const left = { brl: pools.brl || 0, usd: pools.usd || 0 };
    const forcedIn = subset.filter((c) => c.forced);
    let cur = evaluate(amounts, false, spreadK);
    // Fase 1: o dinheiro da 1ª cota dos ativos incluídos (por você ou pela revisão da IA) fica
    // reservado enquanto eles ainda não cabem nos limites (outras compras da classe podem abrir
    // espaço). Fase 2, só se algum incluído não coube: libera a reserva para o resto.
    for (const phase of [1, 2]) {
      if (phase === 2 && forcedIn.every((f) => amounts.get(f.ticker))) break;
      for (let guard = 0; guard < 4000; guard++) {
        const reserve = { brl: 0, usd: 0 };
        if (phase === 1) for (const f of forcedIn) if (!amounts.get(f.ticker)) reserve[f.pool] += step(f, left).chunk;
        let best = null;
        for (const c of subset) {
          const { chunk, qty: dq } = step(c, left);
          const pendingForced = c.forced && !amounts.get(c.ticker);
          const avail = pendingForced ? left : { brl: left.brl - reserve.brl, usd: left.usd - reserve.usd };
          if (dq <= 0 || chunk <= 0 || !allowed(c, amounts, chunk, avail)) continue;
          const next = new Map(amounts); next.set(c.ticker, (amounts.get(c.ticker) || 0) + chunk);
          const gain = evaluate(next, false, spreadK) - cur;
          // incluído: a 1ª cota entra mesmo sem ganho (se couber nos limites)
          if ((gain > 1e-9 || pendingForced) && (!best || (pendingForced && !best.must) || (pendingForced === best.must && gain > best.gain + 1e-12))) best = { c, chunk, dq, gain, next, must: pendingForced };
        }
        if (!best) break;
        amounts.set(best.c.ticker, best.next.get(best.c.ticker));
        qty.set(best.c.ticker, Math.round(((qty.get(best.c.ticker) || 0) + best.dq) * 10000) / 10000);
        left[best.c.pool] -= best.chunk;
        cur = evaluate(amounts, false, spreadK);
      }
    }
    return { amounts, qty, score: evaluate(amounts, true, spreadK) };
  };

  // Todas as combinações de até maxOrders ativos, com no máximo maxNew novos, contendo os incluídos.
  let best = { ...empty, score: evaluate(new Map()) };
  let tried = 0;
  const seen = new Set();
  const rest = pool.filter((c) => !c.forced);
  const visit = (start, chosen, nNew) => {
    if (chosen.length) {
      tried += 1;
      const r = fill(chosen);
      const bought = chosen.filter((c) => r.amounts.get(c.ticker) > 0).map((c) => c.ticker).join(',');
      if (bought && !seen.has(bought)) {
        seen.add(bought);
        const orders = bought.split(',').length;
        const better = r.score > best.score + 1e-9
          || (Math.abs(r.score - best.score) <= 1e-9 && (orders < (best.orders ?? Infinity) || (orders === best.orders && bought < best.key)));
        if (better) best = { ...r, orders, key: bought };
      }
    }
    if (chosen.length >= maxOrders) return;
    for (let i = start; i < rest.length; i++) {
      const c = rest[i];
      const isNew = !c.owned;
      if (isNew && nNew >= maxNew) continue;
      visit(i + 1, [...chosen, c], nNew + (isNew ? 1 : 0));
    }
  };
  const forcedNew = forced.filter((c) => !c.owned).length;
  visit(0, forced, forcedNew);
  return { qty: best.qty, amounts: best.amounts, score: best.score, tried, explain: explainOut(candidates, best, { ...opts, maxOrders, maxNew }, classes, pools) };
}

/**
 * Limite efetivo. Só uma classe que está começando (menos de 3 posições) ganha folga:
 * com 1 ou 2 ativos ninguém consegue ficar abaixo de 15%, então o teto vira 1/nº de ativos.
 */
export function effLimit(limit, nAfter, nBefore = 3) { return nBefore >= 3 ? limit : Math.max(limit, nAfter > 0 ? 1 / nAfter : 1); }
const held = (m) => [...m.values()].filter((v) => v > 0).length;

function countAfter(assets, pool, amounts, type) {
  let n = 0; for (const v of assets.values()) if (v > 0) n += 1;
  for (const c of pool) if (c.type === type && !c.owned && (amounts.get(c.ticker) || 0) > 0) n += 1;
  return n;
}
function sectorsAfter(sectors, pool, amounts, type) {
  const s = new Set([...sectors.entries()].filter(([, v]) => v > 0).map(([k]) => k));
  for (const c of pool) if (c.type === type && (amounts.get(c.ticker) || 0) > 0) s.add(c.sector);
  return s.size;
}
function countCombos(pool, maxOrders, maxNew) {
  const owned = pool.filter((c) => c.owned).length; const fresh = pool.length - owned;
  const C = (n, k) => { if (k < 0 || k > n) return 0; let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
  let total = 0;
  for (let k = 1; k <= maxOrders; k++) for (let j = 0; j <= Math.min(k, maxNew === Infinity ? k : maxNew); j++) total += C(owned, k - j) * C(fresh, j);
  return total;
}

/** Por que cada candidato elegível ficou de fora da combinação escolhida. */
function explainOut(candidates, best, opts, classes, pools) {
  const out = [];
  const amounts = best?.amounts ?? new Map();
  const spent = { brl: 0, usd: 0 };
  for (const c of candidates) spent[c.pool] += amounts.get(c.ticker) || 0;
  const chosen = candidates.filter((c) => (amounts.get(c.ticker) || 0) > 0);
  const nNew = chosen.filter((c) => !c.owned).length;
  for (const c of candidates) {
    if ((amounts.get(c.ticker) || 0) > 0) continue;
    const cl = classes[c.type];
    let classAdd = 0; let sectorAdd = 0;
    for (const o of chosen) if (o.type === c.type) { classAdd += amounts.get(o.ticker); if (o.sector === c.sector) sectorAdd += amounts.get(o.ticker); }
    const unit = c.fractional ? Math.min(c.unitBRL, 20) : c.unitBRL;
    const den = cl.invested + classAdd + unit;
    const nAssets = [...cl.assets.values()].filter((v) => v > 0).length + chosen.filter((o) => o.type === c.type && !o.owned).length + (c.owned ? 0 : 1);
    const wBefore = cl.invested ? c.current / cl.invested : 0;
    const wAfter = (c.current + unit) / den;
    const lim = effLimit(c.limit, nAssets, held(cl.assets));
    const sBefore = cl.invested ? (cl.sectors.get(c.sector) || 0) / cl.invested : 0;
    const sAfter = ((cl.sectors.get(c.sector) || 0) + sectorAdd + unit) / den;
    const sLim = effLimit(opts.sectorLimit, new Set([...cl.sectors.keys(), ...chosen.filter((o) => o.type === c.type).map((o) => o.sector), c.sector]).size, held(cl.sectors));
    const pct = (x) => `${Math.round(x * 100)}%`;
    let category; let detail;
    if ((pools[c.pool] || 0) <= 0.01) { category = 'orcamento'; detail = c.pool === 'usd' ? 'sem dólar disponível para o internacional neste mês (a parte em reais foi para a caixinha)' : 'sem reais para esta classe neste mês'; }
    else if (wAfter > Math.max(lim, wBefore) + 1e-9) { category = 'concentracao'; detail = `${c.ticker} já é ${pct(wBefore)} da classe; mais uma compra passaria do limite de ${pct(lim)}`; }
    else if (!c.diversified && sAfter > Math.max(sLim, sBefore) + 1e-9) { category = 'setor'; detail = `setor ${c.sector} já é ${pct(sBefore)} da classe${sectorAdd ? ' (com as compras escolhidas)' : ''}; limite de ${pct(sLim)}`; }
    else if (unit > (pools[c.pool] || 0) - spent[c.pool] + 1e-6 && !(c.fractional && (pools[c.pool] || 0) - spent[c.pool] > 1)) { category = 'orcamento'; detail = (pools[c.pool] || 0) <= 0.01 ? (c.pool === 'usd' ? 'sem dólar disponível para o internacional neste mês' : 'sem reais para esta classe neste mês') : `uma cota custa R$ ${unit.toFixed(2).replace('.', ',')} e não sobrou orçamento`; }
    else if (!c.owned && nNew >= opts.maxNew) { category = 'novas'; detail = `limite de ${opts.maxNew} posição(ões) nova(s) por aporte`; }
    else if (chosen.length >= opts.maxOrders) { category = 'ordens'; detail = `limite de ${opts.maxOrders} compras por aporte`; }
    else if (c.q <= 0) { category = 'atratividade'; detail = `nota ${c.score}: qualidade/risco não compensam a compra agora`; }
    else { category = 'menor-ganho'; detail = 'outras compras melhoraram mais a carteira (metas, qualidade e diversificação)'; }
    out.push({ ticker: c.ticker, type: c.type, category, detail, score: c.score });
  }
  return out;
}
