// Grava reel.html em MP4: abre a página num navegador sem janela (Playwright/Chromium),
// pede cada quadro à função render(t), gera o som com Web Audio e junta tudo com o ffmpeg.
//
//   node render.mjs                 → out/carteira-ia-reels.mp4
//   node render.mjs --stills 1,8.6  → só fotos desses segundos (out/still-*.jpg), para conferir
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs')); }

const args = process.argv.slice(2);
const stillsArg = args.includes('--stills') ? args[args.indexOf('--stills') + 1] : null;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
page.on('pageerror', (e) => console.error('Erro na página:', e.message));
await page.goto(pathToFileURL(join(here, 'reel.html')).href + '?render=1');
await page.waitForFunction(() => window.__reel?.ready);
const { FPS, DUR } = await page.evaluate(() => ({ FPS: window.__reel.FPS, DUR: window.__reel.DUR }));

if (stillsArg) {
  for (const s of stillsArg.split(',').map(Number)) {
    const b64 = await page.evaluate((i) => window.__reel.frame(i, 0.9), Math.round(s * FPS));
    writeFileSync(join(outDir, `still-${String(s).replace('.', '_')}.jpg`), Buffer.from(b64, 'base64'));
  }
  await browser.close();
  console.log('Fotos salvas em', outDir);
  process.exit(0);
}

console.log('Gerando o som…');
const wav = join(outDir, 'trilha.wav');
writeFileSync(wav, Buffer.from(await page.evaluate(() => window.__reel.renderAudioWav()), 'base64'));

const mp4 = join(outDir, 'carteira-ia-reels.mp4');
const ff = spawn('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
  '-i', wav,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
  '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', // volume no padrão das redes (-14 LUFS)
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', mp4,
], { stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg saiu com ${c}`)))));

const total = Math.round(FPS * DUR);
const t0 = Date.now();
for (let i = 0; i < total; i++) {
  const b64 = await page.evaluate((n) => window.__reel.frame(n, 0.95), i);
  if (!ff.stdin.write(Buffer.from(b64, 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
  if (i % 60 === 0) console.log(`quadro ${i}/${total} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
ff.stdin.end();
await done;
await browser.close();
console.log('Pronto:', mp4);
