// Prompts e formatos de resposta usados com o Gemini, e a normalização das respostas.
// Tudo que volta da IA é tratado como dado não confiável: normalizado, cortado e
// exibido sempre como texto.

import { ASSET_TYPES, normalizeRec, normalizeTicker, parseNumber, upside } from './report.js';
import { rankingText, GROUPS } from './ranking.js';

// ---------------------------------------------------------------- extração do PDF

const S = (type, extra = {}) => ({ type, ...extra });

export const EXTRACTION_SCHEMA = S('OBJECT', {
  properties: {
    provider: S('STRING', { description: 'Casa de análise / nome da carteira (ex.: Orion)' }),
    title: S('STRING'),
    summary: S('STRING', { description: 'Resumo em 3 a 6 frases do contexto e da mensagem principal do mês, em português' }),
    macroHighlights: S('ARRAY', { items: S('STRING'), description: 'Indicadores e fatos macro citados (Selic, IPCA, Fed, câmbio, eleição...)' }),
    changes: S('ARRAY', {
      description: 'Mudanças na carteira neste mês: entradas, saídas, mudança de recomendação ou de peso',
      items: S('OBJECT', {
        properties: { ticker: S('STRING'), action: S('STRING', { description: 'ex.: Venda, Entrada, Compra → Aguardar, Atingiu preço teto' }), reason: S('STRING') },
        required: ['ticker', 'action'],
      }),
    }),
    assets: S('ARRAY', {
      description: 'TODAS as linhas da tabela "Carteira em detalhes", inclusive as com recomendação de venda',
      items: S('OBJECT', {
        properties: {
          ticker: S('STRING', { description: 'Código sem prefixo de bolsa (ex.: ITUB3, HGLG11, VOO)' }),
          name: S('STRING'),
          segment: S('STRING'),
          allocationPct: S('NUMBER', { description: 'Peso na carteira em %, ex.: 12 para 12%' }),
          strategy: S('STRING'),
          dividendYieldPct: S('NUMBER', { nullable: true, description: 'DY em %, null se "*" ou ausente' }),
          price: S('NUMBER', { nullable: true, description: 'Preço atual na moeda do ativo' }),
          ceilingPrice: S('NUMBER', { nullable: true, description: 'Preço teto / preço justo' }),
          pvp: S('NUMBER', { nullable: true }),
          recommendation: S('STRING', { enum: ['COMPRAR', 'AGUARDAR', 'MANTER', 'VENDER'] }),
          thesis: S('STRING', { description: 'Resumo da tese/descrição do ativo no relatório (2 a 4 frases), se houver' }),
          page: S('NUMBER', { description: 'Número da página (rótulo "Página N") onde está a linha deste ativo na tabela' }),
        },
        required: ['ticker', 'allocationPct', 'recommendation'],
      }),
    }),
    tablePages: S('ARRAY', { items: S('NUMBER'), description: 'Números das páginas onde está a tabela "Carteira em detalhes"' }),
    performance: S('OBJECT', {
      properties: {
        period: S('STRING', { description: 'Período da análise de rentabilidade' }),
        items: S('ARRAY', {
          description: 'Retorno acumulado no período: carteira e cada benchmark (IBOV, IFIX, CDI, IVVB11...)',
          items: S('OBJECT', { properties: { name: S('STRING'), returnPct: S('NUMBER') }, required: ['name', 'returnPct'] }),
        }),
      },
    }),
  },
  required: ['summary', 'assets'],
});

export function extractionPrompt(type, { withThesis = true } = {}) {
  const t = ASSET_TYPES[type];
  return [
    `Você recebe as páginas (imagens) de um relatório mensal de carteira recomendada de ${t.label}.`,
    'Extraia os dados exatamente como aparecem, principalmente a tabela "Carteira em detalhes" (ticker, empresa, segmento, alocação, estratégia, DY, P/VP, preço, preço teto/justo, recomendação).',
    'Regras:',
    '- Percentuais como número em %: "12,00%" → 12. Preços como número: "R$ 53,15" → 53.15, "US$ 707,54" → 707.54.',
    '- Recomendação: COMPRAR, AGUARDAR, MANTER ou VENDER, conforme o selo da tabela.',
    '- Inclua ativos com recomendação de venda (peso 0) e cite-os em "changes".',
    withThesis
      ? '- Para a tese de cada ativo, use as páginas de descrição do próprio relatório; resuma em português.'
      : '- Deixe "thesis" vazio (estas são só as primeiras páginas) e seja direto: o resumo do mês em até 5 frases.',
    '- Ignore marcas d\'água e qualquer dado pessoal (nome, e-mail, CPF de assinante). Nunca os reproduza.',
    '- Cada imagem vem depois de um rótulo "Página N". Informe em "page" a página onde achou cada ativo e em "tablePages" as páginas da tabela.',
    '- Não invente valores: se não estiver no relatório, use null. Copie os números exatamente como estão na tabela.',
  ].join('\n');
}

