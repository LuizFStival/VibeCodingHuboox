// Armazenamento no banco do Artifact (capability `db`) com a interface do localStorage
// (getItem/setItem/removeItem), para o store.js funcionar igual.
//
// Os dados ficam na área privada do usuário (data/users/<id>/…), um documento por parte,
// para respeitar o limite de 256 KiB por documento e guardar o histórico mês a mês:
//   app                      → configurações, carteira (posições) e modelo
//   r-<mês>:<tipo>           → um relatório (extração do PDF) + a análise da IA dele
//   p-<mês>:<tipo>           → endereços das imagens das páginas da tabela (no `assets`)
// As leituras são síncronas (de uma cópia em memória carregada na abertura); as
// gravações vão para o banco em segundo plano, só dos documentos que mudaram.

import { STORAGE_KEY } from './store.js';

const PAGES_PREFIX = 'carteira-ia:pages:';

export async function createDbStorage({ db, user, assets, onError = () => {} }) {
  const uid = await user?.id?.();
  if (!db || !uid) return null;
  const col = db.collection(`data/users/${uid}`);
  const snap = await col.get();
  const docs = new Map(snap.docs.map((d) => [d.id, d.data()]));

  // Monta o JSON do app a partir dos documentos.
  const app = docs.get('app');
  let main = null;
  if (app) {
    const reports = []; const analyses = {};
    for (const [id, body] of docs) {
      if (!id.startsWith('r-')) continue;
      if (body.report) reports.push(body.report);
      if (body.analysis && body.report) analyses[body.report.id] = body.analysis;
    }
    main = JSON.stringify({ ...app, reports, analyses });
  }
  const pages = new Map([...docs].filter(([id]) => id.startsWith('p-')).map(([id, b]) => [id.slice(2), JSON.stringify(b.pages ?? [])]));

  // Gravações: uma por documento por vez; a mais recente vence.
  const written = new Map([...docs].map(([id, b]) => [id, JSON.stringify(b)]));
  const pending = new Map();
  const running = new Set();
  async function flush(id) {
    if (running.has(id)) return;
    running.add(id);
    try {
      while (pending.has(id)) {
        const body = pending.get(id); pending.delete(id);
        const json = body === null ? null : JSON.stringify(body);
        if (json === (written.get(id) ?? null)) continue;
        if (body === null) await col.doc(id).delete(); else await col.doc(id).set(body);
        if (json === null) written.delete(id); else written.set(id, json);
      }
    } catch (e) {
      onError(e?.code === 'quota_exceeded' ? 'O banco do app está cheio. Remova meses antigos.' : `Não consegui salvar no banco do Claude (${e?.code ?? e?.message}).`);
    } finally { running.delete(id); }
  }
  const put = (id, body) => { pending.set(id, body); flush(id); };

  function saveMain(json) {
    const data = JSON.parse(json);
    const { reports = [], analyses = {}, ...rest } = data;
    put('app', rest);
    const keep = new Set();
    for (const r of reports) {
      const id = `r-${r.id}`;
      keep.add(id);
      put(id, { report: r, analysis: analyses[r.id] ?? null });
    }
    for (const id of written.keys()) if (id.startsWith('r-') && !keep.has(id)) put(id, null);
  }

  async function savePages(key, json) {
    const list = JSON.parse(json);
    if (!assets) return;
    const out = [];
    for (const pg of list) {
      if (pg.url) { out.push(pg); continue; }
      const bin = atob(pg.data); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      try {
        const a = await assets.upload(new Blob([bytes], { type: pg.mimeType }));
        out.push({ page: pg.page, url: a.url, assetId: a.id });
      } catch { /* sem imagem: a conferência segue sem a página */ }
    }
    pages.set(key, JSON.stringify(out));
    put(`p-${key}`, { pages: out });
  }

  return {
    getItem(k) {
      if (k === STORAGE_KEY) return main;
      if (k.startsWith(PAGES_PREFIX)) return pages.get(k.slice(PAGES_PREFIX.length)) ?? null;
      return null;
    },
    setItem(k, v) {
      if (k === STORAGE_KEY) { main = v; saveMain(v); return; }
      if (k.startsWith(PAGES_PREFIX)) {
        const key = k.slice(PAGES_PREFIX.length);
        pages.set(key, v); // já mostra a imagem local enquanto sobe para o assets
        savePages(key, v);
      }
      // A chave de API não existe no painel: nada a guardar.
    },
    removeItem(k) {
      if (k.startsWith(PAGES_PREFIX)) {
        const key = k.slice(PAGES_PREFIX.length);
        const old = JSON.parse(pages.get(key) ?? '[]');
        pages.delete(key);
        put(`p-${key}`, null);
        for (const pg of old) if (pg.assetId) assets?.delete(pg.assetId).catch(() => {});
      }
    },
  };
}
