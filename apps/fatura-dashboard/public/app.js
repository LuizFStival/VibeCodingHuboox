// Front-end sem build: ES modules + SVG/CSS puros. Todo texto vindo dos dados
// entra via textContent (helper h), nunca innerHTML — descrição de fatura é dado externo.
// Não há servidor: a lógica (core/) roda aqui e os dados ficam no localStorage.

import { createService } from './core/service.js';
import { createStore, memoryStorage } from './core/store.js';
import { BANKS, getBank, detectBank } from './core/banks/index.js';

let persistent = true;
let storage;
try {
  storage = window.localStorage;
  storage.getItem('probe');
} catch {
  storage = memoryStorage();
  persistent = false;
}
const svc = createService(createStore(storage));

// ---------- utilidades ----------
const $ = (sel) => document.querySelector(sel);
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const brl = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const brlShort = (cents) => {
  const v = cents / 100;
  return v >= 1000 ? `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : `R$ ${Math.round(v)}`;
};
const pct = (x, digits = 0) => `${(x * 100).toLocaleString('pt-BR', { maximumFractionDigits: digits })}%`;
const monthLabel = (m) => { const [y, mm] = m.split('-'); return `${MONTHS[+mm - 1]}/${y}`; };
const monthLong = (m) => {
  const [y, mm] = m.split('-');
  const name = new Date(Date.UTC(+y, +mm - 1, 15)).toLocaleString('pt-BR', { month: 'long', timeZone: 'UTC' });
  return `${name[0].toUpperCase()}${name.slice(1)} ${y}`;
};
const dateLabel = (d) => { const [, m, dd] = d.split('-'); return `${dd}/${m}`; };
const weekday = (d) => new Date(`${d}T12:00:00`).toLocaleString('pt-BR', { weekday: 'short' }).replace('.', '');
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function h(tag, attrs = {}, ...children) {
  const el = document.createElementNS(
    ['svg', 'rect', 'line', 'text', 'g', 'path'].includes(tag) ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Marca simplificada do banco (SVG). Bancos "em breve" aparecem em cinza via CSS. */
function bankLogo(id, size = 28) {
  const svg = h('svg', { viewBox: '0 0 32 32', width: size, height: size, class: 'bank-logo', 'aria-hidden': 'true' });
  if (id === 'nubank') {
    svg.append(h('rect', { width: 32, height: 32, rx: 8, fill: '#820ad1' }),
      h('text', { x: 16, y: 21.5, 'text-anchor': 'middle', fill: '#fff', 'font-size': 15, 'font-weight': 700, 'font-family': 'system-ui, sans-serif' }, 'nu'));
  } else if (id === 'bb') {
    svg.append(h('rect', { width: 32, height: 32, rx: 8, fill: '#fcd116' }),
      h('text', { x: 16, y: 21.5, 'text-anchor': 'middle', fill: '#0038a8', 'font-size': 13, 'font-weight': 800, 'font-family': 'system-ui, sans-serif' }, 'BB'));
  } else {
    svg.append(h('rect', { width: 32, height: 32, rx: 8, fill: '#76756f' }));
  }
  return svg;
}

const bankName = (id) => { try { return getBank(id).name; } catch { return id; } };

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3500);
}

const tip = $('#tooltip');
function showTip(evt, lines) {
  tip.replaceChildren(...lines.map((l, i) => (i === 0 ? h('b', {}, l) : h('div', {}, l))));
  tip.hidden = false;
  const pad = 14;
  const { innerWidth: w } = window;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(evt.clientX + pad, w - r.width - 8)}px`;
  tip.style.top = `${Math.max(8, evt.clientY - r.height - pad)}px`;
}
const hideTip = () => { tip.hidden = true; };
const withTip = (linesFn) => ({ onmousemove: (e) => showTip(e, linesFn()), onmouseleave: hideTip });

// ---------- estado ----------
const state = {
  tab: 'overview',
  months: [],
  month: null,
  dash: null,
  categories: [],
  history: null,
  allTx: null,
  filters: { q: '', category: '', type: '', date: '', scope: 'month', sort: 'date', dir: -1 },
  applyToMerchant: true,
};

// ---------- gráficos ----------
/** Barras horizontais ranqueadas (uma cor só: o trabalho é comparar magnitude). */
function rankBars(items, { label, value, extra, tipLines, onClick }) {
  const max = Math.max(1, ...items.map(value));
  return h('div', { class: 'rank' }, items.map((it) => h('button', {
    class: 'rank-row', type: 'button', onclick: onClick ? () => onClick(it) : null, ...withTip(() => tipLines(it)),
  },
  h('span', { class: 'rank-label' }, label(it)),
  h('span', { class: 'rank-track' }, h('span', { class: 'rank-fill', style: { width: `${(value(it) / max) * 100}%`, display: 'block' } })),
  h('span', { class: 'rank-value' }, brl(value(it)), extra ? h('span', { class: 'muted' }, extra(it)) : null))));
}