/** Pedido para ler o PDF num chat (Gemini/ChatGPT do site) quando a API não está disponível. */
export function manualExtractionPrompt(type) {
  return [
    extractionPrompt(type, { withThesis: true }),
    '',
    'O PDF está anexado nesta conversa. Leia TODAS as páginas.',
    'Responda com UM ÚNICO bloco de código JSON (sem texto fora dele) neste formato:',
    JSON.stringify({
      provider: 'nome da casa/carteira', title: 'título do relatório', summary: 'resumo do mês em 3 a 6 frases',
      macroHighlights: ['Selic ...'], changes: [{ ticker: 'XXXX3', action: 'Venda', reason: '...' }],
      tablePages: [4],
      assets: [{ ticker: 'XXXX3', name: '...', segment: '...', allocationPct: 12, strategy: '...', dividendYieldPct: 6.5, price: 53.15, ceilingPrice: 52.48, pvp: null, recommendation: 'COMPRAR | AGUARDAR | MANTER | VENDER', thesis: '...', page: 4 }],
      performance: { period: '...', items: [{ name: 'Carteira', returnPct: 110.46 }] },
    }),
  ].join('\n');
}

// ---------------------------------------------------------------- análise com pesquisa

const FOCUS = {
  acoes: 'DRE dos últimos trimestres (receita líquida, EBITDA, lucro líquido, margens e crescimento ano a ano), ROE, dívida líquida/EBITDA, P/L, P/VP, dividend yield, guidance, fatos relevantes e notícias recentes (incluindo efeitos de eleição, juros e commodities).',
  fiis: 'P/VP atual, dividend yield 12 meses e último rendimento por cota, vacância física e financeira, inadimplência, alavancagem/LTV, emissões de cotas em andamento, indexadores e qualidade de crédito (para fundos de papel), liquidez diária, fatos relevantes e notícias recentes.',
  internacional: 'Para ações e REITs: último resultado trimestral (receita, EPS vs. consenso), guidance, dividendos, valuation. Para ETFs: índice replicado, taxa de administração, fluxo e valuation do índice. Para ouro, cobre e cripto: principais vetores macro. Considere juros americanos e o câmbio (dólar/real).',
};

export const VERDICTS = { CONCORDA: 'Concorda', PARCIAL: 'Concorda em parte', DISCORDA: 'Discorda' };

export function analysisPrompt(report, assets, today) {
  const t = ASSET_TYPES[report.type];
  const rows = assets.map((a) => ({
    ticker: a.ticker, nome: a.name, segmento: a.segment, peso: +(a.weight * 100).toFixed(2),
    recomendacao: a.rec, preco: a.price, precoTeto: a.ceiling, dy: a.dy === null ? null : +(a.dy * 100).toFixed(2),
    upside: upside(a) === null ? null : +(upside(a) * 100).toFixed(1), tese: a.thesis || undefined,
  }));
  return [
    `Hoje é ${today}. Você é um analista independente de investimentos (${t.label}) e vai revisar a carteira recomendada de ${report.provider || 'uma casa de análise'} referente a ${report.month}.`,
    report.summary ? `Contexto do relatório: ${report.summary}` : '',
    `Ativos a analisar (dados do relatório, preços em ${t.currency}):`,
    JSON.stringify(rows),
    '',
    `Pesquise na web informações ATUAIS de cada ativo: ${FOCUS[report.type]}`,
    'Para cada ativo, diga se concorda com a recomendação do relatório e por quê. Seja objetivo, use números e cite datas.',
    'Responda SOMENTE com um JSON válido, sem texto fora dele, neste formato:',
    JSON.stringify({
      visaoGeral: 'parágrafo curto sobre o cenário atual para esta classe de ativos',
      ativos: [{
        ticker: 'XXXX3',
        veredito: 'CONCORDA | PARCIAL | DISCORDA',
        recomendacaoIA: 'COMPRAR | AGUARDAR | MANTER | VENDER',
        precoAtual: 0,
        resumo: '2 a 4 frases com a sua leitura',
        fundamentos: ['indicador: valor (período)'],
        noticias: [{ titulo: '...', data: 'AAAA-MM-DD', impacto: 'positivo | negativo | neutro' }],
        riscos: ['...'],
        confianca: 'alta | media | baixa',
      }],
    }),
  ].filter(Boolean).join('\n');
}

