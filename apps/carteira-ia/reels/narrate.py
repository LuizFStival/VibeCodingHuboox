"""Narração em português (voz neural Kokoro, offline) encaixada no tempo de cada cena.

Uso (depois de `node render.mjs`, que gera out/carteira-ia-reels.mp4 e out/trilha.wav):

    pip install kokoro-onnx soundfile
    # baixe kokoro-v1.0.onnx e voices-v1.0.bin em
    # https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0
    python narrate.py --models PASTA_DOS_MODELOS [--voice pm_alex|pf_dora|pm_santa]

Cada frase de narration.json começa em `at` e precisa terminar antes de `end`; se a voz
passar do tempo, a fala é acelerada um pouco (até 1,25×). Depois o ffmpeg mistura voz e
trilha: os efeitos abaixam sozinhos enquanto a voz fala (sidechain) e o volume final fica
no padrão das redes (-14 LUFS). O vídeo não é regravado, só o áudio.
"""
import argparse
import json
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

HERE = Path(__file__).resolve().parent
OUT = HERE / 'out'
SR = 24000
DUR = 30.0

ap = argparse.ArgumentParser()
ap.add_argument('--models', required=True, help='pasta com kokoro-v1.0.onnx e voices-v1.0.bin')
ap.add_argument('--voice', default=None)
ap.add_argument('--out', default=None, help='nome do MP4 final (padrão: carteira-ia-reels-narrado.mp4)')
args = ap.parse_args()

cfg = json.loads((HERE / 'narration.json').read_text(encoding='utf-8'))
voice = args.voice or cfg['voice']
models = Path(args.models)
kokoro = Kokoro(str(models / 'kokoro-v1.0.onnx'), str(models / 'voices-v1.0.bin'))

track = np.zeros(int(DUR * SR), dtype=np.float32)
for line in cfg['lines']:
    window = line['end'] - line['at']
    speed = 1.0
    for _ in range(4):
        samples, sr = kokoro.create(line['text'], voice=voice, speed=speed, lang='pt-br')
        assert sr == SR
        # tira o silêncio do começo e do fim para a fala cair no tempo certo
        loud = np.where(np.abs(samples) > 0.01)[0]
        if len(loud):
            samples = samples[max(0, loud[0] - 240): loud[-1] + 2400]
        dur = len(samples) / SR
        if dur <= window or speed >= 1.25:
            break
        speed = min(1.25, speed * dur / window * 1.02)
    start = int(line['at'] * SR)
    seg = samples[: max(0, len(track) - start)]
    track[start: start + len(seg)] += seg
    print(f"{line['at']:5.2f}s  {dur:4.2f}s/{window:4.2f}s  {speed:.2f}x  {line['text']}")

voice_wav = OUT / f'narracao-{voice}.wav'
sf.write(voice_wav, np.clip(track, -1, 1), SR)

video = OUT / 'carteira-ia-reels.mp4'
music = OUT / 'trilha.wav'
final = OUT / (args.out or 'carteira-ia-reels-narrado.mp4')
filt = (
    '[1:a]aresample=48000,volume=0.55[m];'
    '[2:a]aresample=48000,highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=5:release=80,'
    'equalizer=f=3000:t=q:w=1.2:g=2,volume=1.6,asplit=2[v][vk];'
    '[m][vk]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=350[duck];'
    '[duck][v]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]'
)
subprocess.run([
    'ffmpeg', '-y', '-loglevel', 'error', '-i', str(video), '-i', str(music), '-i', str(voice_wav),
    '-filter_complex', filt, '-map', '0:v', '-map', '[a]', '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-shortest', str(final),
], check=True)
print('Pronto:', final)