/** Colunas verticais em SVG com linha de referência opcional (ex.: média). */
function columnChart(data, opts) {
  // Desenha na largura real do contêiner (sem esticar texto) e redesenha ao redimensionar.
  const wrap = h('div', { class: 'table-wrap' });
  let lastW = 0;
  const draw = () => {
    const W = Math.max(data.length * 28, wrap.clientWidth || 600);
    if (W === lastW) return;
    lastW = W;
    wrap.replaceChildren(drawColumns(data, opts, W));
  };
  new ResizeObserver(draw).observe(wrap);
  return wrap;
}

function drawColumns(data, { key, value, xLabel, tipLines, onClick, ref, activeKey, height = 200, showValues = false }, W) {
  const H = height;
  const m = { t: showValues ? 18 : 8, r: 8, b: 26, l: 8 };
  const max = Math.max(1, ...data.map(value), ref?.value ?? 0) * 1.08;
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const step = iw / Math.max(1, data.length);
  const bw = Math.max(4, Math.min(36, step * 0.62));
  const y = (v) => m.t + ih - (v / max) * ih;
  const labelEvery = Math.ceil(data.length / Math.max(2, Math.floor(W / 64)));

  const svg = h('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' });
  svg.append(h('line', { class: 'grid-line', x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih }));
  data.forEach((d, i) => {
    const cx = m.l + step * i + step / 2;
    const v = value(d);
    const top = y(v);
    const bh = Math.max(1, m.t + ih - top);
    const r = Math.min(4, bw / 2, bh);
    // Topo arredondado 4px, base reta no eixo.
    const path = `M${cx - bw / 2},${m.t + ih} V${top + r} Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top} H${cx + bw / 2 - r} Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r} V${m.t + ih} Z`;
    const g = h('g', { ...withTip(() => tipLines(d)), onclick: onClick ? () => onClick(d) : null, style: onClick ? { cursor: 'pointer' } : null });
    g.append(h('rect', { class: 'hit', x: cx - step / 2, y: m.t, width: step, height: ih }));
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    bar.setAttribute('d', path);
    bar.setAttribute('class', `bar${activeKey && key(d) === activeKey ? ' active' : ''}`);
    g.append(bar);
    if (showValues && step >= 46) g.append(h('text', { class: 'value-label', x: cx, y: top - 5, 'text-anchor': 'middle' }, brlShort(v)));
    if (i % labelEvery === 0) g.append(h('text', { class: 'axis-label', x: cx, y: H - 8, 'text-anchor': 'middle' }, xLabel(d)));
    svg.append(g);
  });
  if (ref) {
    const ry = y(ref.value);
    svg.append(h('line', { class: 'ref-line', x1: m.l, x2: W - m.r, y1: ry, y2: ry }));
    svg.append(h('text', { class: 'ref-label', x: W - m.r, y: ry - 5, 'text-anchor': 'end' }, ref.label));
  }
  return svg;
}

// ---------- componentes ----------
const card = (title, right, ...body) => h('div', { class: 'card' },
  h('div', { class: 'card-head' }, h('h2', {}, title), right ?? null), ...body);

const kpi = (label, value, hint, cls = '') => h('div', { class: `card kpi ${cls}` },
  h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), hint ? h('div', { class: 'hint' }, hint) : null);

function deltaSpan(deltaCents, deltaPct) {
  if (deltaCents === 0) return h('span', {}, 'igual ao mês anterior');
  const up = deltaCents > 0;
  return h('span', { class: up ? 'delta-up' : 'delta-down' },
    `${up ? '▲' : '▼'} ${brl(Math.abs(deltaCents))}${deltaPct !== null && deltaPct !== undefined ? ` (${pct(Math.abs(deltaPct), 1)})` : ''}`);
}

function goToTransactions(filters) {
  Object.assign(state.filters, { q: '', category: '', type: '', date: '', scope: 'month' }, filters);
  setTab('transactions');
}