/**
 * Versão para colar no Gemini/ChatGPT do site (que pesquisam na web de graça).
 * Pede respostas curtas (chats cortam respostas longas) e as fontes de cada ativo.
 */
export function manualAnalysisPrompt(report, assets, today) {
  const t = ASSET_TYPES[report.type];
  const rows = assets.map((a) => ({
    ticker: a.ticker, nome: a.name, peso: +(a.weight * 100).toFixed(2), recomendacao: a.rec,
    preco: a.price, precoTeto: a.ceiling, dy: a.dy === null ? null : +(a.dy * 100).toFixed(2),
  }));
  return [
    `Hoje é ${today}. Aja como analista independente de investimentos (${t.label}). Revise a carteira recomendada de ${report.provider || 'uma casa de análise'} de ${report.month}.`,
    report.summary ? `Contexto do relatório: ${report.summary}` : '',
    `Ativos (dados do relatório, preços em ${t.currency}):`,
    JSON.stringify(rows),
    '',
    `PESQUISE NA WEB dados atuais de CADA ativo: ${FOCUS[report.type]}`,
    'Para cada ativo diga se concorda com a recomendação do relatório e por quê, com números e datas.',
    'Seja breve para caber tudo: no máximo 3 fundamentos, 2 notícias e 2 riscos por ativo.',
    `Responda com UM ÚNICO bloco de código JSON (sem texto fora dele), com os ${assets.length} ativos, neste formato:`,
    JSON.stringify({
      visaoGeral: 'parágrafo curto sobre o cenário atual',
      ativos: [{
        ticker: 'TICKER', veredito: 'CONCORDA | PARCIAL | DISCORDA', recomendacaoIA: 'COMPRAR | AGUARDAR | MANTER | VENDER',
        precoAtual: 0, resumo: '2 a 3 frases', fundamentos: ['indicador: valor (período)'],
        noticias: [{ titulo: '...', data: 'AAAA-MM-DD', impacto: 'positivo | negativo | neutro' }],
        riscos: ['...'], confianca: 'alta | media | baixa', fontes: ['https://...'],
      }],
    }),
  ].filter(Boolean).join('\n');
}

// Mesmo formato do analysisPrompt, como schema — usado quando a resposta com pesquisa
// vem em texto livre e precisa ser estruturada numa segunda chamada (sem pesquisa).
export const ANALYSIS_SCHEMA = S('OBJECT', {
  properties: {
    visaoGeral: S('STRING'),
    ativos: S('ARRAY', {
      items: S('OBJECT', {
        properties: {
          ticker: S('STRING'),
          veredito: S('STRING', { enum: ['CONCORDA', 'PARCIAL', 'DISCORDA'] }),
          recomendacaoIA: S('STRING', { enum: ['COMPRAR', 'AGUARDAR', 'MANTER', 'VENDER'] }),
          precoAtual: S('NUMBER', { nullable: true }),
          resumo: S('STRING'),
          fundamentos: S('ARRAY', { items: S('STRING') }),
          noticias: S('ARRAY', { items: S('OBJECT', { properties: { titulo: S('STRING'), data: S('STRING'), impacto: S('STRING', { enum: ['positivo', 'negativo', 'neutro'] }) }, required: ['titulo'] }) }),
          riscos: S('ARRAY', { items: S('STRING') }),
          confianca: S('STRING', { enum: ['alta', 'media', 'baixa'] }),
        },
        required: ['ticker', 'veredito', 'resumo'],
      }),
    }),
  },
  required: ['ativos'],
});

export function structurePrompt(text, tickers) {
  return [
    `Abaixo está uma análise de investimentos sobre ${tickers.join(', ')}. Converta-a para o formato JSON pedido, sem inventar nada:`,
    'use apenas informações do texto; se faltar algo, deixe a lista vazia ou null. Inclua um item para cada ticker citado.',
    '---',
    String(text).slice(0, 30000),
  ].join('\n');
}

const safeHttpUrl = (u) => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const str = (v, max = 600) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

