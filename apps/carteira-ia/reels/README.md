# Reels · Carteira IA

Animação 9:16 (1080×1920, 30 s, 30 fps) que mostra o fluxo do app: a IA lê as carteiras recomendadas, pesquisa cada ativo, monta o ranking, compara com a sua carteira e propõe o aporte do mês (exemplo de R$ 500).

- `reel.html`: toda a animação num único `<canvas>`, desenhada pela função `render(t)`. O som é sintetizado com Web Audio (`buildAudio`), no mesmo relógio. Abra no navegador e clique em **Play com som**; a barra deixa pular para qualquer segundo.
- `render.mjs`: grava o MP4 (Playwright + Chromium + ffmpeg). `node render.mjs` gera `out/carteira-ia-reels.mp4`; `node render.mjs --stills 1,8.6` só tira fotos desses segundos para conferir.

Números de exemplo, não é recomendação de investimento.
