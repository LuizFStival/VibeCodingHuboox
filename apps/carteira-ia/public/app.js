// Front-end sem build: ES modules + CSS. Todo texto vindo dos relatórios ou da IA
// entra via textContent (helper h), nunca innerHTML.
// Não há servidor: os dados ficam no localStorage e o Gemini é chamado direto daqui.

import { createService } from './core/service.js';
import { createStore, memoryStorage } from './core/store.js';
import { createGemini, DEFAULT_MODEL, MODEL_OPTIONS, usefulModels, pickModel } from './core/gemini.js';
import { ASSET_TYPES, TYPE_IDS, detectMonth, detectType, reportStats, upside, checkReport } from './core/report.js';

const FAST_PAGES = 8; // leitura rápida: tabela, resumo, mudanças e desempenho ficam no começo
import { VERDICTS } from './core/prompts.js';

let storage;
try {
  storage = window.localStorage;
  storage.getItem('probe');
} catch {
  storage = memoryStorage();
}
const store = createStore(storage);
const svc = createService(store);

const state = {
  tab: 'reports',
  month: null,
  type: null,           // carteira aberta na aba 1
  expanded: new Set(),  // linhas abertas na tabela
  anFilter: 'all',
  anSkip: new Set(),    // carteiras desmarcadas na aba de análise
  manualText: {},       // respostas coladas (modo manual), por relatório
  showPages: new Set(), // relatórios com a página original aberta
  aporte: 1000,
  review: null,         // { key, text, sources } — opinião da IA sobre o último plano
  busy: false,
  diag: null,           // resultado do último teste em Configurações
  models: null,         // modelos disponíveis para a chave (listModels)
};

// ---------- utilidades
const $ = (sel) => document.querySelector(sel);
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monthLong = (m) => {
  const [y, mm] = m.split('-');
  const name = new Date(Date.UTC(+y, +mm - 1, 15)).toLocaleString('pt-BR', { month: 'long', timeZone: 'UTC' });
  return `${name[0].toUpperCase()}${name.slice(1)} ${y}`;
};
const monthShort = (m) => { const [y, mm] = m.split('-'); return `${MONTHS[+mm - 1]}/${y.slice(2)}`; };
const brl = (v, digits = 2) => (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: digits, maximumFractionDigits: digits });
const money = (v, cur) => (v === null || v === undefined ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: cur, minimumFractionDigits: 2 }));
const pct = (x, digits = 1) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${(x * 100).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`);
const signedPct = (x, digits = 1) => (x === null || x === undefined ? '—' : `${x > 0 ? '+' : ''}${pct(x, digits)}`);
const qtyFmt = (q) => q.toLocaleString('pt-BR', { maximumFractionDigits: 4 });
const REC_LABEL = { COMPRAR: 'Comprar', AGUARDAR: 'Aguardar', MANTER: 'Manter', VENDER: 'Vender' };

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const card = (title, right, ...body) => h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, title), right ?? null), ...body);
const kpi = (label, value, hint, cls = '') => h('div', { class: `card kpi ${cls}` }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), hint ? h('div', { class: 'hint' }, hint) : null);
const recBadge = (rec) => h('span', { class: `badge rec-${rec}` }, REC_LABEL[rec] ?? rec);
const verdictBadge = (v) => (v ? h('span', { class: `badge ver-${v}`, title: 'Veredito da IA sobre a recomendação' }, `IA: ${VERDICTS[v]}`) : null);
const tickerCell = (ticker, name) => h('td', { class: 'tk' }, ticker, name ? h('small', {}, name) : null);
const sourceLinks = (sources) => (sources?.length
  ? h('div', { class: 'sources' }, h('span', { class: 'muted' }, 'Fontes:'), sources.map((s) => h('a', { href: s.uri, target: '_blank', rel: 'noopener noreferrer', title: s.title || s.uri }, s.title || new URL(s.uri).hostname)))
  : null);

function bars(rows, { max } = {}) {
  const top = max ?? Math.max(...rows.map((r) => Math.max(r.value, r.target ?? 0)), 0.0001);
  return h('div', { class: 'bars' }, rows.map((r) => h('div', { class: 'bar-row', title: r.title ?? '' },
    h('span', { class: 'label' }, r.label),
    h('div', { class: 'bar-track' },
      h('div', { class: `bar-fill ${r.cls ?? ''}`, style: { width: `${(r.value / top) * 100}%` } }),
      r.target !== undefined ? h('span', { class: 'bar-target', style: { left: `calc(${(r.target / top) * 100}% - 1px)` }, title: `Alvo: ${pct(r.target)}` }) : null),
    h('span', { class: 'value' }, r.text))));
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 7000 : 3500);
}

/** Barra de progresso de uma tarefa longa (leitura de PDF, análise). */
function job(label) {
  const box = $('#jobs');
  const text = h('span', {}, label);
  const fill = h('span', { style: { width: '0%' } });
  const el = h('div', { class: 'job' }, text, h('div', { class: 'bar' }, fill));
  box.append(el);
  box.hidden = false;
  const remove = (ms) => setTimeout(() => { el.remove(); box.hidden = !box.children.length; }, ms);
  return {
    update(msg, frac) { text.textContent = msg; if (frac !== undefined) fill.style.width = `${Math.round(frac * 100)}%`; },
    done(msg) { el.classList.add('done'); this.update(msg, 1); remove(4000); },
    fail(msg) { el.classList.add('error'); this.update(msg); remove(10000); },
  };
}

function gemini() {
  return createGemini({
    apiKey: store.apiKey,
    model: svc.model || DEFAULT_MODEL,
    // Modelo desativado pelo Google: o cliente troca sozinho; aqui só salvamos e avisamos.
    onModelChange: (next, old) => { svc.setModel(next); toast(`O modelo ${old} não está mais disponível na sua chave. Passei a usar ${next}.`); },
  });
}
const hasKey = () => Boolean(store.apiKey);

/** Renderiza texto simples da IA (tópicos com "-", "*" ou "1)") sem usar HTML. */
function renderPlainText(text) {
  const out = h('div', { class: 'review' });
  let list = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\*\*/g, '').replace(/^#+\s*/, '').trim();
    if (!line) { list = null; continue; }
    const m = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (m) { if (!list) { list = h('ul'); out.append(list); } list.append(h('li', {}, m[1])); } else { list = null; out.append(h('p', {}, line)); }
  }
  return out;
}

// ---------- mês e navegação
function refreshMonths() {
  const months = svc.months();
  if (!months.includes(state.month)) state.month = months[0] ?? null;
  const sel = $('#monthSelect');
  sel.replaceChildren(...(months.length ? months : ['']).map((m) => h('option', { value: m }, m ? monthLong(m) : '—')));
  sel.value = state.month ?? '';
  sel.disabled = !months.length;
}

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const s of document.querySelectorAll('.tab-panel')) s.hidden = s.id !== `tab-${tab}`;
  render();
}

function render() {
  refreshMonths();
  const panel = $(`#tab-${state.tab}`);
  const fn = { reports: renderReports, analysis: renderAnalysis, mine: renderMine, aporte: renderAporte, settings: renderSettings }[state.tab];
  panel.replaceChildren(...[fn()].flat(Infinity).filter(Boolean));
}

