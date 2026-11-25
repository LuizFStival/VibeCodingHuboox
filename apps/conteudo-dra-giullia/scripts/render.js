#!/usr/bin/env node
// Gera os PNGs de um post a partir do JSON aprovado.
// Uso: npm run render -- conteudos/<pasta>/post.json
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
// require() também acha um Playwright instalado globalmente (NODE_PATH)
const { chromium } = createRequire(import.meta.url)("playwright");
import { montarDocumento } from "../templates/slides.js";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entrada = process.argv[2];
if (!entrada) {
  console.error("Uso: npm run render -- conteudos/<pasta>/post.json");
  process.exit(1);
}

const jsonPath = resolve(process.cwd(), entrada);
const post = JSON.parse(await readFile(jsonPath, "utf8"));
if (!Array.isArray(post.slides) || !post.slides.length) throw new Error("O JSON precisa ter um array 'slides'.");
if (post.formato === "post" && post.slides.length > 1) console.warn("Aviso: formato 'post' com mais de 1 slide; todos serão gerados.");

const pasta = dirname(jsonPath);
const saida = join(pasta, "png");
await mkdir(saida, { recursive: true });

const url = (p) => pathToFileURL(p).href;
const html = montarDocumento(post, {
  cssHref: url(join(raiz, "templates/estilo.css")),
  assets: {
    logoPreto: url(join(raiz, "assets/logo-preto-recortado.png")),
    logoBranco: url(join(raiz, "assets/logo-branco-recortado.png")),
  },
  foto: (p) => url(resolve(raiz, p)),
});
const htmlPath = join(saida, "_preview.html");
await writeFile(htmlPath, html);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1400 }, deviceScaleFactor: 1 });
await page.goto(url(htmlPath), { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);

const faltaFonte = await page.evaluate(() => !document.fonts.check('600 40px "Fraunces"') || !document.fonts.check('400 40px "Karla"'));
if (faltaFonte) console.warn("Aviso: as fontes Fraunces/Karla não carregaram (sem internet?). As artes sairiam com fonte substituta.");

const estouros = await page.$$eval(".slide .conteudo", (els) => els.map((el, i) => (el.scrollHeight > el.clientHeight + 2 ? i + 1 : null)).filter(Boolean));

const slides = await page.$$(".slide");
for (const [i, el] of slides.entries()) {
  await el.screenshot({ path: join(saida, `${String(i + 1).padStart(2, "0")}.png`) });
}
await browser.close();

if (post.legenda) {
  await writeFile(join(saida, "legenda.txt"), `${post.legenda}\n\n${(post.hashtags || []).join(" ")}\n`);
}
console.log(`${slides.length} arte(s) gerada(s) em ${saida}`);
if (estouros.length) {
  console.warn(`Atenção: texto cortado no(s) slide(s) ${estouros.join(", ")}. Encurte o texto (não diminua a fonte).`);
  process.exitCode = 2;
}
