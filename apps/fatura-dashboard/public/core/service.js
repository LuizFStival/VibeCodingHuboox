// Casos de uso da aplicação. A UI só conversa com isto.
// Uma "fatura" é identificada por banco + mês; o dashboard de um mês soma
// as faturas de todos os bancos daquele mês.

import { getBank } from './banks/index.js';
import { buildDashboard, buildHistory } from './analytics.js';
import { resolveCategory } from './categorizer.js';

const CATEGORY_MAX = 40;
const MONTH_RE = /^\d{4}-\d{2}$/;
const byDateDesc = (a, b) => b.date.localeCompare(a.date);

export function createService(store) {
  const d = () => store.data;

  function categorize(list) {
    const rules = new Map(Object.entries(d().rules).map(([k, r]) => [k, r.category]));
    return list.map((t) => {
      const { category, source } = resolveCategory({ ...t, categoryOverride: d().overrides[t.id] ?? null }, rules);
      return { ...t, category, categorySource: source };
    });
  }

  const txOfMonth = (month) => categorize(d().transactions.filter((t) => t.month === month)).sort(byDateDesc);
  const months = () => [...new Set(d().statements.map((s) => s.month))].sort();

  function ensureCategory(data, name) {
    if (!data.categories.includes(name)) data.categories.push(name);
  }

  return {
    importCsv({ text, filename, month, bank = 'nubank' }) {
      const adapter = getBank(bank);
      if (adapter.status !== 'active') throw new Error(`${adapter.name}: importação ainda não disponível.`);
      const ref = month || adapter.monthFromFilename(filename);
      if (!ref || !MONTH_RE.test(ref)) throw new Error('Informe o mês da fatura (AAAA-MM).');
      const { transactions, errors } = adapter.parse(text, ref);

      return store.update((data) => {
        const idx = data.statements.findIndex((s) => s.bank === bank && s.month === ref);
        const replaced = idx !== -1;
        if (replaced) data.statements.splice(idx, 1);
        data.statements.push({ bank, month: ref, filename: filename ?? null, importedAt: new Date().toISOString() });
        data.transactions = data.transactions.filter((t) => !(t.bank === bank && t.month === ref)).concat(transactions);
        return { bank, month: ref, replaced, count: transactions.length, warnings: errors };
      });
    },

    /** Meses com fatura (mais recente primeiro), somando todos os bancos. */
    listMonths() {
      return months().reverse().map((month) => {
        const exp = d().transactions.filter((t) => t.month === month && t.kind === 'expense');
        return {
          month,
          totalCents: exp.reduce((a, t) => a + t.amountCents, 0),
          count: exp.length,
          banks: d().statements.filter((s) => s.month === month).map((s) => s.bank),
        };
      });
    },

    listStatements() {
      return d().statements
        .map((s) => ({
          ...s,
          totalCents: d().transactions
            .filter((t) => t.bank === s.bank && t.month === s.month && t.kind === 'expense')
            .reduce((a, t) => a + t.amountCents, 0),
        }))
        .sort((a, b) => b.month.localeCompare(a.month) || a.bank.localeCompare(b.bank));
    },

    deleteStatement(bank, month) {
      return store.update((data) => {
        const ids = new Set(data.transactions.filter((t) => t.bank === bank && t.month === month).map((t) => t.id));
        data.transactions = data.transactions.filter((t) => !ids.has(t.id));
        for (const id of ids) delete data.overrides[id];
        const before = data.statements.length;
        data.statements = data.statements.filter((s) => !(s.bank === bank && s.month === month));
        return data.statements.length < before;
      });
    },

    dashboard(month) {
      const all = months();
      if (!all.includes(month)) return null;
      const prevMonth = all.filter((m) => m < month).at(-1);
      const previousKeys = new Map();
      for (const m of all.filter((x) => x < month)) {
        const keys = new Set(d().transactions.filter((t) => t.month === m && t.kind === 'expense').map((t) => t.merchantKey));
        for (const k of keys) previousKeys.set(k, (previousKeys.get(k) ?? 0) + 1);
      }
      return buildDashboard({
        month,
        transactions: txOfMonth(month),
        previous: prevMonth ? { month: prevMonth, transactions: txOfMonth(prevMonth) } : null,
        previousKeys,
      });
    },

    history() {
      return buildHistory(months().map((month) => ({ month, transactions: txOfMonth(month) })));
    },

    transactions(month) {
      return month ? txOfMonth(month) : categorize(d().transactions).sort(byDateDesc);
    },

    /**
     * Corrige a categoria.
     *  scope 'merchant': regra do estabelecimento (todos os meses, inclusive futuros)
     *                    e remove correções pontuais conflitantes.
     *  scope 'single'  : só este lançamento.
     */
    updateCategory(id, { category, scope }) {
      const name = String(category ?? '').trim();
      if (!name || name.length > CATEGORY_MAX) throw new Error('Categoria inválida');
      if (!['merchant', 'single'].includes(scope)) throw new Error('scope deve ser "merchant" ou "single"');
      const t = d().transactions.find((x) => x.id === id);
      if (!t) return null;
      store.update((data) => {
        ensureCategory(data, name);
        if (scope === 'single') {
          data.overrides[id] = name;
        } else {
          data.rules[t.merchantKey] = { category: name, sampleTitle: t.baseTitle, updatedAt: new Date().toISOString() };
          for (const x of data.transactions) if (x.merchantKey === t.merchantKey) delete data.overrides[x.id];
        }
      });
      return categorize([t])[0];
    },

    categories: () => [...d().categories],

    addCategory(name) {
      const n = String(name ?? '').trim();
      if (!n || n.length > CATEGORY_MAX) throw new Error('Nome de categoria inválido');
      store.update((data) => ensureCategory(data, n));
      return [...d().categories];
    },

    rules() {
      return Object.entries(d().rules)
        .map(([merchantKey, r]) => ({
          merchantKey,
          ...r,
          matches: d().transactions.filter((t) => t.merchantKey === merchantKey).length,
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    deleteRule(merchantKey) {
      return store.update((data) => {
        const had = merchantKey in data.rules;
        delete data.rules[merchantKey];
        return had;
      });
    },

    exportBackup: () => JSON.parse(JSON.stringify(d())),
    importBackup: (obj) => store.replaceAll(obj),
  };
}
