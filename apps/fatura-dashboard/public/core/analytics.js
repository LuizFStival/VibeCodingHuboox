// Agregações do dashboard. Funções puras: recebem lançamentos já categorizados
// (com .category) e devolvem números em centavos.

export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const sum = (list) => list.reduce((acc, t) => acc + t.amountCents, 0);
const pct = (part, whole) => (whole > 0 ? part / whole : 0);

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

export function byCategory(expenses) {
  const total = sum(expenses);
  return [...groupBy(expenses, (t) => t.category)]
    .map(([category, items]) => ({
      category,
      totalCents: sum(items),
      count: items.length,
      share: pct(sum(items), total),
    }))
    .sort((a, b) => b.totalCents - a.totalCents);
}

export function topMerchants(expenses, limit = 10) {
  return [...groupBy(expenses, (t) => t.merchantKey)]
    .map(([merchantKey, items]) => ({
      merchantKey,
      title: items[0].baseTitle,
      category: items[0].category,
      totalCents: sum(items),
      count: items.length,
    }))
    .sort((a, b) => b.totalCents - a.totalCents)
    .slice(0, limit);
}

export function byDay(expenses) {
  return [...groupBy(expenses, (t) => t.date)]
    .map(([date, items]) => ({ date, totalCents: sum(items), count: items.length }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Parcelas da fatura + projeção do que já está comprometido nas próximas faturas.
 * Ex.: "Parcela 3/10" de R$ 100 -> faltam 7 parcelas -> R$ 700 comprometidos.
 */
export function installments(expenses, month) {
  const items = expenses
    .filter((t) => t.installmentTotal)
    .map((t) => {
      const remaining = t.installmentTotal - t.installmentCurrent;
      return {
        id: t.id,
        title: t.baseTitle,
        category: t.category,
        current: t.installmentCurrent,
        total: t.installmentTotal,
        amountCents: t.amountCents,
        remaining,
        remainingCents: remaining * t.amountCents,
        purchaseTotalCents: t.installmentTotal * t.amountCents,
        lastMonth: addMonths(month, remaining),
      };
    })
    .sort((a, b) => b.remainingCents - a.remainingCents);

  const horizon = Math.max(0, ...items.map((i) => i.remaining));
  const projection = [];
  for (let k = 1; k <= horizon; k++) {
    const due = items.filter((i) => i.remaining >= k);
    projection.push({ month: addMonths(month, k), totalCents: sum(due), count: due.length });
  }

  return {
    thisMonthCents: sum(items),
    count: items.length,
    newPurchases: items.filter((i) => i.current === 1).length,
    finishingNow: items.filter((i) => i.remaining === 0).length,
    futureCommittedCents: items.reduce((acc, i) => acc + i.remainingCents, 0),
    items,
    projection,
  };
}

/**
 * Gastos que se repetem em faturas anteriores (assinaturas, academia, etc.).
 * Parcelas ficam de fora: elas já têm seção própria.
 */
export function recurring(expenses, previousKeys) {
  const nonInstallment = expenses.filter((t) => !t.installmentTotal);
  return [...groupBy(nonInstallment, (t) => t.merchantKey)]
    .filter(([key]) => (previousKeys.get(key) ?? 0) > 0)
    .map(([merchantKey, items]) => ({
      merchantKey,
      title: items[0].baseTitle,
      category: items[0].category,
      totalCents: sum(items),
      monthsSeen: previousKeys.get(merchantKey) + 1,
    }))
    .sort((a, b) => b.totalCents - a.totalCents);
}

export function buildDashboard({ month, transactions, previous, previousKeys }) {
  const expenses = transactions.filter((t) => t.kind === 'expense');
  const credits = transactions.filter((t) => t.kind === 'credit');
  const totalCents = sum(expenses);
  const categories = byCategory(expenses);
  const inst = installments(expenses, month);

  let comparison = null;
  if (previous) {
    const prevExpenses = previous.transactions.filter((t) => t.kind === 'expense');
    const prevTotal = sum(prevExpenses);
    const prevByCat = new Map(byCategory(prevExpenses).map((c) => [c.category, c.totalCents]));
    comparison = {
      month: previous.month,
      totalCents: prevTotal,
      deltaCents: totalCents - prevTotal,
      deltaPct: prevTotal > 0 ? (totalCents - prevTotal) / prevTotal : null,
    };
    for (const c of categories) {
      const before = prevByCat.get(c.category) ?? 0;
      c.previousCents = before;
      c.deltaCents = c.totalCents - before;
    }
  }

  return {
    month,
    summary: {
      totalCents,
      count: expenses.length,
      avgTicketCents: expenses.length ? Math.round(totalCents / expenses.length) : 0,
      creditsCents: -sum(credits),
      largest: expenses.reduce((max, t) => (!max || t.amountCents > max.amountCents ? t : max), null),
      installmentsShare: pct(inst.thisMonthCents, totalCents),
    },
    comparison,
    categories,
    topMerchants: topMerchants(expenses),
    byDay: byDay(expenses),
    installments: inst,
    recurring: recurring(expenses, previousKeys ?? new Map()),
    transactions,
  };
}

/** Matriz mês x categoria para a aba de histórico. */
export function buildHistory(months) {
  const categoryTotals = new Map();
  const rows = months.map(({ month, transactions }) => {
    const expenses = transactions.filter((t) => t.kind === 'expense');
    const cats = {};
    for (const c of byCategory(expenses)) {
      cats[c.category] = c.totalCents;
      categoryTotals.set(c.category, (categoryTotals.get(c.category) ?? 0) + c.totalCents);
    }
    const inst = expenses.filter((t) => t.installmentTotal);
    return {
      month,
      totalCents: sum(expenses),
      installmentsCents: sum(inst),
      count: expenses.length,
      categories: cats,
    };
  });
  const categories = [...categoryTotals].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const n = rows.length || 1;
  return {
    months: rows,
    categories,
    averageCents: Math.round(rows.reduce((a, r) => a + r.totalCents, 0) / n),
  };
}