function emptyState() {
  return h('section', { class: 'empty' },
    h('h2', {}, 'Suba as carteiras recomendadas do mês'),
    h('p', { class: 'muted' }, 'Envie os PDFs de Ações, FIIs e Internacional (pode ser os três de uma vez). A IA lê as tabelas e as teses e organiza tudo aqui. O tipo e o mês vêm do nome do arquivo, ex.: Carteira_Fiis_-_Outubro26.pdf.'),
    hasKey() ? null : h('p', { class: 'notice' }, 'Antes, cole sua chave da API do Gemini em ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); setTab('settings'); } }, 'Configurações'), ' (é gratuita no Google AI Studio).'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => $('#fileInput').click() }, 'Escolher PDFs'),
    h('p', { class: 'muted small' }, '🔒 Os dados ficam só neste navegador. Os PDFs vão apenas para a API do Gemini, com a sua chave.'));
}

// ---------- 1 · Carteiras
function renderReports() {
  if (!state.month) return emptyState();
  const reports = svc.reportsFor(state.month);
  if (!reports.some((r) => r.type === state.type)) state.type = reports[0]?.type ?? null;
  const analyses = svc.analysesFor(state.month);

  const cards = h('div', { class: 'grid three' }, TYPE_IDS.map((type) => {
    const r = reports.find((x) => x.type === type);
    if (!r) {
      return h('button', { class: `type-card type-${type} missing`, type: 'button', onclick: () => $('#fileInput').click() },
        h('span', {}, h('span', { class: 'dot' }), ASSET_TYPES[type].label),
        h('span', { class: 'small' }, `Sem relatório de ${monthShort(state.month)} — clique para subir`));
    }
    const st = reportStats(r);
    return h('button', { class: `type-card type-${type}`, type: 'button', 'aria-pressed': String(state.type === type), onclick: () => { state.type = type; state.expanded.clear(); render(); } },
      h('span', { class: 'small' }, h('span', { class: 'dot' }), ASSET_TYPES[type].label, r.provider ? ` · ${r.provider}` : ''),
      h('span', { class: 'big' }, `${st.assets} ativos`),
      h('span', { class: 'small muted' }, `DY médio ${pct(st.dy)} · potencial ${signedPct(st.upside)}`),
      h('span', { class: 'chips' }, st.buy ? h('span', { class: 'badge rec-COMPRAR' }, `${st.buy} comprar`) : null,
        st.wait ? h('span', { class: 'badge rec-AGUARDAR' }, `${st.wait} aguardar`) : null,
        st.sell ? h('span', { class: 'badge rec-VENDER' }, `${st.sell} vender`) : null));
  }));

  const r = reports.find((x) => x.type === state.type);
  return [cards, r ? reportDetail(r, analyses) : null];
}

function reportDetail(r, analyses) {
  const st = reportStats(r);
  const cur = ASSET_TYPES[r.type].currency;
  const an = svc.analysis(r.id);

  const head = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'stack', style: { gap: '4px' } },
        h('h2', {}, r.title || `Carteira de ${ASSET_TYPES[r.type].label}`),
        h('span', { class: 'muted small' }, [r.provider, monthLong(r.month), r.filename, `importado em ${new Date(r.importedAt).toLocaleDateString('pt-BR')}`].filter(Boolean).join(' · '))),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary small', type: 'button', onclick: () => runAnalysis([r.id]) }, an ? 'Reanalisar com IA' : 'Analisar com IA'),
        h('button', { class: 'btn small', type: 'button', onclick: () => editReport(r) }, 'Corrigir dados'),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => { if (confirm('Remover este relatório e a análise dele?')) { svc.removeReport(r.id); toast('Relatório removido.'); render(); } } }, 'Remover'))),
    r.summary ? h('p', { class: 'prose' }, r.summary) : null,
    r.macro.length ? h('div', { class: 'chips', style: { 'margin-top': '10px' } }, r.macro.map((m) => h('span', { class: 'chip' }, m))) : null);

  const perf = r.performance.items;
  const kpis = h('div', { class: 'grid kpis' },
    kpi('Ativos', String(st.assets), `${st.buy} comprar · ${st.wait} aguardar${st.sell ? ` · ${st.sell} vender` : ''}`, 'hero'),
    kpi('DY médio', pct(st.dy), 'ponderado pelo peso'),
    kpi('Potencial até o teto', signedPct(st.upside), 'média ponderada'),
    perf.length ? kpi('Desde o início', perf.map((p) => `${p.name.length > 12 ? p.name.slice(0, 12) : p.name} ${p.returnPct > 0 ? '+' : ''}${p.returnPct.toLocaleString('pt-BR')}%`)[0], [perf.slice(1).map((p) => `${p.name} ${p.returnPct > 0 ? '+' : ''}${p.returnPct.toLocaleString('pt-BR')}%`).join(' · '), r.performance.period].filter(Boolean).join(' — ')) : null);

  const changes = r.changes.length ? card('Mudanças do mês', null,
    h('ul', { class: 'alert-list' }, r.changes.map((c) => h('li', { class: /vend|sa[ií]da/i.test(c.action) ? 'vender' : /entr|compr/i.test(c.action) ? 'falta' : '' },
      h('b', {}, c.ticker), c.action ? ` — ${c.action}` : '', c.reason ? h('div', { class: 'muted small' }, c.reason) : null)))) : null;

  const active = r.assets.filter((a) => a.weight > 0).sort((a, b) => b.weight - a.weight);
  const charts = h('div', { class: 'grid two' },
    card('Alocação por ativo', h('span', { class: 'muted small' }, `soma ${pct(st.weightSum, 0)}`),
      bars(active.map((a) => ({ label: a.ticker, value: a.weight, text: pct(a.weight, 2), cls: `fill-${a.rec}`, title: `${a.name} — ${REC_LABEL[a.rec]}` }))),
      h('div', { class: 'legend' }, ['COMPRAR', 'AGUARDAR', 'MANTER'].map((x) => h('span', { class: `fill-${x}` }, h('i'), REC_LABEL[x])))),
    card('Por segmento', null, bars(st.segments.map((s) => ({ label: s.name, value: s.share, text: pct(s.share), cls: `fill-${r.type}` })))));

  const cols = r.type === 'fiis' ? ['Ativo', 'Segmento', 'Peso', 'DY', 'P/VP', 'Preço', 'Teto', 'Potencial', 'Recomendação', 'IA'] : ['Ativo', 'Segmento', 'Peso', 'DY', 'Preço', 'Teto/justo', 'Potencial', 'Recomendação', 'IA'];
  const body = h('tbody');
  for (const a of [...r.assets].sort((x, y) => y.weight - x.weight)) {
    const up = upside(a);
    const ai = analyses[a.ticker];
    const open = state.expanded.has(a.ticker);
    body.append(h('tr', { class: `clickable${a.rec === 'VENDER' ? ' sold' : ''}`, 'aria-expanded': String(open), onclick: () => { open ? state.expanded.delete(a.ticker) : state.expanded.add(a.ticker); render(); } },
      tickerCell(a.ticker, a.name),
      h('td', { class: 'small' }, a.segment || '—'),
      h('td', { class: 'num' }, pct(a.weight, 2)),
      h('td', { class: 'num' }, pct(a.dy, 2)),
      r.type === 'fiis' ? h('td', { class: 'num' }, a.pvp?.toLocaleString('pt-BR') ?? '—') : null,
      h('td', { class: 'num' }, money(a.price, cur)),
      h('td', { class: 'num' }, money(a.ceiling, cur)),
      h('td', { class: `num ${up > 0 ? 'pos' : up < 0 ? 'neg' : ''}` }, signedPct(up)),
      h('td', {}, recBadge(a.rec)),
      h('td', {}, ai ? verdictBadge(ai.verdict) : h('span', { class: 'muted small' }, '—'))));
    if (open) {
      body.append(h('tr', { class: 'detail' }, h('td', { colspan: cols.length },
        h('div', { class: 'stack' },
          h('span', { class: 'small muted' }, [a.strategy ? `Estratégia: ${a.strategy}` : '', a.page ? `lido na página ${a.page} do PDF` : ''].filter(Boolean).join(' · ')),
          h('p', { class: 'prose' }, a.thesis || 'O relatório não traz tese para este ativo.'),
          ai ? h('div', { class: 'stack' }, h('div', { class: 'row' }, h('b', {}, 'Leitura da IA'), verdictBadge(ai.verdict), h('span', { class: 'small muted' }, `sugere ${REC_LABEL[ai.aiRec]}`)), h('p', { class: 'prose' }, ai.summary)) : null))));
    }
  }
  const table = card('Carteira em detalhes', h('span', { class: 'muted small' }, 'clique numa linha para ver a tese'),
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))), body)));

  return [head, verifyCard(r), kpis, changes, charts, table].filter(Boolean);
}

