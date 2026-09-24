// Camada de aplicação: orquestra domínio + repositório. A API HTTP só chama isto.

import { parseStatement, monthFromFilename } from './domain/parser.js';
import { buildDashboard, buildHistory } from './domain/analytics.js';

export class ValidationError extends Error {}

const CATEGORY_MAX = 40;

export function createService(repo) {
  const groupByMonth = (transactions) => {
    const map = new Map();
    for (const t of transactions) {
      if (!map.has(t.month)) map.set(t.month, []);
      map.get(t.month).push(t);
    }
    return map;
  };

  return {
    importCsv({ text, filename, month }) {
      const ref = month || monthFromFilename(filename);
      if (!ref) throw new ValidationError('Informe o mês da fatura (AAAA-MM): não deu para deduzir pelo nome do arquivo.');
      let parsed;
      try {
        parsed = parseStatement(text, ref);
      } catch (e) {
        throw new ValidationError(e.message);
      }
      const result = repo.importStatement(ref, filename, parsed.transactions);
      return { ...result, warnings: parsed.errors };
    },

    listMonths: () => repo.listStatements(),

    deleteMonth(month) {
      return repo.deleteStatement(month);
    },

    dashboard(month) {
      const months = repo.listStatements().map((s) => s.month);
      if (!months.includes(month)) return null;
      const prevMonth = months.filter((m) => m < month).sort().at(-1);
      return buildDashboard({
        month,
        transactions: repo.monthTransactions(month),
        previous: prevMonth ? { month: prevMonth, transactions: repo.monthTransactions(prevMonth) } : null,
        previousKeys: repo.merchantMonthCounts(month),
      });
    },

    history() {
      const byMonth = groupByMonth(repo.allTransactions());
      const months = repo
        .listStatements()
        .map((s) => s.month)
        .sort()
        .map((month) => ({ month, transactions: byMonth.get(month) ?? [] }));
      return buildHistory(months);
    },

    updateCategory(id, { category, scope }) {
      const name = String(category ?? '').trim();
      if (!name || name.length > CATEGORY_MAX) throw new ValidationError('Categoria inválida');
      if (!['merchant', 'single'].includes(scope)) throw new ValidationError('scope deve ser "merchant" ou "single"');
      return repo.setCategory(id, name, scope);
    },

    transactions(month) {
      return month ? repo.monthTransactions(month) : repo.allTransactions();
    },

    categories: () => repo.listCategories(),

    addCategory(name) {
      const n = String(name ?? '').trim();
      if (!n || n.length > CATEGORY_MAX) throw new ValidationError('Nome de categoria inválido');
      repo.ensureCategory(n);
      return repo.listCategories();
    },

    rules: () => repo.listRules(),
    deleteRule: (key) => repo.deleteRule(key),
  };
}
