// Todo valor monetário do sistema trafega em centavos (inteiros) para evitar
// erro de ponto flutuante em somas. A conversão para reais só acontece na UI.

/**
 * Converte um valor textual de fatura em centavos.
 * Aceita formato pt-BR ("1.234,56", "- 3.680,70") e formato ponto ("1234.56").
 */
export function parseAmountToCents(raw) {
  if (raw === null || raw === undefined) throw new Error('Valor ausente');
  let s = String(raw).trim().replace(/\s+/g, '').replace(/^R\$/i, '');
  if (s === '') throw new Error('Valor vazio');

  let negative = false;
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }

  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  }

  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Valor inválido: "${raw}"`);

  const [intPart, decPart = ''] = s.split('.');
  const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0'));
  return negative ? -cents : cents;
}

export function formatBRL(cents) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