/** Conferência da leitura: verificações automáticas + a página original da tabela. */
function verifyCard(r) {
  const checks = checkReport(r);
  const bad = checks.filter((c) => !c.ok).length;
  const ex = r.extraction;
  const pages = state.showPages.has(r.id) ? svc.tablePages(r.id) : [];
  const where = r.tablePages?.length ? `tabela na página ${r.tablePages.join(', ')}` : '';
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', {}, bad ? `Conferir a leitura · ${bad} ponto(s) de atenção` : 'Conferir a leitura · tudo certo'),
      ex ? h('button', { class: 'btn small', type: 'button', onclick: () => { state.showPages.has(r.id) ? state.showPages.delete(r.id) : state.showPages.add(r.id); render(); } }, state.showPages.has(r.id) ? 'Esconder página' : 'Ver página original da tabela') : null),
    h('p', { class: 'muted small', style: { 'margin-bottom': '8px' } }, ex
      ? `Lido do PDF pelo ${ex.model} em ${ex.seconds} s · ${ex.pagesSent} de ${ex.pagesTotal} páginas enviadas${where ? ` · ${where}` : ''}${ex.edited ? ' · corrigido à mão' : ''}.`
      : 'Importado de um arquivo .json (não veio da leitura de um PDF).'),
    h('ul', { class: 'alert-list' }, checks.map((c) => h('li', { class: c.ok ? 'falta' : 'preco' }, `${c.ok ? '✓' : '!'} ${c.msg}`))),
    pages.length ? h('div', { class: 'page-shots' }, pages.map((pg) => h('figure', {},
      h('img', { src: `data:${pg.mimeType};base64,${pg.data}`, alt: `Página ${pg.page} do PDF`, loading: 'lazy' }),
      h('figcaption', { class: 'muted small' }, `Página ${pg.page} do PDF original — compare com a tabela abaixo.`)))) : null,
    state.showPages.has(r.id) && !pages.length ? h('p', { class: 'muted small' }, 'A imagem da página não foi guardada (espaço do navegador cheio).') : null,
    bad ? h('p', { class: 'muted small', style: { 'margin-top': '8px' } }, 'Achou diferença? Use "Corrigir dados" no topo para ajustar.') : null);
}

function editReport(r) {
  const raw = {
    provider: r.provider, title: r.title, summary: r.summary, macroHighlights: r.macro, changes: r.changes,
    assets: r.assets.map((a) => ({
      ticker: a.ticker, name: a.name, segment: a.segment, allocationPct: +(a.weight * 100).toFixed(4), strategy: a.strategy,
      dividendYieldPct: a.dy === null ? null : +(a.dy * 100).toFixed(4), price: a.price, ceilingPrice: a.ceiling, pvp: a.pvp, recommendation: a.rec, thesis: a.thesis,
    })),
    performance: r.performance,
  };
  openTextDialog({
    title: `Corrigir ${ASSET_TYPES[r.type].label} · ${monthLong(r.month)}`,
    hint: 'A IA pode errar algum número na leitura do PDF. Ajuste aqui (percentuais em %, ex.: 12 = 12%).',
    value: JSON.stringify(raw, null, 2),
    onSave: (text) => { svc.updateReport(r.id, JSON.parse(text)); toast('Relatório atualizado.'); render(); },
  });
}

// ---------- 2 · Análise IA
/** ids: relatórios a analisar. only: { [id]: tickers } para analisar só alguns (continuar de onde parou). */
async function runAnalysis(ids, only = {}) {
  if (!hasKey()) { toast('Configure a chave da API do Gemini primeiro.', true); setTab('settings'); return; }
  if (state.busy) { toast('Já existe uma análise em andamento.'); return; }
  if (!ids.length) { toast('Selecione ao menos uma carteira.'); return; }
  state.busy = true;
  if (state.tab !== 'analysis') setTab('analysis'); else render();
  const g = gemini();
  try {
    for (const id of ids) {
      const r = svc.report(id);
      const name = ASSET_TYPES[r.type].label;
      const j = job(`${name}: preparando…`);
      let base = '';
      try {
        const res = await svc.analyzeReport(g, id, {
          tickers: only[id],
          onProgress: (done, total, tickers) => { base = tickers.length ? `${name}: pesquisando ${tickers.join(', ')} (${done}/${total})` : `${name}: concluído`; j.update(base, total ? done / total : 1); },
          onStatus: (msg) => j.update(`${base} — ${msg}`),
        });
        const n = Object.keys(res.items).length;
        if (res.fatal) { j.fail(`${name}: ${res.fatal}`); render(); break; }
        if (res.pending.length || res.errors.length) j.fail(`${name}: ${n} analisados, ${res.pending.length} faltando. Detalhes no cartão de ${name}.`);
        else j.done(`${name}: ${n} ativos analisados${res.searched < n ? ` (${n - res.searched} sem pesquisa na web)` : ''}.`);
      } catch (e) {
        j.fail(`${name}: ${e.message}`);
      }
      render();
    }
  } finally {
    state.busy = false;
    render();
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* sem permissão: usa o método antigo */ }
  const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
  ta.value = text; document.body.append(ta); ta.select();
  const ok = document.execCommand('copy'); ta.remove();
  return ok;
}

const CHAT_LINKS = [['Abrir Gemini', 'https://gemini.google.com/app'], ['Abrir ChatGPT', 'https://chatgpt.com/']];

