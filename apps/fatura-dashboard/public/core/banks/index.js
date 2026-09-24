// Registro de bancos. Para suportar um banco novo: criar o arquivo em banks/
// com { id, name, status, help, monthFromFilename, detect, parse } e listar aqui.

import { nubank } from './nubank.js';
import { bancoDoBrasil } from './bancodobrasil.js';

export const BANKS = [nubank, bancoDoBrasil];

export function getBank(id) {
  const bank = BANKS.find((b) => b.id === id);
  if (!bank) throw new Error(`Banco desconhecido: ${id}`);
  return bank;
}

export const activeBanks = () => BANKS.filter((b) => b.status === 'active');

/** Sugere o banco de um arquivo; cai no primeiro banco ativo se nada casar. */
export function detectBank(text, filename) {
  return activeBanks().find((b) => b.detect(text, filename)) ?? activeBanks()[0];
}
