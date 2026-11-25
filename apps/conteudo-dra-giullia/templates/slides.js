// Monta o HTML de cada tipo de slide a partir do JSON do Copywriter.
// Tipos: capa, mito, texto, lista, final. Ver maquinas/02-copywriter.md.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// *palavra* vira destaque
const rich = (s) => esc(s).replace(/\*([^*]+)\*/g, "<em>$1</em>");

const blobs = `<div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>`;
const sobre = (s) => (s ? `<div class="sobretitulo">${esc(s)}</div>` : "");

function rodape({ i, total, final, assets, capa }) {
  const logo = final ? assets.logoBranco : assets.logoPreto;
  const direita = capa && total > 1
    ? `<span class="arraste">Arraste <svg width="34" height="18" viewBox="0 0 34 18" fill="none"><path d="M1 9h30m0 0-7-7m7 7-7 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`
    : total > 1 ? `<span class="contador">${String(i + 1).padStart(2, "0")}/${String(total).padStart(2, "0")}</span>` : "";
  return `<div class="rodape"><img src="${logo}" alt="Dra. Giullia Campioni · CRO-PR 39945">${direita}</div>`;
}

const corpo = {
  capa: (s, ctx) => `
    ${s.foto ? `<div class="foto"><img src="${ctx.foto(s.foto)}" alt=""></div>` : ""}
    <div class="conteudo">${sobre(s.sobretitulo)}<h1>${rich(s.titulo)}</h1>${s.subtitulo ? `<p class="sub">${esc(s.subtitulo)}</p>` : ""}</div>`,
  mito: (s) => {
    const v = String(s.veredito || "Mito");
    const cls = /verdade/i.test(v) ? "v-verdade" : /depende/i.test(v) ? "v-depende" : "v-mito";
    return `<div class="conteudo">${sobre(s.sobretitulo)}<div class="afirmacao">${esc(s.afirmacao)}</div><div class="veredito ${cls}">${esc(v)}</div><p class="texto">${rich(s.explicacao)}</p></div>`;
  },
  texto: (s) => `<div class="conteudo">${sobre(s.sobretitulo)}<h2>${rich(s.titulo)}</h2><p class="texto">${rich(s.texto)}</p></div>`,
  lista: (s) => `<div class="conteudo">${sobre(s.sobretitulo)}<h2>${rich(s.titulo)}</h2><ul class="itens">${(s.itens || []).map((t) => `<li>${rich(t)}</li>`).join("")}</ul></div>`,
  final: (s) => `<div class="conteudo">${sobre(s.sobretitulo)}<h2>${rich(s.titulo)}</h2>${s.texto ? `<p class="texto">${rich(s.texto)}</p>` : ""}${s.cta ? `<span class="pill">${esc(s.cta)}</span>` : ""}</div>`,
};

export function montarDocumento(post, { cssHref, assets, foto }) {
  const total = post.slides.length;
  const stories = post.formato === "stories";
  const html = post.slides.map((s, i) => {
    const tipo = corpo[s.tipo] ? s.tipo : "texto";
    const final = tipo === "final";
    const classes = ["slide", tipo, stories && "stories", i % 2 === 1 && !final && "alt", s.foto && "com-foto"].filter(Boolean).join(" ");
    return `<section class="${classes}" data-i="${i}">${blobs}${corpo[tipo](s, { foto })}${rodape({ i, total, final, assets, capa: tipo === "capa" })}</section>`;
  }).join("\n");

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;1,9..144,500&family=Manrope:wght@400;500;700;800&display=block">
<link rel="stylesheet" href="${cssHref}"></head><body>${html}</body></html>`;
}
