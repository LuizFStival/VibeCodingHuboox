// Nubank — fatura do cartão exportada pelo app (Faturas → Exportar CSV).
// Formato atual:   date,title,amount       -> 2026-09-23,Posto X,"146,37"
// Formato antigo:  date,category,title,amount
// Pagamentos e estornos vêm negativos e não contam como gasto.

import { parseCsv, resolveColumns, buildTransactions, normalizeHeader } from '../csv.js';

const COLUMNS = {
  date: ['date', 'data'],
  title: ['title', 'descricao', 'description', 'estabelecimento', 'lancamento'],
  amount: ['amount', 'valor', 'value'],
};

export const nubank = {
  id: 'nubank',
  name: 'Nubank',
  status: 'active',
  help: 'App do Nubank → Cartão de crédito → Faturas → escolha a fatura → Exportar fatura (CSV).',

  /** Nubank_2026-10-02.csv -> "2026-10" (mês de vencimento = mês de referência). */
  monthFromFilename(filename) {
    const m = String(filename || '').match(/(\d{4})-(\d{2})(?:-\d{2})?/);
    return m ? `${m[1]}-${m[2]}` : null;
  },

  /** Heurística para sugerir o banco a partir do arquivo. */
  detect(text, filename) {
    if (/nubank/i.test(filename || '')) return true;
    const header = parseCsv(String(text).split(/\r?\n/, 1)[0])[0] ?? [];
    return ['date', 'title', 'amount'].every((c) => header.map(normalizeHeader).includes(c));
  },

  parse(text, month) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error('Arquivo vazio ou sem lançamentos');
    const cols = resolveColumns(rows[0], COLUMNS);
    const raw = rows.slice(1).map((r, i) => ({
      line: i + 2,
      date: r[cols.date],
      title: r[cols.title],
      amount: r[cols.amount],
    }));
    return buildTransactions(raw, { bank: this.id, month });
  },
};