/** Uma carteira no modo manual: 1) copiar pedido 2) colar no chat 3) colar a resposta aqui. */
function manualRow(r) {
  const an = svc.analysis(r.id);
  const done = an ? r.assets.filter((a) => an.items[a.ticker]).length : 0;
  const missing = r.assets.length - done;
  const paste = h('textarea', { rows: 4, placeholder: 'Cole aqui a resposta do chat (o bloco JSON inteiro)…', oninput: (e) => { state.manualText[r.id] = e.target.value; } });
  paste.value = state.manualText[r.id] ?? '';
  const copy = async (all) => {
    const { prompt, count } = svc.manualPrompt(r.id, { all });
    toast(await copyText(prompt) ? `Pedido de ${count} ativo(s) copiado. Cole no Gemini ou ChatGPT.` : 'Não consegui copiar — selecione o texto manualmente.', false);
  };
  return h('div', { class: 'manual-row' },
    h('div', { class: 'row' },
      h('b', {}, h('span', { class: `dot type-${r.type}` }), ASSET_TYPES[r.type].label),
      h('span', { class: `badge ${missing ? 'rec-AGUARDAR' : 'rec-COMPRAR'}` }, `${done}/${r.assets.length} analisados`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small primary', type: 'button', onclick: () => copy(false) }, missing && done ? `1 · Copiar pedido (${missing} que faltam)` : '1 · Copiar pedido'),
      done ? h('button', { class: 'btn small', type: 'button', onclick: () => copy(true), title: 'Pedir de novo todos os ativos' }, 'Refazer todos') : null,
      CHAT_LINKS.map(([label, href]) => h('a', { class: 'btn small', href, target: '_blank', rel: 'noopener noreferrer' }, label))),
    paste,
    h('div', { class: 'row' },
      h('button', { class: 'btn small primary', type: 'button', onclick: () => {
        try {
          const res = svc.importManualAnalysis(r.id, paste.value);
          state.manualText[r.id] = '';
          toast(`${ASSET_TYPES[r.type].label}: ${res.count} ativo(s) importados${res.pending.length ? `. Faltam ${res.pending.length} — copie o pedido de novo para pedir só eles.` : '.'}`);
          render();
        } catch (e) { toast(e.message, true); }
      } }, '2 · Importar resposta'),
      h('span', { class: 'muted small' }, 'Se o chat cortar a resposta, importe o que veio e copie o pedido de novo: ele pede só os que faltam.')));
}

function renderAnalysis() {
  if (!state.month) return emptyState();
  const reports = svc.reportsFor(state.month);
  const selected = reports.filter((r) => !state.anSkip.has(r.id)).map((r) => r.id);
  const calls = reports.reduce((s, r) => s + Math.ceil(r.assets.length / 5), 0);

  const mode = svc.settings().analysisMode ?? 'manual';
  const modeSwitch = h('div', { class: 'row' },
    [['manual', 'Copiar e colar (grátis, com pesquisa)'], ['api', 'Automático pela API']].map(([k, label]) => h('button', {
      class: `btn small${mode === k ? ' primary' : ''}`, type: 'button', onclick: () => { svc.updateSettings({ analysisMode: k }); render(); },
    }, label)));

  const apiControls = [
    h('p', { class: 'muted small', style: { 'margin-bottom': '12px' } },
      'O app chama a API do Gemini direto. A pesquisa na web pela API exige faturamento ativo no Google AI Studio; sem ele, a análise sai só com o conhecimento do modelo (marcada "sem pesquisa web").'),
    h('div', { class: 'row' },
      reports.map((r) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !state.anSkip.has(r.id), onchange: (e) => { e.target.checked ? state.anSkip.delete(r.id) : state.anSkip.add(r.id); render(); } }),
        `${ASSET_TYPES[r.type].label} (${r.assets.length})`)),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', type: 'button', disabled: state.busy || !reports.length, onclick: () => runAnalysis(selected) }, state.busy ? 'Analisando…' : 'Analisar selecionadas')),
    h('p', { class: 'muted small', style: { 'margin-top': '8px' } }, `Cerca de ${calls} chamadas à API (5 ativos por chamada), uma por vez.`),
    hasKey() ? null : h('p', { class: 'notice', style: { 'margin-top': '8px' } }, 'Configure a chave da API do Gemini em Configurações.'),
  ];

  const manualControls = [
    h('p', { class: 'muted small', style: { 'margin-bottom': '12px' } },
      'O Gemini e o ChatGPT do site (gratuitos) pesquisam na web. O app monta o pedido de cada carteira; você cola lá, copia a resposta e cola aqui. ',
      'Dica: abra uma conversa nova para cada carteira.'),
    h('div', { class: 'stack' }, reports.map((r) => manualRow(r))),
  ];

  const controls = card('Revisar as recomendações com IA', modeSwitch, mode === 'api' ? apiControls : manualControls);

  const filter = h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Mostrar:'),
    [['all', 'Todos'], ['DISCORDA', 'Discorda'], ['PARCIAL', 'Em parte'], ['CONCORDA', 'Concorda']].map(([k, label]) => h('button', {
      class: `btn small${state.anFilter === k ? ' primary' : ''}`, type: 'button', onclick: () => { state.anFilter = k; render(); },
    }, label)));

  const sections = reports.map((r) => {
    const an = svc.analysis(r.id);
    if (!an) return card(ASSET_TYPES[r.type].label, null, h('p', { class: 'muted' }, 'Ainda não analisada.'));
    const items = r.assets.map((a) => ({ a, ai: an.items[a.ticker] })).filter((x) => x.ai);
    const counts = Object.fromEntries(Object.keys(VERDICTS).map((v) => [v, items.filter((x) => x.ai.verdict === v).length]));
    const shown = items.filter((x) => state.anFilter === 'all' || x.ai.verdict === state.anFilter);
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, h('span', { class: `dot type-${r.type}` }), ASSET_TYPES[r.type].label),
        h('span', { class: 'muted small' }, `${new Date(an.at).toLocaleString('pt-BR')} · ${an.model} · `,
          `${counts.CONCORDA} concorda · ${counts.PARCIAL} em parte · ${counts.DISCORDA} discorda`)),
      an.pending?.length || an.errors?.length ? h('div', { class: 'notice', style: { 'margin-bottom': '12px' } },
        an.pending?.length ? h('div', { class: 'row' }, h('b', {}, `Faltam ${an.pending.length} ativo(s): ${an.pending.join(', ')}`), h('span', { class: 'spacer' }),
          h('button', { class: 'btn small primary', type: 'button', disabled: state.busy, onclick: () => runAnalysis([r.id], { [r.id]: an.pending }) }, 'Continuar de onde parou')) : null,
        an.errors?.length ? h('details', { open: !items.length }, h('summary', { class: 'small' }, `${an.errors.length} problema(s) na última execução`), h('ul', { class: 'small' }, an.errors.map((e) => h('li', {}, e)))) : null) : null,
      an.overview ? h('p', { class: 'prose', style: { 'margin-bottom': '12px' } }, an.overview) : null,
      h('div', { class: 'an-grid' }, shown.map(({ a, ai }) => analysisCard(a, ai, r))),
      shown.length ? null : h('p', { class: 'muted small' }, 'Nenhum ativo neste filtro.'));
  });

  return [controls, reports.some((r) => svc.analysis(r.id)) ? filter : null, ...sections];
}