export function normalizeVerdict(v) {
  const s = str(v).toUpperCase();
  if (s.startsWith('DISC')) return 'DISCORDA';
  if (s.startsWith('PARC') || s.includes('PARTE')) return 'PARCIAL';
  return 'CONCORDA';
}

/** Normaliza a resposta de analysisPrompt, mantendo só os tickers pedidos. */
export function normalizeAnalysis(raw, tickers, sources = []) {
  const wanted = new Set(tickers);
  const items = {};
  for (const a of arr(raw?.ativos, 60)) {
    const ticker = normalizeTicker(a?.ticker);
    if (!wanted.has(ticker)) continue;
    const conf = str(a.confianca, 10).toLowerCase();
    items[ticker] = {
      ticker,
      verdict: normalizeVerdict(a.veredito),
      aiRec: normalizeRec(a.recomendacaoIA),
      price: parseNumber(a.precoAtual) || null,
      summary: str(a.resumo, 1200),
      fundamentals: arr(a.fundamentos, 12).map((x) => str(x, 240)).filter(Boolean),
      news: arr(a.noticias, 6).map((n) => ({
        title: str(n?.titulo ?? n, 240),
        date: str(n?.data, 20),
        impact: /pos/i.test(n?.impacto) ? 'positivo' : /neg/i.test(n?.impacto) ? 'negativo' : 'neutro',
      })).filter((n) => n.title),
      risks: arr(a.riscos, 6).map((x) => str(x, 240)).filter(Boolean),
      confidence: conf.startsWith('a') ? 'alta' : conf.startsWith('b') ? 'baixa' : 'media',
      sources: (sources.length ? sources : arr(a.fontes, 8).map((u) => ({ uri: safeHttpUrl(u?.url ?? u), title: '' })).filter((x) => x.uri)).slice(0, 8),
    };
  }
  return { overview: str(raw?.visaoGeral, 1500), items };
}

// ---------------------------------------------------------------- revisão do aporte