// ---------- abas ----------
function renderOverview() {
  const d = state.dash;
  const s = d.summary;
  const inst = d.installments;
  const cmp = d.comparison;
  const top = d.categories[0];

  const insights = [];
  if (top) insights.push(h('li', {}, 'Maior categoria: ', h('b', {}, top.category), ` — ${brl(top.totalCents)} (${pct(top.share)} da fatura).`));
  if (inst.count) insights.push(h('li', {}, 'Parcelas respondem por ', h('b', {}, pct(s.installmentsShare)), ` da fatura (${brl(inst.thisMonthCents)}). Já há `, h('b', {}, brl(inst.futureCommittedCents)), ' comprometidos nas próximas faturas.'));
  if (inst.projection[0]) insights.push(h('li', {}, 'A próxima fatura já começa com ', h('b', {}, brl(inst.projection[0].totalCents)), ` em parcelas (${monthLabel(inst.projection[0].month)}).`));
  if (cmp) {
    const movers = d.categories.filter((c) => c.deltaCents > 0).sort((a, b) => b.deltaCents - a.deltaCents).slice(0, 2);
    if (movers.length) insights.push(h('li', {}, 'Maiores altas vs. mês anterior: ', ...movers.flatMap((c, i) => [i ? ', ' : '', h('b', {}, c.category), ` (+${brl(c.deltaCents)})`]), '.'));
  }
  const smalls = d.transactions.filter((t) => t.kind === 'expense' && t.amountCents < 3000);
  if (smalls.length >= 5) insights.push(h('li', {}, `${smalls.length} compras abaixo de R$ 30 somam `, h('b', {}, brl(smalls.reduce((a, t) => a + t.amountCents, 0))), ' — os pequenos gastos que passam despercebidos.'));
  const outros = d.categories.find((c) => c.category === 'Outros');
  if (outros) insights.push(h('li', {}, h('b', {}, `${outros.count} lançamento(s)`), ' ficaram em "Outros". Corrija na aba Lançamentos — a categoria fica salva para as próximas faturas.'));

  $('#tab-overview').replaceChildren(
    h('div', { class: 'grid kpis' },
      kpi('Total da fatura', brl(s.totalCents), cmp ? h('span', {}, deltaSpan(cmp.deltaCents, cmp.deltaPct), ` vs ${monthLabel(cmp.month)}`) : `${s.count} compras`, 'hero'),
      kpi('Em parcelas', brl(inst.thisMonthCents), `${pct(s.installmentsShare)} da fatura · ${inst.count} parcelas`),
      kpi('Comprometido futuro', brl(inst.futureCommittedCents), inst.projection.length ? `parcelas até ${monthLabel(inst.projection.at(-1).month)}` : 'nenhuma parcela futura'),
      kpi('Lançamentos', String(s.count), `ticket médio ${brl(s.avgTicketCents)}`),
      kpi('Maior gasto', s.largest ? brl(s.largest.amountCents) : '—', s.largest ? `${s.largest.baseTitle} · ${dateLabel(s.largest.date)}` : ''),
    ),
    insights.length ? card('Leitura rápida', null, h('ul', { class: 'insights' }, insights)) : null,
    h('div', { class: 'grid two' },
      card('Por categoria', h('span', { class: 'muted small' }, 'clique para ver os lançamentos'),
        rankBars(d.categories, {
          label: (c) => c.category,
          value: (c) => c.totalCents,
          extra: (c) => pct(c.share),
          tipLines: (c) => [c.category, `${brl(c.totalCents)} · ${c.count} lançamento(s)`, `${pct(c.share, 1)} da fatura`,
            ...(cmp ? [`Mês anterior: ${brl(c.previousCents)} (${c.deltaCents >= 0 ? '+' : '−'}${brl(Math.abs(c.deltaCents))})`] : [])],
          onClick: (c) => goToTransactions({ category: c.category }),
        })),
      card('Onde mais gastou', h('span', { class: 'muted small' }, 'top 10 estabelecimentos'),
        rankBars(d.topMerchants, {
          label: (m) => m.title,
          value: (m) => m.totalCents,
          extra: (m) => `${m.count}×`,
          tipLines: (m) => [m.title, `${brl(m.totalCents)} em ${m.count} compra(s)`, m.category],
          onClick: (m) => goToTransactions({ q: m.title }),
        })),
    ),
    card('Gastos por dia', h('span', { class: 'muted small' }, 'data da compra'),
      columnChart(d.byDay, {
        key: (x) => x.date, value: (x) => x.totalCents, xLabel: (x) => dateLabel(x.date),
        tipLines: (x) => {
          const items = d.transactions.filter((t) => t.date === x.date && t.kind === 'expense');
          return [`${weekday(x.date)} ${dateLabel(x.date)} · ${brl(x.totalCents)}`,
            ...items.slice(0, 6).map((t) => `${t.baseTitle}: ${brl(t.amountCents)}`),
            ...(items.length > 6 ? [`+ ${items.length - 6} outros`] : [])];
        },
        onClick: (x) => goToTransactions({ date: x.date }),
      })),
    d.recurring.length ? card('Gastos recorrentes', h('span', { class: 'muted small' }, 'aparecem também em faturas anteriores'),
      rankBars(d.recurring, {
        label: (r) => r.title, value: (r) => r.totalCents, extra: (r) => `${r.monthsSeen} meses`,
        tipLines: (r) => [r.title, r.category, `presente em ${r.monthsSeen} faturas`],
        onClick: (r) => goToTransactions({ q: r.title }),
      })) : null,
  );
}