function analysisCard(a, ai, r) {
  const cur = ASSET_TYPES[r.type].currency;
  const list = (title, items, fn = (x) => h('li', {}, x)) => (items.length ? h('div', { class: 'stack', style: { gap: '4px' } }, h('h4', {}, title), h('ul', {}, items.map(fn))) : null);
  return h('article', { class: `an-card ${ai.verdict}` },
    h('div', { class: 'row' }, h('b', {}, a.ticker), h('span', { class: 'muted small' }, a.name), h('span', { class: 'spacer' }), verdictBadge(ai.verdict)),
    h('div', { class: 'row small' }, 'Relatório:', recBadge(a.rec), '→ IA:', recBadge(ai.aiRec),
      ai.price ? h('span', { class: 'muted' }, `preço ${money(ai.price, cur)}${a.ceiling ? ` · teto ${money(a.ceiling, cur)}` : ''}`) : null,
      h('span', { class: 'muted' }, `confiança ${ai.confidence}`),
      ai.searched === false ? h('span', { class: 'badge rec-AGUARDAR', title: 'O modelo respondeu sem consultar o Google — pode estar desatualizado' }, 'sem pesquisa web') : null,
      ai.manual ? h('span', { class: 'badge rec-MANTER', title: 'Resposta colada de um chat com pesquisa na web' }, 'via chat') : null),
    ai.summary ? h('p', { class: 'prose' }, ai.summary) : null,
    list('Fundamentos', ai.fundamentals),
    list('Notícias', ai.news, (n) => h('li', { class: `imp-${n.impact}` }, n.title, n.date ? h('span', { class: 'muted small' }, ` (${n.date})`) : null)),
    list('Riscos', ai.risks),
    sourceLinks(ai.sources));
}

// ---------- 3 · Minha carteira
function renderMine() {
  const month = state.month;
  const cmp = month ? svc.compare(month) : svc.compare('0000-00');
  const settings = svc.settings();

  const addForm = h('form', { class: 'form-grid', onsubmit: (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      svc.upsertHolding({ ticker: f.get('ticker'), qty: f.get('qty'), avgPrice: f.get('avgPrice'), price: f.get('price'), type: f.get('type') || undefined });
      render();
    } catch (err) { toast(err.message, true); }
  } },
  h('label', { class: 'field' }, 'Ativo', h('input', { name: 'ticker', type: 'text', placeholder: 'ITUB3, HGLG11, VOO', required: true, autocomplete: 'off' })),
  h('label', { class: 'field' }, 'Classe', h('select', { name: 'type' }, h('option', { value: '' }, 'Detectar'), TYPE_IDS.map((t) => h('option', { value: t }, ASSET_TYPES[t].short)))),
  h('label', { class: 'field' }, 'Quantidade', h('input', { name: 'qty', type: 'text', inputmode: 'decimal', required: true })),
  h('label', { class: 'field' }, 'Preço médio', h('input', { name: 'avgPrice', type: 'text', inputmode: 'decimal', placeholder: 'opcional' })),
  h('label', { class: 'field' }, 'Preço atual', h('input', { name: 'price', type: 'text', inputmode: 'decimal', placeholder: 'do relatório/IA' })),
  h('button', { class: 'btn primary', type: 'submit' }, 'Adicionar'));

  const rows = [...cmp.rows].sort((a, b) => TYPE_IDS.indexOf(a.type) - TYPE_IDS.indexOf(b.type) || b.value - a.value);
  const universe = new Map(svc.reportsFor(month ?? '').flatMap((r) => r.assets.map((a) => [a.ticker, a])));
  const analyses = month ? svc.analysesFor(month) : {};
  const edit = (hd, field) => (e) => { try { svc.upsertHolding({ ...hd, [field]: e.target.value }); render(); } catch (err) { toast(err.message, true); render(); } };

  const table = rows.length ? h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Ativo', 'Classe', 'Qtd', 'Preço médio', 'Preço atual', 'Valor (R$)', '% total', 'Relatório', ''].map((c) => h('th', {}, c)))),
    h('tbody', {}, rows.map((r) => {
      const rec = universe.get(r.ticker);
      return h('tr', {},
        h('td', { class: 'tk' }, r.ticker),
        h('td', {}, h('select', { onchange: edit(r, 'type'), 'aria-label': 'Classe' }, TYPE_IDS.map((t) => h('option', { value: t, selected: r.type === t }, ASSET_TYPES[t].short)))),
        h('td', {}, h('input', { type: 'text', inputmode: 'decimal', value: String(r.qty), onchange: edit(r, 'qty'), 'aria-label': 'Quantidade' })),
        h('td', {}, h('input', { type: 'text', inputmode: 'decimal', value: r.avgPrice ?? '', onchange: edit(r, 'avgPrice'), 'aria-label': 'Preço médio' })),
        h('td', {}, h('input', { type: 'text', inputmode: 'decimal', value: r.price ?? '', placeholder: r.priceUsed ? String(r.priceUsed) : 'informe', onchange: edit(r, 'price'), 'aria-label': 'Preço atual' })),
        h('td', { class: 'num' }, brl(r.value)),
        h('td', { class: 'num' }, pct(cmp.total ? r.value / cmp.total : 0)),
        h('td', {}, rec ? recBadge(rec.rec) : h('span', { class: 'muted small' }, 'fora'), ' ', analyses[r.ticker] ? verdictBadge(analyses[r.ticker].verdict) : null),
        h('td', {}, h('button', { class: 'btn ghost small', type: 'button', title: 'Remover', onclick: () => { svc.removeHolding(r.id); render(); } }, '✕')));
    })),
    h('tfoot', {}, h('tr', {}, h('td', { colspan: 5 }, 'Total'), h('td', { class: 'num' }, brl(cmp.total)), h('td', { colspan: 3 }))))) : h('p', { class: 'muted' }, 'Nenhuma posição ainda. Adicione acima ou cole a lista da sua corretora.');

  const holdingsCard = card('Minhas posições', h('div', { class: 'row' },
    h('button', { class: 'btn small', type: 'button', onclick: pasteHoldings }, 'Colar lista'),
    rows.length ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => { if (confirm('Apagar todas as posições?')) { svc.importHoldingsText('', { replace: true }); render(); } } }, 'Limpar') : null),
  addForm, h('div', { style: { 'margin-top': '14px' } }, table),
  h('p', { class: 'muted small', style: { 'margin-top': '8px' } }, `Preço atual em branco = usa o preço da análise da IA ou do relatório. Internacional em US$, convertido a ${brl(settings.usdBrl)} (ajuste no Aporte).`));

  if (!rows.length) return [holdingsCard];

  const classCard = card('Distribuição por classe', h('span', { class: 'muted small' }, 'traço = alvo'),
    h('div', { class: 'stacked', style: { 'margin-bottom': '14px' } }, cmp.classes.filter((c) => c.value > 0).map((c) => h('span', { class: `fill-${c.type}`, style: { width: `${c.pct * 100}%` }, title: `${c.label}: ${pct(c.pct)}` }))),
    bars(cmp.classes.map((c) => ({ label: ASSET_TYPES[c.type].short, value: c.pct, target: c.target, cls: `fill-${c.type}`, text: `${pct(c.pct)} · ${brl(c.value, 0)}` })), { max: 1 }));

  const alertsCard = card('O que chama atenção', h('span', { class: 'muted small' }, month ? `vs. carteiras de ${monthShort(month)}` : ''),
    cmp.alerts.length ? h('ul', { class: 'alert-list' }, cmp.alerts.map((a) => h('li', { class: a.kind }, a.message))) : h('p', { class: 'muted' }, 'Tudo alinhado com as carteiras recomendadas.'));

  const perClass = cmp.classes.filter((c) => c.hasReport).map((c) => card(`${c.label}: sua carteira × recomendada`, h('span', { class: 'muted small' }, `${brl(c.value, 0)} na classe`),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Ativo', 'Recomendação', 'Peso alvo', 'Seu peso', 'Diferença', 'Seu valor'].map((x) => h('th', {}, x)))),
      h('tbody', {},
        c.assets.filter((a) => a.targetWeight > 0 || a.owned).sort((x, y) => y.targetWeight - x.targetWeight).map((a) => h('tr', { class: a.rec === 'VENDER' ? 'sold' : '' },
          tickerCell(a.ticker, a.name),
          h('td', {}, recBadge(a.rec), ' ', verdictBadge(a.verdict)),
          h('td', { class: 'num' }, pct(a.targetWeight)),
          h('td', { class: 'num' }, pct(a.myWeight)),
          h('td', { class: `num ${a.gap > 0.005 ? 'pos' : a.gap < -0.005 ? 'neg' : ''}` }, a.gap > 0.005 ? `faltam ${pct(a.gap)}` : a.gap < -0.005 ? `sobram ${pct(-a.gap)}` : 'ok'),
          h('td', { class: 'num' }, a.myValue ? brl(a.myValue, 0) : '—'))),
        c.outside.map((o) => h('tr', {}, h('td', { class: 'tk' }, o.ticker, h('small', {}, 'fora da recomendada')), h('td', {}, '—'), h('td', { class: 'num' }, '0%'), h('td', { class: 'num' }, pct(c.value ? o.value / c.value : 0)), h('td', { class: 'num neg' }, 'fora'), h('td', { class: 'num' }, brl(o.value, 0)))))))));

  return [holdingsCard, h('div', { class: 'grid two' }, classCard, alertsCard), ...perClass];
}

