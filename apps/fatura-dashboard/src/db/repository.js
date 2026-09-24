// Persistência em SQLite (módulo nativo node:sqlite — zero dependências).
// Toda regra de negócio fica em src/domain; aqui só há leitura/escrita.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_CATEGORIES, resolveCategory } from '../domain/categorizer.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS statements (
    month        TEXT PRIMARY KEY,           -- AAAA-MM (mês de vencimento)
    filename     TEXT,
    imported_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id                  TEXT PRIMARY KEY,
    month               TEXT NOT NULL REFERENCES statements(month) ON DELETE CASCADE,
    date                TEXT NOT NULL,
    title               TEXT NOT NULL,
    base_title          TEXT NOT NULL,
    merchant_key        TEXT NOT NULL,
    amount_cents        INTEGER NOT NULL,
    kind                TEXT NOT NULL CHECK (kind IN ('expense','credit')),
    installment_current INTEGER,
    installment_total   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_tx_month ON transactions(month);
  CREATE INDEX IF NOT EXISTS idx_tx_merchant ON transactions(merchant_key);

  -- Correções num lançamento específico. Tabela separada para sobreviver à reimportação.
  CREATE TABLE IF NOT EXISTS transaction_overrides (
    transaction_id TEXT PRIMARY KEY,
    category       TEXT NOT NULL
  );
  -- Regras aprendidas: estabelecimento -> categoria (valem para todos os meses).
  CREATE TABLE IF NOT EXISTS merchant_rules (
    merchant_key TEXT PRIMARY KEY,
    category     TEXT NOT NULL,
    sample_title TEXT,
    updated_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS categories (
    name       TEXT PRIMARY KEY,
    position   INTEGER NOT NULL
  );
`;

export function openRepository(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const seed = db.prepare('INSERT OR IGNORE INTO categories (name, position) VALUES (?, ?)');
  DEFAULT_CATEGORIES.forEach((c, i) => seed.run(c, i));

  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  const rowToTx = (r) => ({
    id: r.id,
    month: r.month,
    date: r.date,
    title: r.title,
    baseTitle: r.base_title,
    merchantKey: r.merchant_key,
    amountCents: r.amount_cents,
    kind: r.kind,
    installmentCurrent: r.installment_current,
    installmentTotal: r.installment_total,
    categoryOverride: r.override_category ?? null,
  });

  function merchantRules() {
    const rows = db.prepare('SELECT merchant_key, category FROM merchant_rules').all();
    return new Map(rows.map((r) => [r.merchant_key, r.category]));
  }

  function categorize(list) {
    const rules = merchantRules();
    return list.map((t) => {
      const { category, source } = resolveCategory(t, rules);
      return { ...t, category, categorySource: source };
    });
  }

  function loadTransactions(where, params) {
    const rows = db
      .prepare(
        `SELECT t.*, o.category AS override_category
           FROM transactions t
           LEFT JOIN transaction_overrides o ON o.transaction_id = t.id
          WHERE ${where}
          ORDER BY t.date DESC, t.rowid ASC`,
      )
      .all(...params);
    return categorize(rows.map(rowToTx));
  }

  return {
    close: () => db.close(),

    /** Importa (ou substitui) a fatura de um mês. */
    importStatement(month, filename, transactions) {
      return tx(() => {
        const existed = !!db.prepare('SELECT 1 FROM statements WHERE month = ?').get(month);
        db.prepare('DELETE FROM transactions WHERE month = ?').run(month);
        db.prepare(
          `INSERT INTO statements (month, filename, imported_at) VALUES (?, ?, ?)
           ON CONFLICT(month) DO UPDATE SET filename = excluded.filename, imported_at = excluded.imported_at`,
        ).run(month, filename ?? null, new Date().toISOString());
        const ins = db.prepare(
          `INSERT INTO transactions (id, month, date, title, base_title, merchant_key, amount_cents,
                                     kind, installment_current, installment_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const t of transactions) {
          ins.run(t.id, month, t.date, t.title, t.baseTitle, t.merchantKey, t.amountCents,
            t.kind, t.installmentCurrent, t.installmentTotal);
        }
        return { month, replaced: existed, count: transactions.length };
      });
    },

    deleteStatement(month) {
      return tx(() => {
        db.prepare(
          'DELETE FROM transaction_overrides WHERE transaction_id IN (SELECT id FROM transactions WHERE month = ?)',
        ).run(month);
        return db.prepare('DELETE FROM statements WHERE month = ?').run(month).changes > 0;
      });
    },

    listStatements() {
      return db
        .prepare(
          `SELECT s.month, s.filename, s.imported_at AS importedAt,
                  COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount_cents END), 0) AS totalCents,
                  COUNT(CASE WHEN t.kind = 'expense' THEN 1 END) AS count
             FROM statements s LEFT JOIN transactions t ON t.month = s.month
            GROUP BY s.month ORDER BY s.month DESC`,
        )
        .all()
        .map((r) => ({ ...r }));
    },

    monthTransactions: (month) => loadTransactions('t.month = ?', [month]),
    allTransactions: () => loadTransactions('1 = 1', []),

    /** Quantas faturas anteriores a `month` contêm cada estabelecimento. */
    merchantMonthCounts(month) {
      const rows = db
        .prepare(
          `SELECT merchant_key, COUNT(DISTINCT month) AS n FROM transactions
            WHERE month < ? AND kind = 'expense' GROUP BY merchant_key`,
        )
        .all(month);
      return new Map(rows.map((r) => [r.merchant_key, r.n]));
    },

    getTransaction(id) {
      return loadTransactions('t.id = ?', [id])[0] ?? null;
    },

    /**
     * Corrige a categoria.
     *  scope 'merchant': cria/atualiza a regra do estabelecimento (todos os meses,
     *                    inclusive futuros) e limpa correções pontuais conflitantes.
     *  scope 'single'  : só este lançamento.
     */
    setCategory(id, category, scope) {
      const t = this.getTransaction(id);
      if (!t) return null;
      this.ensureCategory(category);
      tx(() => {
        if (scope === 'single') {
          db.prepare(
            `INSERT INTO transaction_overrides (transaction_id, category) VALUES (?, ?)
             ON CONFLICT(transaction_id) DO UPDATE SET category = excluded.category`,
          ).run(id, category);
        } else {
          db.prepare(
            `INSERT INTO merchant_rules (merchant_key, category, sample_title, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(merchant_key) DO UPDATE SET category = excluded.category,
               sample_title = excluded.sample_title, updated_at = excluded.updated_at`,
          ).run(t.merchantKey, category, t.baseTitle, new Date().toISOString());
          db.prepare(
            `DELETE FROM transaction_overrides
              WHERE transaction_id IN (SELECT id FROM transactions WHERE merchant_key = ?)`,
          ).run(t.merchantKey);
        }
      });
      return this.getTransaction(id);
    },

    listRules() {
      return db
        .prepare(
          `SELECT r.merchant_key AS merchantKey, r.category, r.sample_title AS sampleTitle,
                  r.updated_at AS updatedAt, COUNT(t.id) AS matches
             FROM merchant_rules r LEFT JOIN transactions t ON t.merchant_key = r.merchant_key
            GROUP BY r.merchant_key ORDER BY r.updated_at DESC`,
        )
        .all()
        .map((r) => ({ ...r }));
    },

    deleteRule(merchantKey) {
      return db.prepare('DELETE FROM merchant_rules WHERE merchant_key = ?').run(merchantKey).changes > 0;
    },

    listCategories() {
      return db.prepare('SELECT name FROM categories ORDER BY position, name').all().map((r) => r.name);
    },

    ensureCategory(name) {
      const max = db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM categories').get().m;
      db.prepare('INSERT OR IGNORE INTO categories (name, position) VALUES (?, ?)').run(name, max + 1);
    },
  };
}