function categorySelect(t) {
  const sel = h('select', { 'aria-label': `Categoria de ${t.title}`, onchange: (e) => onCategoryChange(t, e.target) },
    state.categories.map((c) => h('option', { value: c, selected: c === t.category }, c)),
    h('option', { value: '__new__' }, '+ Nova categoria…'));
  return sel;
}

async function onCategoryChange(t, sel) {
  let category = sel.value;
  if (category === '__new__') {
    category = (prompt('Nome da nova categoria:') || '').trim();
    if (!category) { sel.value = t.category; return; }
  }
  const scope = state.applyToMerchant ? 'merchant' : 'single';
  try {
    svc.updateCategory(t.id, { category, scope });
    toast(scope === 'merchant'
      ? `“${t.baseTitle}” → ${category}. Regra salva para todas as faturas, inclusive as próximas.`
      : `Só este lançamento foi para ${category}.`);
    await refreshAfterEdit();
  } catch (e) {
    toast(e.message, true);
    sel.value = t.category;
  }
}

async function refreshAfterEdit() {
  state.allTx = null;
  state.history = null;
  state.categories = svc.categories();
  state.dash = svc.dashboard(state.month);
  render();
}

function filteredTransactions(list) {
  const f = state.filters;
  const q = norm(f.q.trim());
  const out = list.filter((t) => {
    if (f.category && t.category !== f.category) return false;
    if (f.date && t.date !== f.date) return false;
    if (f.type === 'avista' && (t.kind !== 'expense' || t.installmentTotal)) return false;
    if (f.type === 'parcelado' && !t.installmentTotal) return false;
    if (f.type === 'credito' && t.kind !== 'credit') return false;
    if (q && !norm(t.title).includes(q)) return false;
    return true;
  });
  const cmp = {
    date: (a, b) => a.date.localeCompare(b.date),
    amount: (a, b) => a.amountCents - b.amountCents,
    title: (a, b) => a.title.localeCompare(b.title, 'pt-BR'),
    category: (a, b) => a.category.localeCompare(b.category, 'pt-BR'),
  }[f.sort];
  return out.sort((a, b) => cmp(a, b) * f.dir);
}

