// Categorização em 3 camadas, da mais forte para a mais fraca:
//   1. manual   – correção feita num lançamento específico
//   2. regra    – correção aprendida para o estabelecimento (vale para meses futuros)
//   3. auto     – palavras-chave embutidas abaixo
// A categoria é resolvida na leitura (não gravada no lançamento), então uma
// regra nova corrige automaticamente todo o histórico e as próximas faturas.

import { merchantKey } from './merchant.js';

export const FALLBACK_CATEGORY = 'Outros';

export const DEFAULT_CATEGORIES = [
  'Mercado',
  'Restaurantes & Bares',
  'Delivery',
  'Combustível',
  'Transporte',
  'Automóvel',
  'Saúde & Bem-estar',
  'Assinaturas & Serviços',
  'Compras Online',
  'Vestuário & Acessórios',
  'Casa & Pet',
  'Lazer & Eventos',
  'Educação',
  'Viagem',
  'Pessoas / Pix',
  FALLBACK_CATEGORY,
];

// A ordem importa: a primeira regra que casar vence.
// Os padrões rodam sobre a chave normalizada (minúscula, sem acento, só [a-z0-9 ]).
const KEYWORD_RULES = [
  ['Delivery', /^ifd\b|ifood|rappi|ze delivery|aiqfome|james delivery/],
  ['Transporte', /\buber\b|\b99 ?(app|pop|taxi)\b|cabify|\bestac|estacionamento|sem parar|conectcar|veloe|pedagio|metrocard|\bmetro\b/],
  ['Combustível', /\bposto\b|\bshell\b|ipiranga|petrobras|\bbr mania|combustive/],
  ['Restaurantes & Bares', /\bbar\b|gastrono|restaurante|lanchonete|lanches|pizzari|pizza|burger|sushi|churrasc|\bcafe\b|cafeteria|boteco|\bpub\b|bistro|cervej|chopp|\bacai\b|sorvete|padaria|panificadora|confeitaria|outback|mcdonald|burger king|subway/],
  ['Mercado', /supermerc|\bmercado\b(?! ?(livre|pago))|atacad|\bfort\b|komprao|minipreco|emporio|market|hortifrut|sacolao|acougue|\bfestival\b|condor|muffato|carrefour|assai|pao de acucar|angeloni|conveniencia|\balim\b|alimentos|mercearia/],
  ['Saúde & Bem-estar', /farmac|drogar|\bdroga|nissei|farmais|panvel|\braia\b|pacheco|pague menos|drogasil|hospital|clinica|laborat|odonto|medic|wellhub|gympass|academia|smart ?fit|totalpass/],
  ['Assinaturas & Serviços', /apple ?com|netflix|spotify|prime video|amazon prime|disney|hbo ?max|youtube|google|microsoft|adobe|starlink|chatgpt|openai|anthropic|claude ai|deezer|globoplay|paramount|icloud|dropbox|canva|linkedin/],
  ['Vestuário & Acessórios', /joia|\bprata|semi ?joia|relojoaria|otica|renner|riachuelo|zara|hering|decathlon|centauro|netshoes|\bnike\b|adidas|\bloja\b|calcad|\bmoda\b|lojas? virus|havaianas/],
  ['Compras Online', /mercado ?livre|mercadol|aliexpress|\btemu\b|shein|tiktok shop|shopee|amazon|magalu|magazine luiza|americanas|casas bahia|kabum|\bnuv\b/],
  ['Automóvel', /centro auto|auto ?center|mecanic|\bpneu|auto ?pecas|oficina|lava ?car|detran|seguro auto|autopecas/],
  ['Casa & Pet', /leroy|madeira ?madeira|construc|tok ?stok|camicado|cobasi|petz|\bpet\b|petshop|moveis|eletro/],
  ['Lazer & Eventos', /ticket|ingresso|sympla|eventim|cinema|cinemark|teatro|\bshow\b|steam|playstation|xbox|nintendo/],
  ['Educação', /editora|livraria|udemy|alura|\bcurso|escola|faculdade|colegio/],
  ['Viagem', /hotel|airbnb|booking|latam|\bgol\b|azul linhas|decolar|123 ?milhas|pousada|hostel|smiles/],
  ['Pessoas / Pix', /^\d{6,}/],
];

export function autoCategory(titleOrKey) {
  const key = merchantKey(titleOrKey);
  for (const [category, re] of KEYWORD_RULES) {
    if (re.test(key)) return category;
  }
  return FALLBACK_CATEGORY;
}

/**
 * @param {{merchantKey:string, title:string, categoryOverride?:string|null}} tx
 * @param {Map<string,string>} merchantRules  merchantKey -> categoria
 */
export function resolveCategory(tx, merchantRules) {
  if (tx.categoryOverride) return { category: tx.categoryOverride, source: 'manual' };
  const ruled = merchantRules.get(tx.merchantKey);
  if (ruled) return { category: ruled, source: 'regra' };
  return { category: autoCategory(tx.title), source: 'auto' };
}
