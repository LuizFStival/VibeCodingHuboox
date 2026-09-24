// Peças comuns a todos os bancos: leitura de CSV, datas, id estável e a
// montagem do lançamento normalizado. Cada banco (core/banks/*) só precisa
// dizer onde estão data, descrição e valor no arquivo dele.

import { parseAmountToCents } from './money.js';
import { parseInstallment, merchantKey, stripAccents } from './merchant.js';
import { hashId } from './hash.js';

/** Parser CSV mínimo com suporte a aspas, aspas escapadas, CRLF e separador configurável. */
export function parseCsv(text, delimiter = ',') {
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
    else if (c === delimiter) { row.push(field); field = ''; }
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

export const normalizeHeader = (h) => stripAccents(h).trim().toLowerCase();

/** Acha o índice de cada coluna pelo nome (aceita apelidos). */
export function resolveColumns(header, aliases) {
  const norm = header.map(normalizeHeader);
  const cols = {};
  for (const [key, names] of Object.entries(aliases)) {
    cols[key] = norm.findIndex((h) => names.includes(h));
    if (cols[key] === -1) {
      throw new Error(`Coluna "${key}" não encontrada no cabeçalho (${header.join(', ')})`);
    }
  }
  return cols;
}

export function normalizeDate(raw) {
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  throw new Error(`Data inválida: "${raw}"`);
}

/**
 * Converte linhas {date, title, amount} (texto cru) em lançamentos normalizados.
 * O id é determinístico (banco + mês + conteúdo + ocorrência) para que reimportar
 * a mesma fatura preserve correções manuais feitas em lançamentos específicos.
 */
export function buildTransactions(rawRows, { bank, month }) {
  if (!/^\d{4}-\d{2}$/.test(String(month))) throw new Error('Mês de referência inválido (use AAAA-MM)');
  const seen = new Map();
  const errors = [];
  const transactions = [];

  for (const { line, date: rawDate, title: rawTitle, amount } of rawRows) {
    try {
      const date = normalizeDate(rawDate);
      const title = String(rawTitle ?? '').trim();
      if (!title) throw new Error('Descrição vazia');
      const amountCents = parseAmountToCents(amount);
      const { baseTitle, installment } = parseInstallment(title);

      const fingerprint = `${bank}|${month}|${date}|${title}|${amountCents}`;
      const occurrence = (seen.get(fingerprint) ?? 0) + 1;
      seen.set(fingerprint, occurrence);

      transactions.push({
        id: hashId(`${fingerprint}|${occurrence}`),
        bank,
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
  }

  if (transactions.length === 0) {
    throw new Error(`Nenhum lançamento válido. ${errors.slice(0, 3).join('; ')}`);
  }
  return { transactions, errors };
}