function pasteHoldings() {
  openTextDialog({
    title: 'Colar posições',
    hint: 'Uma posição por linha: TICKER QUANTIDADE [PREÇO MÉDIO] [PREÇO ATUAL]. Aceita tab (copiado de planilha), ponto e vírgula ou espaços. Ex.: "ITUB3 100 32,50".',
    value: '',
    replaceOption: true,
    onSave: (text, replace) => {
      const r = svc.importHoldingsText(text, { replace });
      toast(`${r.count} posições importadas${r.errors.length ? ` · ${r.errors.join('; ')}` : ''}.`, Boolean(r.errors.length));
      render();
    },
  });
}

// ---------- 4 · Aporte
function renderAporte() {
  if (!state.month) return emptyState();
  const s = svc.settings();
  const plan = svc.plan(state.month, state.aporte);
  const planKey = JSON.stringify([state.month, state.aporte, s, plan.lines.map((l) => [l.ticker, l.qty])]);
  if (state.review && state.review.key !== planKey) state.review = null;

  const setTarget = (t) => (e) => { svc.updateSettings({ targets: { [t]: Math.max(0, Number(e.target.value) || 0) / 100 } }); render(); };
  const sumTargets = TYPE_IDS.reduce((acc, t) => acc + (s.targets[t] ?? 0), 0);
  const form = card('Quanto você quer aportar?', null,
    h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, 'Valor do aporte (R$)', h('input', { class: 'input-money', type: 'number', min: 0, step: 50, value: String(state.aporte), onchange: (e) => { state.aporte = Math.max(0, Number(e.target.value) || 0); render(); } })),
      TYPE_IDS.map((t) => h('label', { class: 'field' }, `Alvo ${ASSET_TYPES[t].short} (%)`, h('input', { type: 'number', min: 0, max: 100, step: 5, value: String(Math.round((s.targets[t] ?? 0) * 100)), onchange: setTarget(t) }))),
      h('label', { class: 'field' }, 'Dólar (R$)', h('input', { type: 'number', min: 0, step: 0.01, value: String(s.usdBrl), onchange: (e) => { svc.updateSettings({ usdBrl: Number(e.target.value) || 0 }); render(); } }))),
    Math.abs(sumTargets - 1) > 0.001 ? h('p', { class: 'muted small', style: { 'margin-top': '6px' } }, `Os alvos somam ${Math.round(sumTargets * 100)}% — são normalizados para 100%.`) : null,
    h('div', { class: 'row', style: { 'margin-top': '12px' } },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.respectAi, onchange: (e) => { svc.updateSettings({ respectAi: e.target.checked }); render(); } }), 'Não aportar onde a IA discorda'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.includeAguardar, onchange: (e) => { svc.updateSettings({ includeAguardar: e.target.checked }); render(); } }), 'Incluir ativos em AGUARDAR'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.fractionalIntl, onchange: (e) => { svc.updateSettings({ fractionalIntl: e.target.checked }); render(); } }), 'Internacional fracionado')),
    h('p', { class: 'muted small', style: { 'margin-top': '10px' } }, 'Como é calculado: o aporte vai primeiro para as classes mais abaixo do alvo e, dentro de cada classe, para os ativos com recomendação COMPRAR mais abaixo do peso recomendado. Nada é vendido. Ações e FIIs em cotas inteiras.'));

  const kpis = h('div', { class: 'grid kpis' },
    kpi('Aporte', brl(plan.amount), null, 'hero'),
    kpi('Investido', brl(plan.invested), `${plan.lines.length} ativos`),
    kpi('Sobra', brl(plan.leftover), 'não fecha cota inteira'));

  const notices = plan.warnings.length || plan.sellAlerts.length ? h('div', { class: 'notice' },
    h('b', {}, 'Atenção'), h('ul', {}, plan.warnings.map((w) => h('li', {}, w)), plan.sellAlerts.map((a) => h('li', {}, `${a.message} Avalie vender (veja o relatório para a questão do IR/DARF).`)))) : null;

  const classes = card('Classes: antes → depois', h('span', { class: 'muted small' }, 'traço = alvo'),
    bars(plan.classes.map((c) => ({ label: ASSET_TYPES[c.type].short, value: c.pctAfter, target: c.target, cls: `fill-${c.type}`, text: `${pct(c.pctBefore)} → ${pct(c.pctAfter)} (+${brl(c.added, 0)})` })), { max: 1 }));

  const lines = plan.lines.length ? card('Onde colocar o dinheiro', h('span', { class: 'muted small' }, `${monthLong(state.month)}`),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Ativo', 'Classe', 'Recomendação', 'Preço', 'Comprar', 'Valor (R$)', '% do aporte'].map((x) => h('th', {}, x)))),
      h('tbody', {}, plan.lines.map((l) => h('tr', {},
        tickerCell(l.ticker, l.name),
        h('td', {}, h('span', { class: `dot type-${l.type}` }), ASSET_TYPES[l.type].short),
        h('td', {}, recBadge(l.rec), ' ', verdictBadge(l.verdict)),
        h('td', { class: 'num' }, money(l.price, l.currency)),
        h('td', { class: 'num' }, `${qtyFmt(l.qty)} ${l.fractional ? 'un.' : l.qty === 1 ? 'cota' : 'cotas'}`),
        h('td', { class: 'num' }, brl(l.amount)),
        h('td', { class: 'num' }, pct(plan.amount ? l.amount / plan.amount : 0))))),
      h('tfoot', {}, h('tr', {}, h('td', { colspan: 5 }, 'Total'), h('td', { class: 'num' }, brl(plan.invested)), h('td', { class: 'num' }, pct(plan.amount ? plan.invested / plan.amount : 0))))))) : card('Onde colocar o dinheiro', null, h('p', { class: 'muted' }, state.aporte > 0 ? 'Nenhum ativo elegível com estas regras.' : 'Informe um valor para calcular.'));

  const manualMode = (s.analysisMode ?? 'manual') === 'manual';
  const askApi = async () => {
    if (!hasKey()) { toast('Configure a chave da API do Gemini primeiro.', true); return; }
    state.busy = true; render();
    const j = job('Pedindo a opinião da IA sobre o aporte…');
    try {
      const res = await svc.reviewPlan(gemini(), state.month, plan, { onStatus: (m) => j.update(m) });
      state.review = { key: planKey, ...res };
      j.done('Opinião recebida.');
    } catch (e) { j.fail(e.message); } finally { state.busy = false; render(); }
  };
  const reviewPaste = h('textarea', { rows: 4, placeholder: 'Cole aqui a resposta do chat…' });
  const manualReview = h('div', { class: 'stack', style: { 'margin-top': '10px' } },
    h('div', { class: 'row' },
      h('button', { class: 'btn small primary', type: 'button', disabled: !plan.lines.length, onclick: async () => {
        toast(await copyText(svc.reviewPrompt(state.month, plan)) ? 'Pedido copiado. Cole no Gemini ou ChatGPT.' : 'Não consegui copiar.');
      } }, '1 · Copiar pedido'),
      CHAT_LINKS.map(([label, href]) => h('a', { class: 'btn small', href, target: '_blank', rel: 'noopener noreferrer' }, label))),
    reviewPaste,
    h('div', { class: 'row' }, h('button', { class: 'btn small primary', type: 'button', onclick: () => {
      if (!reviewPaste.value.trim()) { toast('Cole a resposta do chat primeiro.', true); return; }
      state.review = { key: planKey, text: reviewPaste.value.slice(0, 20000), sources: [] }; render();
    } }, '2 · Mostrar resposta')));

  const review = card('Opinião da IA sobre o plano',
    manualMode ? h('span', { class: 'muted small' }, 'copiar e colar') : h('button', { class: 'btn small primary', type: 'button', disabled: !plan.lines.length || state.busy, onclick: askApi }, state.review ? 'Perguntar de novo' : 'Pedir opinião'),
    state.review ? [renderPlainText(state.review.text), sourceLinks(state.review.sources)] : h('p', { class: 'muted small' }, 'A IA pesquisa o momento do mercado e comenta o plano: concentração, momento de cada ativo e ajustes sugeridos.'),
    manualMode ? manualReview : null,
    h('p', { class: 'muted small', style: { 'margin-top': '10px' } }, 'Ferramenta de apoio. Não é recomendação de investimento — a decisão final é sua.'));

  return [form, kpis, notices, h('div', { class: 'grid two' }, classes, review), lines];
}

