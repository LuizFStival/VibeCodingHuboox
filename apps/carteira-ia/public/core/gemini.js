// Cliente mínimo da API do Gemini (REST generateContent), chamado direto do navegador
// com a chave do próprio usuário. `fetch` e `sleep` são injetáveis para os testes.
//
// Robustez (o plano gratuito tem limites baixos de requisições por minuto e por dia):
//   - uma chamada por vez, com intervalo mínimo entre elas (fila compartilhada);
//   - 429/5xx/queda de rede: tenta de novo, esperando o tempo que a API pede (RetryInfo);
//   - cota DIÁRIA esgotada: não adianta insistir — erro com `daily = true`.

// Aliases "-latest" sempre apontam para a versão atual: o Google desativa modelos
// numerados com o tempo (ex.: gemini-2.5-flash deixou de valer para chaves novas).
export const DEFAULT_MODEL = 'gemini-flash-latest';
export const MODEL_OPTIONS = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest'];

// Modelos que não servem para ler PDF + responder texto/JSON com pesquisa.
const NOT_FOR_TEXT = /image|tts|transcribe|computer-use|robotics|nano|omni|customtools|embedding|live|audio|veo|imagen/i;

/** Filtra a lista da chave para os modelos úteis ao app, dos mais novos para os mais antigos. */
export function usefulModels(models) {
  const version = (m) => Number((m.match(/gemini-(\d+(?:\.\d+)?)/) ?? [])[1] ?? 0);
  return [...new Set(models)].filter((m) => /^gemini/.test(m) && !NOT_FOR_TEXT.test(m))
    .sort((a, b) => (/-latest$/.test(b) - /-latest$/.test(a)) || version(b) - version(a) || a.localeCompare(b));
}

/** Melhor modelo para o app: o sugerido pela API, senão o Flash mais atual disponível. */
export function pickModel(models, suggested) {
  const list = usefulModels(models);
  if (suggested && list.includes(suggested)) return suggested;
  return list.find((m) => m === 'gemini-flash-latest')
    ?? list.find((m) => /^gemini-[\d.]+-flash$/.test(m))
    ?? list.find((m) => /flash/.test(m) && !/lite/.test(m))
    ?? list[0] ?? null;
}
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_RETRIES = 4;
const MAX_WAIT_MS = 90_000;

export class GeminiError extends Error {
  constructor(message, { status = 0, retryAfterMs = null, daily = false, retryable = false, searchUnsupported = false, searchQuota = false, raw = '' } = {}) {
    super(message);
    Object.assign(this, { status, retryAfterMs, daily, retryable, searchUnsupported, searchQuota, raw });
  }
}