export function aporteReviewPrompt({ plan, reports, analyses, today }) {
  const ctx = plan.lines.map((l) => {
    const an = analyses[l.ticker];
    return { ticker: l.ticker, classe: l.type, valorBRL: Math.round(l.amount), cotas: l.qty, recomendacao: l.rec, vereditoIA: an?.verdict, leituraIA: an?.summary };
  });
  const classes = plan.classes.map((c) => ({ classe: c.type, antesPct: +(c.pctBefore * 100).toFixed(1), depoisPct: +(c.pctAfter * 100).toFixed(1), alvoPct: +(c.target * 100).toFixed(1) }));
  return [
    `Hoje é ${today}. Um investidor pessoa física vai aportar R$ ${Math.round(plan.amount).toLocaleString('pt-BR')} seguindo carteiras recomendadas (${reports.map((r) => `${ASSET_TYPES[r.type].short} ${r.month}`).join(', ')}).`,
    'Distribuição por classe (antes → depois do aporte, e alvo):',
    JSON.stringify(classes),
    'Plano de compras calculado:',
    JSON.stringify(ctx),
    plan.sellAlerts.length ? `Posições com recomendação de venda: ${plan.sellAlerts.map((s) => s.ticker).join(', ')}.` : '',
    '',
    'Pesquise rapidamente o momento atual de mercado e comente o plano em português, de forma direta:',
    '1) O plano faz sentido? 2) Algum ativo merece mais ou menos dinheiro agora e por quê? 3) Riscos de concentração ou de momento. 4) Ajustes concretos sugeridos (com valores).',
    'Use no máximo 250 palavras, em tópicos curtos. Lembre que não é recomendação formal de investimento.',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------- pareceres (ranking, carteira, plano)

const brlTxt = (v) => `R$ ${Math.round(v).toLocaleString('pt-BR')}`;
const webLine = (web) => (web
  ? 'Antes de concluir, pesquise rapidamente na web para confirmar os pontos críticos (preço atual, fatos relevantes recentes).'
  : 'Use os dados abaixo (já vieram de pesquisa na web feita hoje).');
const close = 'Responda em português, em tópicos curtos e diretos, com no máximo 350 palavras. Não é recomendação formal de investimento.';

export function rankingReviewPrompt({ month, ranking, today, web = false }) {
  return [
    `Hoje é ${today}. Você é um analista de investimentos revisando as carteiras recomendadas de ${month} (ações, FIIs e internacional) depois da pesquisa de cada ativo.`,
    webLine(web),
    'Ranking calculado (nota 0-100 = recomendação da casa + leitura da pesquisa + margem até o preço teto + DY):',
    rankingText(ranking),
    '',
    'Escreva o parecer do mês:',
    '1) As 5 melhores oportunidades agora e por quê.',
    '2) Potenciais que valem acompanhar (o que falta para virar compra).',
    '3) Ativos em risco ou para evitar, com o motivo.',
    '4) Uma frase por classe (ações, FIIs, internacional) sobre o momento.',
    close,
  ].join('\n');
}

export function portfolioReviewPrompt({ month, cmp, ranking, today, web = false }) {
  const byTicker = new Map(ranking.map((r) => [r.ticker, r]));
  const rows = cmp.rows.map((r) => {
    const rk = byTicker.get(r.ticker);
    const res = r.cost ? `${(((r.value - r.cost) / r.cost) * 100).toFixed(1)}%` : '—';
    return `${r.ticker} (${ASSET_TYPES[r.type].short}) ${brlTxt(r.value)} = ${((r.value / (cmp.total || 1)) * 100).toFixed(1)}% do patrimônio · resultado ${res} · ${rk ? `nota ${rk.score} (${GROUPS[rk.group].label}), casa ${rk.rec}${rk.an?.summary ? ` — ${rk.an.summary.slice(0, 160)}` : ''}` : 'fora das carteiras recomendadas do mês'}`;
  });
  const classes = cmp.classes.map((c) => `${c.label}: ${(c.pct * 100).toFixed(1)}% (alvo ${(c.target * 100).toFixed(0)}%)`).join(' · ');
  return [
    `Hoje é ${today}. Você é um analista de investimentos fazendo o diagnóstico da carteira de um investidor pessoa física, comparando com as carteiras recomendadas de ${month}.`,
    webLine(web),
    `Patrimônio investido: ${brlTxt(cmp.total)}. Por classe: ${classes}.`,
    'Posições:',
    rows.join('\n'),
    '',
    'Melhores oportunidades do mês (que o investidor pode ainda não ter):',
    ranking.filter((r) => r.group === 'oportunidade').slice(0, 10).map((r) => `${r.ticker} nota ${r.score}`).join(', '),
    '',
    'Escreva o diagnóstico:',
    '1) Saúde geral: diversificação, concentração (algum ativo ou classe pesado demais?).',
    '2) Pontos fortes da carteira.',
    '3) Posições fracas ou em risco e o que fazer (manter sem aportar, reduzir aos poucos, ou vender — lembre de IR/DARF e de que o investidor prefere não vender sem motivo forte).',
    '4) O que falta, comparando com as carteiras recomendadas.',
    '5) Prioridades para os próximos aportes.',
    close,
  ].join('\n');
}

export function planReviewPrompt({ plan, cmp, ranking, today, web = false }) {
  const byTicker = new Map(ranking.map((r) => [r.ticker, r]));
  return [
    `Hoje é ${today}. Você é um analista de investimentos revisando o plano de aporte do mês de um investidor pessoa física.`,
    webLine(web),
    `Patrimônio atual: ${brlTxt(cmp.total)}. Aporte: ${brlTxt(plan.amount)}.`,
    `Classes (antes → depois → alvo): ${plan.classes.map((c) => `${c.label} ${(c.pctBefore * 100).toFixed(1)}% → ${(c.pctAfter * 100).toFixed(1)}% → ${(c.target * 100).toFixed(0)}%`).join(' · ')}`,
    'Compras propostas:',
    plan.lines.map((l) => { const rk = byTicker.get(l.ticker); return `${l.ticker}: ${l.qty} ${l.fractional ? 'un.' : 'cotas'} ≈ ${brlTxt(l.amount)} · nota ${rk?.score ?? '—'} · ${l.reason}${rk?.an?.summary ? ` — pesquisa: ${rk.an.summary.slice(0, 160)}` : ''}`; }).join('\n'),
    plan.warnings.length ? `Observações do cálculo:\n${plan.warnings.map((w) => `- ${w}`).join('\n')}` : '',
    `Carteira atual: ${cmp.rows.map((r) => `${r.ticker} ${((r.value / (cmp.total || 1)) * 100).toFixed(1)}%`).join(', ')}`,
    '',
    'Revise o plano como um analista: 1) faz sentido? 2) trocaria algum ativo ou valor, e por quê? 3) riscos de concentração ou de momento; 4) versão final sugerida (ativo, quantidade, valor).',
    close,
  ].filter(Boolean).join('\n');
}
