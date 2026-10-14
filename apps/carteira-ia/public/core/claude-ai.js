// Adaptador do Claude do painel (capability `sample` do Artifact) com a mesma interface
// do cliente do Gemini (`generate`), para o serviço não precisar saber quem responde.
// Diferenças: o Claude do painel não navega na web (pedido com `search` cai no fluxo
// "sem pesquisa" do serviço), não aceita schema (o formato vai no próprio pedido) e
// recebe as imagens à parte, na ordem.

import { parseJsonLoose } from './gemini.js';

export class ClaudeAIError extends Error {
  constructor(message, extra = {}) { super(message); Object.assign(this, extra); }
}

/** Exemplo de JSON a partir do schema OpenAPI usado com o Gemini. */
export function exampleFromSchema(s) {
  if (!s) return null;
  if (s.type === 'OBJECT') return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, exampleFromSchema(v)]));
  if (s.type === 'ARRAY') return [exampleFromSchema(s.items)];
  if (s.type === 'NUMBER') return 0;
  if (s.enum) return s.enum.join(' | ');
  return s.description ? `(${s.description})` : '...';
}

function base64ToBlob(data, mimeType) {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

const MESSAGES = {
  not_granted: 'Você não permitiu que esta página use o Claude. Recarregue a página e clique em Permitir quando o Claude perguntar.',
  sampling_disabled: 'O Claude não está disponível para esta conta.',
  rate_limited: 'Limite de uso do Claude atingido por agora. Tente de novo mais tarde.',
  refused: 'O Claude recusou este pedido.',
  image_rejected: 'O Claude não aceitou as imagens das páginas (formato ou tamanho).',
  images_unavailable: 'Este painel não permite enviar imagens ao Claude.',
  prompt_too_large: 'O pedido ficou grande demais para o Claude.',
  invalid_json: 'O Claude respondeu, mas não no formato esperado. Tente de novo.',
  session_expired: 'Sua sessão do Claude expirou. Entre de novo e recarregue a página.',
};

export function createClaudeAI(sample) {
  async function generate({ parts, schema, search = false, signal }) {
    if (search) throw new ClaudeAIError('O Claude do painel não pesquisa na web.', { searchUnsupported: true });
    const texts = [];
    const images = [];
    for (const p of parts) {
      if (p.inlineData) images.push(base64ToBlob(p.inlineData.data, p.inlineData.mimeType));
      else if (p.text && !/^Página \d+$/.test(p.text)) texts.push(p.text);
    }
    let prompt = texts.join('\n\n');
    let sent = images;
    if (images.length) {
      const max = (await sample.limits().catch(() => null))?.images?.maxCount ?? 0;
      if (!max) throw new ClaudeAIError(MESSAGES.images_unavailable, { status: 401 });
      sent = images.slice(0, max);
      prompt += `\n\nAs ${sent.length} imagens anexadas são as páginas do PDF, em ordem: a 1ª imagem é a "Página 1", a 2ª é a "Página 2", e assim por diante.`;
    }
    if (schema) prompt += `\n\nResponda SOMENTE com um JSON válido (sem texto fora dele), neste formato:\n${JSON.stringify(exampleFromSchema(schema))}`;
    try {
      const res = await sample(prompt, { images: sent.length ? sent : undefined, signal, cache: false });
      return {
        text: res.text, truncated: res.truncated, sources: [], searched: false, queries: [],
        json() { return parseJsonLoose(res.text); },
      };
    } catch (e) {
      if (e?.code === 'cancelled') { const a = new DOMException('Cancelado', 'AbortError'); throw a; }
      const msg = MESSAGES[e?.code] ?? `O Claude não conseguiu responder agora (${e?.code ?? 'erro'}). Tente de novo.`;
      // Sem permissão/limite: parar a análise inteira, como a cota diária do Gemini.
      throw new ClaudeAIError(msg, { status: ['not_granted', 'sampling_disabled', 'session_expired'].includes(e?.code) ? 401 : 0, daily: e?.code === 'rate_limited', raw: e?.message ?? '' });
    }
  }
  return { model: 'Claude', generate, listModels: async () => [] };
}