async function renderTransactions() {
  const f = state.filters;
  const all = f.scope === 'all';
  if (all && !state.allTx) state.allTx = svc.transactions();
  const source = all ? state.allTx : state.dash.transactions;
  const rows = filteredTransactions(source);
  const expenses = rows.filter((t) => t.kind === 'expense');
  const total = expenses.reduce((a, t) => a + t.amountCents, 0);
  const monthTotal = state.dash.summary.totalCents;

  const rerender = () => { renderTransactions(); };
  const sortBtn = (key, label) => h('button', {
    type: 'button',
    onclick: () => { if (f.sort === key) f.dir *= -1; else { f.sort = key; f.dir = key === 'date' || key === 'amount' ? -1 : 1; } rerender(); },
  }, label, f.sort === key ? (f.dir < 0 ? ' ↓' : ' ↑') : '');

  const search = h('input', { type: 'search', placeholder: 'Ex.: uber, posto, ifood…', value: f.q });
  search.addEventListener('input', () => { f.q = search.value; debounceRender(); });

  const catCounts = new Map();
  for (const t of source) if (t.kind === 'expense') catCounts.set(t.category, (catCounts.get(t.category) ?? 0) + 1);

  // Quebra por mês quando a busca é em todas as faturas.
  let byMonth = null;
  if (all && expenses.length) {
    const map = new Map();
    for (const t of expenses) map.set(t.month, (map.get(t.month) ?? 0) + t.amountCents);
    byMonth = [...map].sort((a, b) => a[0].localeCompare(b[0])).map(([month, totalCents]) => ({ month, totalCents }));
  }

  const panel = $('#tab-transactions');
  const hadFocus = document.activeElement?.type === 'search';
  panel.replaceChildren(
    card('Lançamentos', h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: state.applyToMerchant, onchange: (e) => { state.applyToMerchant = e.target.checked; } }),
      'Ao trocar categoria, aplicar a todas as compras do mesmo estabelecimento (e às próximas faturas)'),
    h('div', { class: 'filters' },
      h('label', {}, 'Buscar descrição', search),
      h('label', {}, 'Categoria', h('select', { onchange: (e) => { f.category = e.target.value; rerender(); } },
        h('option', { value: '' }, 'Todas'),
        [...new Set([...state.categories, ...catCounts.keys()])].filter((c) => catCounts.has(c))
          .map((c) => h('option', { value: c, selected: c === f.category }, `${c} (${catCounts.get(c)})`)))),
      h('label', {}, 'Tipo', h('select', { onchange: (e) => { f.type = e.target.value; rerender(); } },
        [['', 'Todos'], ['avista', 'À vista'], ['parcelado', 'Parcelados'], ['credito', 'Pagamentos/créditos']]
          .map(([v, l]) => h('option', { value: v, selected: v === f.type }, l)))),
      h('label', {}, 'Período', h('select', { onchange: (e) => { f.scope = e.target.value; rerender(); } },
        h('option', { value: 'month', selected: !all }, `Fatura ${monthLabel(state.month)}`),
        h('option', { value: 'all', selected: all }, 'Todas as faturas'))),
      f.date ? h('button', { class: 'btn small', type: 'button', title: 'Remover filtro de dia', onclick: () => { f.date = ''; rerender(); } }, `Dia ${dateLabel(f.date)} ✕`) : null,
      (f.q || f.category || f.type || f.date) ? h('button', { class: 'btn small', type: 'button', onclick: () => { Object.assign(f, { q: '', category: '', type: '', date: '' }); rerender(); } }, 'Limpar filtros') : null,
    ),
    h('div', { class: 'filter-total', style: { marginTop: '14px' } },
      h('span', { class: 'big' }, brl(total)),
      h('span', { class: 'muted' }, `${expenses.length} compra(s)${f.category ? ` em ${f.category}` : ''}${f.q ? ` com “${f.q}”` : ''}${f.date ? ` em ${dateLabel(f.date)}` : ''}`),
      expenses.length ? h('span', { class: 'muted' }, `média ${brl(Math.round(total / expenses.length))}`) : null,
      !all && monthTotal && (f.q || f.category || f.type || f.date) ? h('span', { class: 'muted' }, `${pct(total / monthTotal, 1)} da fatura`) : null,
    ),
    byMonth && byMonth.length > 1 ? h('div', { style: { marginTop: '12px' } }, columnChart(byMonth, {
      key: (x) => x.month, value: (x) => x.totalCents, xLabel: (x) => monthLabel(x.month), height: 140, showValues: true,
      tipLines: (x) => [monthLong(x.month), brl(x.totalCents)],
    })) : null,
    h('div', { class: 'table-wrap', style: { marginTop: '12px' } },
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, sortBtn('date', 'Data')),
          all ? h('th', {}, 'Fatura') : null,
          h('th', {}, sortBtn('title', 'Descrição')),
          h('th', {}, sortBtn('category', 'Categoria')),
          h('th', { class: 'right' }, sortBtn('amount', 'Valor')))),
        h('tbody', {}, rows.length ? rows.map((t) => h('tr', { class: t.kind === 'credit' ? 'credit' : '' },
          h('td', { class: 'num', style: { whiteSpace: 'nowrap' } }, dateLabel(t.date), h('span', { class: 'src' }, weekday(t.date))),
          all ? h('td', { class: 'small muted' }, monthLabel(t.month)) : null,
          h('td', {}, t.baseTitle, t.installmentTotal ? h('span', { class: 'badge' }, `${t.installmentCurrent}/${t.installmentTotal}`) : null),
          h('td', {}, t.kind === 'credit' ? h('span', { class: 'muted small' }, 'Pagamento/crédito')
            : [categorySelect(t), t.categorySource !== 'auto' ? h('span', { class: 'src', title: t.categorySource === 'regra' ? 'Categoria aprendida (regra do estabelecimento)' : 'Corrigido só neste lançamento' }, t.categorySource === 'regra' ? '✓ regra' : '✎ manual') : null]),
          h('td', { class: 'right num', style: { whiteSpace: 'nowrap' } }, brl(t.amountCents)),
        )) : h('tr', {}, h('td', { colspan: all ? 5 : 4, class: 'muted', style: { textAlign: 'center', padding: '24px' } }, 'Nenhum lançamento com esses filtros.'))),
      ),
    )),
  );
  if (hadFocus) {
    const s = panel.querySelector('input[type="search"]');
    s.focus();
    s.setSelectionRange(s.value.length, s.value.length);
  }
}
let debounceT;
const debounceRender = () => { clearTimeout(debounceT); debounceT = setTimeout(renderTransactions, 150); };

