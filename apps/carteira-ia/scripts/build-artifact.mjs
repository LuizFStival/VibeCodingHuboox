// Gera a versão do app para o painel de Artifact do Claude: um único index.html com o CSS e o
// JS embutidos (empacotado com esbuild). O painel envolve a página no próprio <html>/<head>/<body>,
// então aqui sai só o conteúdo, e o modo "painel" (sem API do Gemini, sem downloads) vem ligado.
// Uso: node scripts/build-artifact.mjs  (precisa de rede para o npx baixar o esbuild)
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = `${root}dist-artifact/`;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const js = execFileSync('npx', ['--yes', 'esbuild@0.24.0', 'public/app.js', '--bundle', '--format=esm', '--minify'],
  { cwd: root, encoding: 'utf8', maxBuffer: 20e6 });
if (/<\/script/i.test(js)) throw new Error('o JS empacotado contém </script>');
const css = readFileSync(`${root}public/styles.css`, 'utf8');
const html = readFileSync(`${root}public/index.html`, 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace('<script type="module" src="app.js"></script>', '').trim();

writeFileSync(`${out}index.html`, `<title>Carteira IA</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${css}
</style>
${body}
<script>window.__CARTEIRA_ARTIFACT__ = true; window.__PDFJS_BASE__ = './vendor/pdfjs/';</script>
<script type="module">
${js}
</script>
`);
// O pdf.js vai como arquivo ao lado da página (publicar com `files`: vendor/pdfjs/*).
mkdirSync(`${out}vendor/pdfjs`, { recursive: true });
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs', 'LICENSE']) writeFileSync(`${out}vendor/pdfjs/${f}`, readFileSync(`${root}public/vendor/pdfjs/${f}`));
console.log(`dist-artifact/index.html pronto (${Math.round(readFileSync(`${out}index.html`).length / 1024)} KB)`);
