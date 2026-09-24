// Extração de parcelamento e normalização do nome do estabelecimento.
// A "chave do estabelecimento" é o que liga a mesma despesa entre meses:
// é por ela que uma correção manual de categoria vira regra permanente.

const INSTALLMENT_RE = /\s*-\s*parcela\s+(\d+)\s*\/\s*(\d+)\s*$/i;

export function parseInstallment(title) {
  const m = String(title).match(INSTALLMENT_RE);
  if (!m) return { baseTitle: String(title).trim(), installment: null };
  const current = Number(m[1]);
  const total = Number(m[2]);
  return {
    baseTitle: String(title).replace(INSTALLMENT_RE, '').trim(),
    installment: current > 0 && total >= current ? { current, total } : null,
  };
}

export function stripAccents(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** "Farmácia Nissei - Parcela 2/3" -> "farmacia nissei" */
export function merchantKey(title) {
  const { baseTitle } = parseInstallment(title);
  return stripAccents(baseTitle)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