function renderInstallments() {
  const inst = state.dash.installments;
  $('#tab-installments').replaceChildren(
    h('div', { class: 'grid kpis' },
      kpi('Parcelas nesta fatura', brl(inst.thisMonthCents), `${pct(state.dash.summary.installmentsShare)} do total`, 'hero'),
      kpi('Compras parceladas', String(inst.count), `${inst.newPurchases} nova(s) neste mês`),
      kpi('Terminam agora', String(inst.finishingNow), 'última parcela nesta fatura'),
      kpi('Comprometido futuro', brl(inst.futureCommittedCents), 'soma das parcelas que faltam'),
    ),
    inst.projection.length ? card('Quanto das próximas faturas já está comprometido', h('span', { class: 'muted small' }, 'só parcelas já contratadas'),
      columnChart(inst.projection, {
        key: (x) => x.month, value: (x) => x.totalCents, xLabel: (x) => monthLabel(x.month), showValues: true,
        tipLines: (x) => [monthLong(x.month), `${brl(x.totalCents)} em ${x.count} parcela(s)`],
      })) : null,
    card('Compras parceladas', null, inst.items.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Compra'), h('th', {}, 'Categoria'), h('th', {}, 'Parcela'), h('th', { class: 'right' }, 'Valor parcela'),
        h('th', { class: 'right' }, 'Falta pagar'), h('th', { class: 'right' }, 'Total da compra'), h('th', {}, 'Última'))),
      h('tbody', {}, inst.items.map((i) => h('tr', {},
        h('td', {}, i.title),
        h('td', { class: 'small' }, i.category),
        h('td', {}, h('div', { style: { display: 'grid', gap: '4px' } }, h('span', { class: 'num small' }, `${i.current} de ${i.total}`),
          h('div', { class: 'progress', title: `${pct(i.current / i.total)} pago` }, h('span', { style: { width: `${(i.current / i.total) * 100}%` } })))),
        h('td', { class: 'right num' }, brl(i.amountCents)),
        h('td', { class: 'right num' }, i.remaining ? brl(i.remainingCents) : h('span', { class: 'delta-down' }, 'quitada')),
        h('td', { class: 'right num muted' }, brl(i.purchaseTotalCents)),
        h('td', { class: 'small' }, monthLabel(i.lastMonth)),
      ))))) : h('p', { class: 'muted' }, 'Nenhuma compra parcelada nesta fatura.')),
  );
}

async function renderHistory() {
  if (!state.history) state.history = svc.history();
  const hist = state.history;
  const panel = $('#tab-history');
  if (hist.months.length < 1) { panel.replaceChildren(); return; }

  const maxCell = Math.max(1, ...hist.months.flatMap((m) => Object.values(m.categories)));
  const heat = (v) => (v ? { background: `color-mix(in srgb, var(--bar) ${Math.round(8 + (v / maxCell) * 42)}%, transparent)` } : null);
  const months = hist.months;

  panel.replaceChildren(
    card('Total por fatura', h('span', { class: 'muted small' }, 'clique numa barra para abrir a fatura'),
      columnChart(months, {
        key: (x) => x.month, value: (x) => x.totalCents, xLabel: (x) => monthLabel(x.month), activeKey: state.month, showValues: true,
        ref: months.length > 1 ? { value: hist.averageCents, label: `média ${brlShort(hist.averageCents)}` } : null,
        tipLines: (x) => [monthLong(x.month), `Total ${brl(x.totalCents)}`, `Parcelas ${brl(x.installmentsCents)}`, `${x.count} compras`],
        onClick: (x) => selectMonth(x.month, 'overview'),
      })),
    card('Categorias mês a mês', h('span', { class: 'muted small' }, 'quanto mais forte, maior o gasto'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'heat' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Categoria'), months.map((m) => h('th', { class: 'right' }, monthLabel(m.month))),
          months.length > 1 ? h('th', { class: 'right' }, 'Média') : null)),
        h('tbody', {},
          hist.categories.map((c) => {
            const vals = months.map((m) => m.categories[c] ?? 0);
            return h('tr', {}, h('td', {}, c),
              vals.map((v, i) => h('td', { class: 'cell', style: heat(v), ...withTip(() => [c, monthLong(months[i].month), brl(v)]) }, v ? brl(v) : '—')),
              months.length > 1 ? h('td', { class: 'cell muted' }, brl(Math.round(vals.reduce((a, b) => a + b, 0) / vals.length))) : null);
          }),
          h('tr', { class: 'total' }, h('td', {}, 'Parcelas (incluídas acima)'), months.map((m) => h('td', { class: 'cell' }, brl(m.installmentsCents))), months.length > 1 ? h('td', {}) : null),
          h('tr', { class: 'total' }, h('td', {}, 'Total'), months.map((m) => h('td', { class: 'cell' }, brl(m.totalCents))),
            months.length > 1 ? h('td', { class: 'cell' }, brl(hist.averageCents)) : null),
        )))),
    card('Faturas importadas', null, h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Fatura'), h('th', {}, 'Banco'), h('th', {}, 'Arquivo'), h('th', { class: 'right' }, 'Total'), h('th', {}))),
      h('tbody', {}, svc.listStatements().map((s) => h('tr', {},
        h('td', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); selectMonth(s.month, 'overview'); } }, monthLong(s.month))),
        h('td', {}, h('span', { class: 'bank-inline' }, bankLogo(s.bank, 20), bankName(s.bank))),
        h('td', { class: 'small muted' }, s.filename ?? '—'),
        h('td', { class: 'right num' }, brl(s.totalCents)),
        h('td', { class: 'right' }, h('button', { class: 'btn ghost small', type: 'button', onclick: () => deleteStatement(s.bank, s.month) }, 'Excluir')),
      )))))),
  );
}