/** Extrai o primeiro objeto/array JSON de um texto (aceita cercas ```json). */
export function parseJsonLoose(text) {
  const s = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(s); } catch { /* procura o trecho JSON */ }
  const start = s.search(/[[{]/);
  if (start < 0) throw new Error('A IA não devolveu JSON.');
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new Error('JSON da IA veio incompleto (resposta cortada?).');
}

const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const parseDelay = (d) => { const m = String(d ?? '').match(/^([\d.]+)s$/); return m ? Math.ceil(Number(m[1]) * 1000) : null; };

/** Converte a resposta de erro da API em GeminiError com mensagem em português e o que fazer. */
export function toGeminiError(status, payload, model, { search = false } = {}) {
  const err = payload?.error ?? {};
  const msg = String(err.message ?? '').slice(0, 600) || `HTTP ${status}`;
  const details = Array.isArray(err.details) ? err.details : [];
  const retry = details.find((d) => /RetryInfo/.test(d?.['@type']));
  const quotaIds = details.filter((d) => /QuotaFailure/.test(d?.['@type'])).flatMap((d) => d.violations ?? [])
    .map((v) => [v.quotaId, v.quotaMetric, v.quotaValue !== undefined ? `limite ${v.quotaValue}` : ''].filter(Boolean).join(' ')).join(' | ');
  const retryAfterMs = parseDelay(retry?.retryDelay) ?? (() => { const m = msg.match(/retry in ([\d.]+)\s*s/i); return m ? Math.ceil(Number(m[1]) * 1000) : null; })();
  const raw = quotaIds ? `${msg} [cota: ${quotaIds}]` : msg;

  if (status === 429 || err.status === 'RESOURCE_EXHAUSTED') {
    const daily = /per ?day|PerDay|daily/i.test(quotaIds);
    const perMinute = retryAfterMs !== null || /per ?minute|PerMinute/i.test(quotaIds);
    const searchQuota = search && (/search|grounding/i.test(quotaIds) || !perMinute);
    // Pesquisa do Google sem cota (no plano gratuito costuma ser 0 nos modelos novos):
    // não adianta repetir — quem chamou pode seguir sem pesquisa.
    if (searchQuota) {
      return new GeminiError(`A pesquisa do Google não está liberada (ou esgotou) para a sua chave no modelo ${model}. No plano gratuito ela costuma ter cota zero; com o faturamento ativado no Google AI Studio ela passa a funcionar.`, { status, searchQuota: true, daily, raw });
    }
    if (daily) {
      return new GeminiError(`Cota diária do modelo ${model} esgotada na sua chave. Volta amanhã — ou troque o modelo em Configurações (ex.: gemini-flash-lite-latest) ou ative o faturamento no Google AI Studio para limites maiores.`, { status, daily: true, raw });
    }
    if (perMinute) return new GeminiError(`Limite de requisições por minuto atingido (${model}).`, { status, retryAfterMs, retryable: true, raw });
    return new GeminiError(`Cota da sua chave esgotada para o modelo ${model}. Veja o uso em ai.dev/rate-limit, troque o modelo ou ative o faturamento no Google AI Studio.`, { status, retryAfterMs: 15000, retryable: true, raw });
  }
  if ((status === 400 || status === 403) && /api key|API_KEY|permission denied/i.test(msg)) {
    return new GeminiError('Chave da API do Gemini inválida ou sem permissão.', { status: 401, raw: msg });
  }
  if (status === 404 || /not found|no longer available|is not supported for generateContent/i.test(msg)) {
    const e = new GeminiError(`O modelo "${model}" não existe ou não está mais disponível para a sua chave.`, { status: 404, raw: msg });
    e.modelUnavailable = true;
    e.suggestedModel = (msg.match(/use (?:models\/)?(gemini[\w.-]*\w)/i) ?? [])[1] ?? null;
    return e;
  }
  if (status === 400 && /search|grounding|tool/i.test(msg)) {
    return new GeminiError(`O modelo ${model} recusou a pesquisa do Google: ${msg}`, { status, searchUnsupported: true, raw: msg });
  }
  if (status >= 500 || status === 408) {
    const e = new GeminiError(`O Gemini está sobrecarregado ou instável agora (${status}).`, { status, retryAfterMs, retryable: true, raw });
    e.overloaded = true;
    return e;
  }
  return new GeminiError(`Gemini (${status}): ${msg}`, { status, raw: msg });
}

/** Outro modelo bom para o app, diferente do atual (usado quando o atual está sobrecarregado). */
export function alternativeModel(models, current) {
  const list = usefulModels(models).filter((m) => m !== current && !/pro/.test(m));
  return list.find((m) => /^gemini-[\d.]+-flash$/.test(m)) ?? list.find((m) => /flash/.test(m)) ?? null;
}

/** Menor raciocínio aceito por cada família de modelo. */
export function thinkingFor(model) {
  if (/gemini-2\.5-pro/.test(model)) return { thinkingBudget: 128 };
  if (/gemini-2\.5/.test(model)) return { thinkingBudget: 0 };
  return { thinkingLevel: 'low' };
}

// Fila compartilhada por todos os clientes da página: uma requisição por vez.
let queue = Promise.resolve();
let lastStart = 0;

export function createGemini({
  apiKey, model = DEFAULT_MODEL, minIntervalMs = 4000, onModelChange,
  fetch: fetchImpl = globalThis.fetch.bind(globalThis),
  sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Cancelado', 'AbortError')); }, { once: true });
  }),
}) {
  if (!apiKey) throw new GeminiError('Configure sua chave da API do Gemini em Configurações.', { status: 401 });

  async function once(body, signal) {
    const search = Boolean(body.tools);
    let res;
    try {
      res = await fetchImpl(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new GeminiError(`Sem conexão com a API do Gemini (${e.message}).`, { retryable: true });
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw toGeminiError(res.status, payload, model, { search });
    return payload;
  }

  /**
   * parts: [{ text }] | [{ inlineData: { mimeType, data } }]
   * schema: responseSchema (OpenAPI) → JSON garantido. search: liga o Google Search (grounding).
   * O Gemini 2.5 não aceita schema + search juntos, então com search o JSON vem no texto.
   * onRetry(msg): avisa a interface quando está esperando para tentar de novo.
   */
  /**
   * fast: desliga/reduz o "raciocínio" do modelo (bom para extração, que é cópia de dados).
   * parallel: não entra na fila (usado na leitura dos PDFs, que são poucas chamadas grandes).
   */
  function generate({ parts, system, schema, search = false, temperature = 0.2, signal, onRetry, fast = false, parallel = false }) {
    const body = { contents: [{ role: 'user', parts }], generationConfig: { temperature } };
    if (fast) body.generationConfig.thinkingConfig = thinkingFor(model);
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (schema && !search) Object.assign(body.generationConfig, { responseMimeType: 'application/json', responseSchema: schema });
    if (search) body.tools = [{ google_search: {} }];

    let switched = false;
    let overloadSwitched = false;
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        if (!parallel) {
          const wait = lastStart + minIntervalMs - Date.now();
          if (wait > 0) await sleep(wait, signal);
          lastStart = Date.now();
        }
        try {
          return parse(await once(body, signal), search);
        } catch (e) {
          if (body.generationConfig.thinkingConfig && e.status === 400 && /thinking/i.test(e.raw || e.message)) {
            // Modelo não aceita esse ajuste de raciocínio: tenta de novo sem ele.
            delete body.generationConfig.thinkingConfig;
            attempt--;
            continue;
          }
          if (e.modelUnavailable && !switched) {
            // Modelo desativado: troca pelo recomendado (ou o Flash atual da chave) e repete.
            switched = true;
            const next = pickModel(await listModels().catch(() => []), e.suggestedModel) ?? e.suggestedModel;
            if (next && next !== model) {
              const old = model;
              model = next;
              onModelChange?.(next, old);
              onRetry?.(`Modelo ${old} indisponível; usando ${next}…`);
              attempt--;
              continue;
            }
            e.message += ' Escolha outro em Configurações ("Ver modelos da minha chave").';
          }
          if (e.overloaded && attempt >= 1 && !overloadSwitched) {
            // Sobrecarga é por modelo: depois de 2 falhas, tenta outro Flash da chave (só nesta chamada).
            overloadSwitched = true;
            const next = alternativeModel(await listModels().catch(() => []), model);
            if (next) {
              onRetry?.(`${model} sobrecarregado; tentando com ${next}…`);
              model = next;
              if (body.generationConfig.thinkingConfig) body.generationConfig.thinkingConfig = thinkingFor(next);
              attempt = 0;
              continue;
            }
          }
          if (!e.retryable || attempt >= MAX_RETRIES) {
            if (e.overloaded) e.message += ' Tente de novo em alguns minutos, ou suba só este PDF outra vez.';
            throw e;
          }
          const ms = Math.min(MAX_WAIT_MS, e.retryAfterMs ?? 2000 * 2 ** attempt) + 500;
          onRetry?.(`${e.message} Tentando de novo em ${Math.round(ms / 1000)} s (${attempt + 1}/${MAX_RETRIES})…`);
          await sleep(ms, signal);
        }
      }
    };
    if (parallel) return run();
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  function parse(payload, search) {
    const cand = payload.candidates?.[0];
    if (!cand) throw new GeminiError(`O Gemini não respondeu (${payload.promptFeedback?.blockReason ?? 'sem candidatos'}).`, { status: 502 });
    const text = (cand.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    if (!text) throw new GeminiError(`Resposta vazia do Gemini (${cand.finishReason ?? 'desconhecido'}).`, { status: 502, retryable: cand.finishReason !== 'SAFETY' });

    const gm = cand.groundingMetadata ?? {};
    const sources = [];
    const seen = new Set();
    for (const ch of gm.groundingChunks ?? []) {
      const uri = safeUrl(ch.web?.uri);
      if (uri && !seen.has(uri)) { seen.add(uri); sources.push({ uri, title: String(ch.web?.title ?? '').slice(0, 200) }); }
    }
    return {
      text,
      truncated: cand.finishReason === 'MAX_TOKENS',
      sources,
      searched: search && Boolean(sources.length || gm.webSearchQueries?.length),
      queries: (gm.webSearchQueries ?? []).slice(0, 10).map(String),
      json() { return parseJsonLoose(text); },
    };
  }

  /** Modelos disponíveis para a chave (que aceitam generateContent). */
  async function listModels() {
    const out = [];
    let pageToken = '';
    for (let i = 0; i < 5; i++) {
      const res = await fetchImpl(`${ENDPOINT}?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { headers: { 'x-goog-api-key': apiKey } });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw toGeminiError(res.status, payload, model);
      for (const m of payload.models ?? []) {
        if (m.supportedGenerationMethods?.includes('generateContent') && /gemini/i.test(m.name)) out.push(m.name.replace(/^models\//, ''));
      }
      if (!payload.nextPageToken) break;
      pageToken = payload.nextPageToken;
    }
    return out.sort();
  }

  return { get model() { return model; }, generate, listModels };
}
