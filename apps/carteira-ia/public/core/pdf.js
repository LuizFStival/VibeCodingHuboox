// Converte as páginas do PDF em JPEG (no navegador, com pdf.js) para mandar ao Gemini.
// Os relatórios são PDFs de imagem (sem texto), e chegam a 25 MB — maiores que o limite
// de envio direto da API. Redimensionadas, as páginas ficam em poucos MB no total.

const MAX_PAGES = 40;
const TARGET_WIDTH = 1100; // px — ainda legível para as tabelas, com envio menor
const QUALITY = 0.75;

let pdfjs;
async function lib() {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

/** file: File/Blob. Devolve [{ mimeType, data }] (base64) e o total de páginas. */
export async function pdfToImages(file, { onPage, maxPages = MAX_PAGES } = {}) {
  const { getDocument } = await lib();
  const doc = await getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const pages = Math.min(doc.numPages, maxPages, MAX_PAGES);
  const images = [];
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  for (let n = 1; n <= pages; n++) {
    onPage?.(n, pages);
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2.5, TARGET_WIDTH / base.width) });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const url = canvas.toDataURL('image/jpeg', QUALITY);
    images.push({ mimeType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) });
    page.cleanup();
  }
  await doc.destroy();
  return { images, pages: doc.numPages, truncated: doc.numPages > pages };
}
