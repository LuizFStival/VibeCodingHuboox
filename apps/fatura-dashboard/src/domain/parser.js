// Parser da fatura CSV do Nubank (e formatos compatíveis).
// Formato atual:   date,title,amount       -> 2026-09-23,Posto X,"146,37"
// Formato antigo:  date,category,title,amount
// Pagamentos e estornos vêm com valor negativo e NÃO contam como gasto.

import { createHash } from 'node:crypto';
import { parseAmountToCents } from './money.js';
import { parseInstallment, merchantKey, stripAccents } from './merchant.js';

/** Parser CSV mínimo com suporte a aspas, aspas escapadas e CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text).replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const HEADER_ALIASES = {
  date: ['date', 'data'],
  title: ['title', 'descricao', 'description', 'estabelecimento', 'lancamento'],
  amount: ['amount', 'valor', 'value'],
};

function resolveColumns(header) {
  const norm = header.map((h) => stripAccents(h).trim().toLowerCase());
  const cols = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    cols[key] = norm.findIndex((h) => aliases.includes(h));
    if (cols[key] === -1) {
      throw new Error(`Coluna "${key}" não encontrada no cabeçalho (${header.join(', ')})`);
    }
  }
  return cols;
}

function normalizeDate(raw) {
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  throw new Error(`Data inválida: "${raw}"`);
}

/** Nubank_2026-10-02.csv -> "2026-10" (mês de vencimento = mês de referência da fatura). */
export function monthFromFilename(filename) {
  const m = String(filename || '').match(/(\d{4})-(\d{2})(?:-\d{2})?/);
  return m ? `${m[1]}-${m[2]}` : null;
}

/**
 * Converte o CSV em lançamentos normalizados.
 * O id é determinístico (mês + conteúdo + ocorrência) para que reimportar a
 * mesma fatura preserve correções manuais feitas em lançamentos específicos.
 */
export function parseStatement(text, month) {
  if (!/^\d{4}-\d{2}$/.test(String(month))) throw new Error('Mês de referência inválido (use AAAA-MM)');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('Arquivo vazio ou sem lançamentos');

  const cols = resolveColumns(rows[0]);
  const seen = new Map();
  const errors = [];
  const transactions = [];

  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    try {
      const date = normalizeDate(r[cols.date]);
      const title = String(r[cols.title] ?? '').trim();
      if (!title) throw new Error('Descrição vazia');
      const amountCents = parseAmountToCents(r[cols.amount]);
      const { baseTitle, installment } = parseInstallment(title);

      const fingerprint = `${month}|${date}|${title}|${amountCents}`;
      const occurrence = (seen.get(fingerprint) ?? 0) + 1;
      seen.set(fingerprint, occurrence);

      transactions.push({
        id: createHash('sha1').update(`${fingerprint}|${occurrence}`).digest('hex').slice(0, 16),
        month,
        date,
        title,
        baseTitle,
        merchantKey: merchantKey(title),
        amountCents,
        kind: amountCents < 0 ? 'credit' : 'expense',
        installmentCurrent: installment?.current ?? null,
        installmentTotal: installment?.total ?? null,
      });
    } catch (e) {
      errors.push(`Linha ${line}: ${e.message}`);
    }
  });

  if (transactions.length === 0) {
    throw new Error(`Nenhum lançamento válido. ${errors.slice(0, 3).join('; ')}`);
  }
  return { transactions, errors };
}