async function renderRules() {
  const rules = svc.rules();
  const input = h('input', { type: 'text', placeholder: 'Ex.: Presentes', maxlength: 40 });
  $('#tab-rules').replaceChildren(
    card('Regras aprendidas', h('span', { class: 'muted small' }, 'criadas quando você corrige uma categoria'),
      rules.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Estabelecimento'), h('th', {}, 'Categoria'), h('th', { class: 'right' }, 'Lançamentos'), h('th', {}))),
        h('tbody', {}, rules.map((r) => h('tr', {},
          h('td', {}, r.sampleTitle ?? r.merchantKey, h('div', { class: 'small muted' }, r.merchantKey)),
          h('td', {}, r.category),
          h('td', { class: 'right num' }, String(r.matches)),
          h('td', { class: 'right' }, h('button', {
            class: 'btn ghost small', type: 'button',
            onclick: async () => {
              svc.deleteRule(r.merchantKey);
              toast('Regra removida — volta a valer a categorização automática.');
              await refreshAfterEdit();
            },
          }, 'Remover')),
        ))))) : h('p', { class: 'muted' }, 'Nenhuma regra ainda. Troque a categoria de um lançamento na aba Lançamentos e ela aparece aqui.')),
    card('Categorias', null,
      h('p', { class: 'muted small', style: { marginTop: 0 } }, state.categories.join(' · ')),
      h('form', { class: 'filters', onsubmit: async (e) => {
        e.preventDefault();
        try {
          state.categories = svc.addCategory(input.value);
          toast('Categoria criada.');
          renderRules();
        } catch (err) { toast(err.message, true); }
      } }, h('label', {}, 'Nova categoria', input), h('button', { class: 'btn', type: 'submit' }, 'Adicionar'))),
    dataCard(),
  );
}

// ---------- navegação ----------
function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.id !== `tab-${tab}`;
  hideTip();
  render();
}

async function render() {
  const has = state.months.length > 0 && state.dash;
  $('#empty').hidden = !!has;
  $('.tabs').hidden = !has;
  for (const p of document.querySelectorAll('.tab-panel')) if (!has) p.hidden = true;
  if (!has) return;
  try {
    await ({ overview: renderOverview, transactions: renderTransactions, installments: renderInstallments, history: renderHistory, rules: renderRules })[state.tab]();
  } catch (e) {
    toast(e.message, true);
  }
}

function renderMonthSelect() {
  const sel = $('#monthSelect');
  sel.replaceChildren(...state.months.map((m) => h('option', { value: m.month, selected: m.month === state.month }, `${monthLong(m.month)} · ${brl(m.totalCents)}`)));
  sel.closest('.month-picker').hidden = state.months.length === 0;
}

async function selectMonth(month, tab) {
  state.month = month;
  state.dash = svc.dashboard(month);
  renderMonthSelect();
  if (tab) setTab(tab); else render();
}

async function loadMonths(preferred) {
  state.months = svc.listMonths();
  state.history = null;
  state.allTx = null;
  const target = state.months.find((m) => m.month === preferred)?.month ?? state.months[0]?.month ?? null;
  if (target) await selectMonth(target);
  else { state.month = null; state.dash = null; renderMonthSelect(); render(); }
}

