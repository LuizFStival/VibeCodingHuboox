// Persistência no próprio navegador (localStorage). Os dados nunca saem do
// dispositivo — por isso o app pode ser hospedado como site estático (Vercel)
// sem banco de dados nem login. Backup/restauração via JSON (ver service.js).

import { DEFAULT_CATEGORIES } from './categorizer.js';

export const STORAGE_KEY = 'fatura-dashboard:v1';
const SCHEMA_VERSION = 1;

const emptyData = () => ({
  version: SCHEMA_VERSION,
  statements: [],      // { bank, month, filename, importedAt }
  transactions: [],    // lançamentos normalizados (ver core/csv.js)
  overrides: {},       // transactionId -> categoria (correção pontual)
  rules: {},           // merchantKey -> { category, sampleTitle, updatedAt }
  categories: [...DEFAULT_CATEGORIES],
});

/** Armazenamento em memória: usado nos testes e se o navegador bloquear o localStorage. */
export function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)) };
}

export function validateData(data) {
  if (!data || typeof data !== 'object') throw new Error('Backup inválido');
  if (data.version !== SCHEMA_VERSION) throw new Error(`Versão de backup não suportada: ${data.version}`);
  for (const k of ['statements', 'transactions', 'categories']) {
    if (!Array.isArray(data[k])) throw new Error(`Backup inválido: "${k}" ausente`);
  }
  for (const k of ['overrides', 'rules']) {
    if (!data[k] || typeof data[k] !== 'object') throw new Error(`Backup inválido: "${k}" ausente`);
  }
  return data;
}

export function createStore(storage) {
  let data;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    data = raw ? validateData(JSON.parse(raw)) : emptyData();
  } catch {
    data = emptyData();
  }

  return {
    get data() { return data; },

    /** Aplica uma mutação e persiste; se a gravação falhar, desfaz. */
    update(fn) {
      const before = JSON.stringify(data);
      const result = fn(data);
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch (e) {
        data = JSON.parse(before);
        throw new Error(`Não foi possível salvar no navegador (${e.name === 'QuotaExceededError' ? 'espaço esgotado' : e.message}).`);
      }
      return result;
    },

    replaceAll(next) {
      const validated = validateData(next);
      storage.setItem(STORAGE_KEY, JSON.stringify(validated));
      data = validated;
    },
  };
}