// ---------- Configurações
async function diagnose(kind) {
  const model = svc.model || DEFAULT_MODEL;
  state.busy = true;
  state.diag = { ok: true, title: 'Testando…', lines: [] };
  render();
  try {
    const g = gemini();
    if (kind === 'models') {
      state.models = await g.listModels();
      const useful = usefulModels(state.models);
      const lines = [`Úteis para o app: ${useful.join(', ')}`];
      if (useful.includes(model)) lines.push(`O modelo atual (${model}) está disponível.`);
      else {
        const best = pickModel(state.models);
        if (best) { svc.setModel(best); lines.push(`O modelo ${model} não está disponível na sua chave — passei a usar ${best}.`); }
      }
      state.diag = { ok: true, title: `${useful.length} modelos disponíveis para a sua chave`, lines };
    } else if (kind === 'conn') {
      const res = await g.generate({ parts: [{ text: 'Responda apenas: OK' }], temperature: 0, onRetry: (m) => { state.diag.lines = [m]; render(); } });
      state.diag = { ok: true, title: `Conexão ok com ${g.model}`, lines: [`Resposta: ${res.text.trim().slice(0, 60)}`] };
    } else {
      const res = await g.generate({ parts: [{ text: 'Qual foi a última taxa Selic definida pelo Copom e em que data? Responda em uma frase.' }], search: true, onRetry: (m) => { state.diag.lines = [m]; render(); } });
      state.diag = res.searched
        ? { ok: true, title: `Pesquisa na web funcionando (${g.model})`, lines: [`Resposta: ${res.text.trim().slice(0, 240)}`, `Buscas: ${res.queries.join(' · ') || '—'}`, `${res.sources.length} fonte(s).`] }
        : { ok: false, title: `O modelo respondeu, mas sem pesquisar na web (${g.model})`, lines: [`Resposta: ${res.text.trim().slice(0, 240)}`, 'Sem pesquisa, a análise usa só o conhecimento do modelo (pode estar desatualizado). Tente outro modelo.'] };
    }
  } catch (e) {
    state.diag = { ok: false, title: e.message, lines: e.raw && e.raw !== e.message ? [`Resposta da API: ${e.raw}`] : [] };
  } finally {
    state.busy = false;
    render();
  }
}