async function deleteStatement(bank, month) {
  if (!confirm(`Excluir a fatura ${bankName(bank)} de ${monthLong(month)}? As regras de categoria continuam salvas.`)) return;
  svc.deleteStatement(bank, month);
  toast('Fatura excluída.');
  await loadMonths(state.month);
}

// ---------- backup ----------
function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function dataCard() {
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async () => {
    const f = fileIn.files[0];
    fileIn.value = '';
    if (!f) return;
    if (!confirm('Restaurar este backup? Os dados atuais deste navegador serão substituídos.')) return;
    try {
      svc.importBackup(JSON.parse(await f.text()));
      state.categories = svc.categories();
      toast('Backup restaurado.');
      await loadMonths();
    } catch (e) { toast(`Backup inválido: ${e.message}`, true); }
  } });
  return card('Seus dados', null,
    h('p', { class: 'muted small', style: { marginTop: 0 } },
      'Tudo fica salvo só neste navegador — nada é enviado para servidor. Para levar para outro dispositivo ou guardar uma cópia, exporte o backup e restaure do outro lado.'),
    persistent ? null : h('p', { class: 'notice' }, 'Este navegador está bloqueando o armazenamento local: os dados somem ao fechar a aba. Exporte o backup antes de sair.'),
    h('div', { class: 'filters' },
      h('button', { class: 'btn', type: 'button', onclick: () => {
        download(`fatura-dashboard-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(svc.exportBackup(), null, 1));
      } }, 'Exportar backup (.json)'),
      h('button', { class: 'btn', type: 'button', onclick: () => fileIn.click() }, 'Restaurar backup'),
      fileIn));
}

// ---------- upload ----------
/** Cartões de banco: ativos selecionáveis, "em breve" em cinza e desabilitados. */
function bankCards({ name, selected, onChange }) {
  return h('div', { class: 'bank-picker', role: 'radiogroup', 'aria-label': 'Banco' }, BANKS.map((b) => {
    const soon = b.status !== 'active';
    return h('label', { class: `bank-card${soon ? ' soon' : ''}`, title: b.help },
      name ? h('input', { type: 'radio', name, value: b.id, checked: b.id === selected, disabled: soon, onchange: () => onChange(b.id) }) : null,
      bankLogo(b.id, 32),
      h('span', { class: 'bank-text' }, h('b', {}, b.name), h('span', { class: 'small muted' }, soon ? 'Em breve' : 'Disponível')));
  }));
}

async function openUpload(files) {
  const texts = await Promise.all(files.map((f) => f.text()));
  let bank = detectBank(texts[0], files[0].name).id;
  const list = $('#uploadList');
  const inputs = files.map((f) => {
    const inp = h('input', { type: 'month', required: true, 'aria-label': `Mês de ${f.name}` });
    list.append(h('div', { class: 'upload-item' }, h('span', { title: f.name }, f.name), inp));
    return inp;
  });
  const fillMonths = () => files.forEach((f, i) => { inputs[i].value = getBank(bank).monthFromFilename(f.name) ?? ''; });
  fillMonths();
  $('#bankPicker').replaceChildren(bankCards({ name: 'bank', selected: bank, onChange: (id) => { bank = id; fillMonths(); } }));

  const dlg = $('#uploadDialog');
  dlg.onclose = async () => {
    list.replaceChildren();
    if (dlg.returnValue !== 'ok') return;
    let last = null;
    for (const [i, f] of files.entries()) {
      const month = inputs[i].value;
      try {
        if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('mês não informado');
        const r = svc.importCsv({ text: texts[i], filename: f.name, month, bank });
        last = r.month;
        toast(`${bankName(r.bank)} · ${monthLong(r.month)}: ${r.count} lançamentos ${r.replaced ? 'atualizados' : 'importados'}${r.warnings.length ? ` (${r.warnings.length} linha(s) ignoradas)` : ''}.`);
      } catch (e) {
        toast(`${f.name}: ${e.message}`, true);
      }
    }
    if (last) { await loadMonths(last); setTab('overview'); }
  };
  dlg.showModal();
}

// ---------- boot ----------
function bind() {
  const fileInput = $('#fileInput');
  const pick = () => fileInput.click();
  $('#uploadBtn').addEventListener('click', pick);
  document.querySelector('[data-action="upload"]').addEventListener('click', pick);
  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (files.length) openUpload(files);
  });
  $('#monthSelect').addEventListener('change', (e) => selectMonth(e.target.value));
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));
  // Arrastar e soltar CSV em qualquer lugar da página.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /\.csv$/i.test(f.name));
    if (files.length) openUpload(files);
  });
}

bind();
$('#emptyBanks').replaceChildren(bankCards({}));
state.categories = svc.categories();
loadMonths().catch((e) => toast(e.message, true));
