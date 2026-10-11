// Cliente mínimo da API do Gemini (REST generateContent), chamado direto do navegador
// com a chave do próprio usuário. `fetch` é injetável para os testes.

export const DEFAULT_MODEL = 'gemini-2.5-flash';
export const MODEL_OPTIONS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'];
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
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

export function createGemini({ apiKey, model = DEFAULT_MODEL, fetch: fetchImpl = globalThis.fetch.bind(globalThis) }) {
  if (!apiKey) throw new GeminiError('Configure sua chave da API do Gemini em Configurações.', 401);

  /**
   * parts: [{ text }] | [{ inlineData: { mimeType, data } }]
   * schema: responseSchema (OpenAPI) → JSON garantido. search: liga o Google Search (grounding).
   * O Gemini não aceita schema + search juntos, então com search o JSON vem no texto.
   */
  async function generate({ parts, system, schema, search = false, temperature = 0.2, signal }) {
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (schema && !search) Object.assign(body.generationConfig, { responseMimeType: 'application/json', responseSchema: schema });
    if (search) body.tools = [{ google_search: {} }];

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
      throw new GeminiError(`Sem conexão com a API do Gemini (${e.message}).`, 0);
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = payload?.error?.message ?? res.statusText;
      if (res.status === 429) throw new GeminiError(`Limite de uso da API atingido. Espere um pouco e tente de novo. (${msg})`, 429);
      if (res.status === 400 && /api key/i.test(msg)) throw new GeminiError('Chave da API do Gemini inválida.', 401);
      throw new GeminiError(`Gemini: ${msg}`, res.status);
    }
    const cand = payload.candidates?.[0];
    if (!cand) throw new GeminiError(`O Gemini não respondeu (${payload.promptFeedback?.blockReason ?? 'sem candidatos'}).`, 502);
    const text = (cand.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    if (!text) throw new GeminiError(`Resposta vazia do Gemini (${cand.finishReason ?? 'desconhecido'}).`, 502);

    const sources = [];
    const seen = new Set();
    for (const ch of cand.groundingMetadata?.groundingChunks ?? []) {
      const uri = safeUrl(ch.web?.uri);
      if (uri && !seen.has(uri)) { seen.add(uri); sources.push({ uri, title: String(ch.web?.title ?? '').slice(0, 200) }); }
    }
    return {
      text,
      truncated: cand.finishReason === 'MAX_TOKENS',
      sources,
      json() { return parseJsonLoose(text); },
    };
  }

  return { model, generate };
}
