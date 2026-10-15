// Persistência no próprio navegador (localStorage), como no fatura-dashboard.
// Os PDFs não são guardados — só os dados extraídos, as análises e a sua carteira.
// A chave do Gemini fica em uma entrada separada e NÃO vai para o backup.

import { DEFAULT_SETTINGS } from './portfolio.js';

export const STORAGE_KEY = 'carteira-ia:v1';
export const API_KEY_KEY = 'carteira-ia:gemini-key';
const PAGES_PREFIX = 'carteira-ia:pages:';
const SCHEMA_VERSION = 1;

export const emptyData = () => ({
  version: SCHEMA_VERSION,
  reports: [],      // { id, month, type, filename, importedAt, ...normalizeReport() }
  analyses: {},     // reportId → { at, model, overview, items: { ticker → análise } }
  holdings: [],     // { id, ticker, type, qty, avgPrice, price }
  snapshots: [],    // balanço mensal: { month, at, total, cost, byClass, byAsset }
  notes: {},        // pareceres da IA por mês: { [mês]: { ranking|portfolio|plan: { text, by, at } } }
  settings: structuredClone(DEFAULT_SETTINGS),
  model: null,
});

export function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

export function validateData(data) {
  if (!data || typeof data !== 'object') throw new Error('Backup inválido');
  if (data.version !== SCHEMA_VERSION) throw new Error(`Versão de backup não suportada: ${data.version}`);
  if (!Array.isArray(data.reports) || !Array.isArray(data.holdings)) throw new Error('Backup inválido: faltam relatórios ou carteira');
  if (!data.analyses || typeof data.analyses !== 'object') throw new Error('Backup inválido: "analyses" ausente');
  if (!Array.isArray(data.snapshots)) data.snapshots = [];
  if (!data.notes || typeof data.notes !== 'object') data.notes = {};
  data.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(data.settings ?? {}) };
  data.settings.targets = { ...DEFAULT_SETTINGS.targets, ...(data.settings.targets ?? {}) };
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

    /** Imagens das páginas da tabela (para conferir a leitura). Separadas e opcionais: se não couber, só não guarda. */
    savePages(id, pages) {
      try { storage.setItem(`${PAGES_PREFIX}${id}`, JSON.stringify(pages)); return true; } catch { return false; }
    },
    pages(id) {
      try { return JSON.parse(storage.getItem(`${PAGES_PREFIX}${id}`) ?? '[]'); } catch { return []; }
    },
    removePages(id) { try { storage.removeItem?.(`${PAGES_PREFIX}${id}`); } catch { /* ignora */ } },

    get apiKey() { try { return storage.getItem(API_KEY_KEY) ?? ''; } catch { return ''; } },
    set apiKey(v) { if (v) storage.setItem(API_KEY_KEY, v); else storage.removeItem?.(API_KEY_KEY); },
  };
}