function renderSettings() {
  const keyInput = h('input', { type: 'password', placeholder: hasKey() ? '•••••••• (salva)' : 'Cole aqui a sua chave', autocomplete: 'off', style: { flex: '1 1 260px' } });
  const modelSelect = h('select', {}, [...new Set([svc.model || DEFAULT_MODEL, ...MODEL_OPTIONS, ...usefulModels(state.models ?? [])])].map((m) => h('option', { value: m, selected: (svc.model || DEFAULT_MODEL) === m }, m)));
  const customModel = h('input', { type: 'text', placeholder: 'ou digite outro modelo (ex.: gemini-3.8-flash)', style: { flex: '1 1 260px' } });

  const api = card('API do Gemini', null,
    h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'Crie uma chave gratuita em ', h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener noreferrer' }, 'aistudio.google.com/apikey'), '. Ela fica salva só neste navegador e não entra no backup.'),
      h('div', { class: 'row' }, keyInput,
        h('button', { class: 'btn primary', type: 'button', onclick: () => { if (!keyInput.value.trim()) return; store.apiKey = keyInput.value.trim(); toast('Chave salva.'); render(); } }, 'Salvar chave'),
        hasKey() ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { store.apiKey = ''; toast('Chave removida.'); render(); } }, 'Remover') : null),
      h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Modelo:'), modelSelect, customModel,
        h('button', { class: 'btn', type: 'button', onclick: () => { svc.setModel(customModel.value.trim() || modelSelect.value); toast('Modelo salvo.'); render(); } }, 'Usar')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', disabled: !hasKey() || state.busy, onclick: () => diagnose('conn') }, 'Testar conexão'),
        h('button', { class: 'btn', type: 'button', disabled: !hasKey() || state.busy, onclick: () => diagnose('search') }, 'Testar pesquisa na web'),
        h('button', { class: 'btn', type: 'button', disabled: !hasKey() || state.busy, onclick: () => diagnose('models') }, 'Ver modelos da minha chave')),
      state.diag ? h('div', { class: state.diag.ok ? 'notice ok' : 'notice' }, h('b', {}, state.diag.title), state.diag.lines.map((l) => h('div', { class: 'small' }, l))) : null,
      h('p', { class: 'muted small' }, 'Recomendado: gemini-flash-latest (sempre o Flash mais novo). Pro lê tabelas e raciocina melhor, mas tem limites menores. No plano gratuito os limites por minuto e por dia são baixos — se a análise parar por cota, use "Continuar de onde parou" mais tarde, troque o modelo ou ative o faturamento no AI Studio.')));

  const data = card('Dados', null,
    h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'Tudo fica no localStorage deste navegador. Para levar para outro aparelho, exporte o backup e restaure lá.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: () => {
          const blob = new Blob([svc.exportBackup()], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: `carteira-ia-backup-${new Date().toISOString().slice(0, 10)}.json` });
          a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        } }, 'Exportar backup'),
        h('button', { class: 'btn', type: 'button', onclick: () => {
          const input = h('input', { type: 'file', accept: '.json,application/json' });
          input.addEventListener('change', async () => {
            try { svc.restoreBackup(await input.files[0].text()); toast('Backup restaurado.'); render(); } catch (e) { toast(`Backup inválido: ${e.message}`, true); }
          });
          input.click();
        } }, 'Restaurar backup'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { if (confirm('Apagar relatórios, análises e carteira deste navegador?')) { svc.clearAll(); toast('Dados apagados.'); render(); } } }, 'Apagar tudo')),
      h('p', { class: 'muted small' }, 'Também dá para subir um relatório já extraído em .json (mesmo formato do "Corrigir dados", com "type" e "month") pelo botão Subir relatórios.')));

  return [api, data];
}

// ---------- diálogos
function openTextDialog({ title, hint, value, onSave, replaceOption = false }) {
  const dlg = $('#textDialog');
  $('#textDialogTitle').textContent = title;
  $('#textDialogHint').textContent = hint;
  $('#textDialogInput').value = value;
  $('#textDialogReplaceWrap').hidden = !replaceOption;
  $('#textDialogReplace').checked = false;
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    try { onSave($('#textDialogInput').value, $('#textDialogReplace').checked); } catch (e) { toast(e.message, true); }
  };
  dlg.returnValue = '';
  dlg.showModal();
}

// ---------- upload
let pending = [];
function openUpload(files) {
  pending = [...files].map((file) => {
    const isJson = /\.json$/i.test(file.name) || file.type === 'application/json';
    return { file, isJson, type: detectType(file.name) ?? 'acoes', month: detectMonth(file.name) ?? new Date().toISOString().slice(0, 7) };
  });
  const list = $('#uploadList');
  list.replaceChildren(...pending.map((p) => h('div', { class: 'upload-item' },
    h('span', { title: p.file.name }, `${p.isJson ? '🧾' : '📄'} ${p.file.name} (${(p.file.size / 1e6).toFixed(1)} MB)`),
    p.isJson ? h('span', { class: 'muted small' }, 'tipo e mês no JSON') : h('select', { 'aria-label': 'Tipo', onchange: (e) => { p.type = e.target.value; } }, TYPE_IDS.map((t) => h('option', { value: t, selected: p.type === t }, ASSET_TYPES[t].label))),
    p.isJson ? h('span') : h('input', { type: 'month', value: p.month, 'aria-label': 'Mês', onchange: (e) => { p.month = e.target.value; } }))));
  const needsKey = pending.some((p) => !p.isJson) && !hasKey();
  $('#uploadKeyNotice').hidden = !needsKey;
  $('#uploadConfirm').textContent = pending.every((p) => p.isJson) ? 'Importar' : 'Ler com IA';
  $('#uploadDialog').returnValue = '';
  $('#uploadDialog').showModal();
}

$('#uploadDialog').addEventListener('close', async () => {
  if ($('#uploadDialog').returnValue !== 'ok') return;
  const items = pending; pending = [];
  if (items.some((p) => !p.isJson) && !hasKey()) { toast('Configure a chave da API do Gemini para ler PDFs.', true); setTab('settings'); return; }
  const { pdfToImages } = items.some((p) => !p.isJson) ? await import('./core/pdf.js') : {};
  let lastMonth = null; let lastType = null;
  await Promise.all(items.map(async (p) => {
    if (p.isJson) {
      try {
        const res = svc.importReportJson(JSON.parse(await p.file.text()), { filename: p.file.name });
        const last = svc.report(res.at(-1).id); lastMonth = last.month; lastType = last.type;
        toast(`${p.file.name}: ${res.length} relatório(s) importado(s).`);
      } catch (e) { toast(`${p.file.name}: ${e.message}`, true); }
      return;
    }
    const label = `${ASSET_TYPES[p.type].label} · ${monthLong(p.month)}`;
    const j = job(`${label}: preparando o PDF…`);
    const t0 = Date.now();
    const read = async (maxPages) => {
      const { images, pages } = await pdfToImages(p.file, { maxPages, onPage: (n, total) => j.update(`${label}: convertendo página ${n}/${total}`, (n / total) * 0.3) });
      j.update(`${label}: a IA está lendo ${images.length} de ${pages} páginas…`, 0.4);
      return svc.extractReport(gemini(), { images, pagesTotal: pages, type: p.type, month: p.month, filename: p.file.name, onStatus: (m) => j.update(`${label}: ${m}`) });
    };
    try {
      let res;
      const full = $('#uploadFull').checked;
      try {
        res = await read(full ? undefined : FAST_PAGES);
      } catch (e) {
        if (full || !/Nenhum ativo/.test(e.message)) throw e;
        res = null;
      }
      // Leitura rápida não achou a tabela (ou os pesos não fecham): lê o PDF inteiro.
      if (!full && (!res || !checkReport(res.report)[0].ok)) {
        j.update(`${label}: a tabela não fechou nas primeiras páginas — lendo o PDF inteiro…`, 0.5);
        res = await read(undefined);
      }
      const bad = checkReport(res.report).filter((c) => !c.ok).length;
      j.done(`${label}: ${res.report.assets.length} ativos em ${Math.round((Date.now() - t0) / 1000)} s${bad ? ` · ${bad} ponto(s) para conferir` : ' · conferência ok'}${res.replaced ? ' (substituiu o anterior)' : ''}.`);
      lastMonth = p.month; lastType = p.type;
    } catch (e) {
      j.fail(`${label}: ${e.message}`);
    }
    render();
  }));
  if (lastMonth) { state.month = lastMonth; state.type = lastType; }
  if (state.tab !== 'reports') setTab('reports'); else render();
});

$('#uploadBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => { if (e.target.files.length) openUpload(e.target.files); e.target.value = ''; });
$('#monthSelect').addEventListener('change', (e) => { state.month = e.target.value; state.expanded.clear(); render(); });
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));

// Arrastar e soltar PDFs em qualquer lugar da página.
document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /\.(pdf|json)$/i.test(f.name));
  if (!files.length) return;
  e.preventDefault();
  openUpload(files);
});

render();
