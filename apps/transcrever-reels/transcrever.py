"""
Transcreve a fala de videos .mp4 (pt-BR) localmente com faster-whisper.

Uso:
    python transcrever.py                 # usa ./videos
    python transcrever.py C:\\caminho\\pasta  # usa outra pasta
    python transcrever.py --limite 1      # testa so com o 1o video

Saida: ./saida/<video>.txt, ./saida/<video>.timestamps.txt, ./saida/_todos.txt,
       ./saida/_erros.txt (so se algum video falhar)
"""
import argparse
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import wave
from pathlib import Path

AQUI = Path(__file__).resolve().parent
SAIDA = AQUI / "saida"


def instrucoes_ffmpeg():
    so = platform.system()
    if so == "Windows":
        return ("No Windows, abra o PowerShell e rode:\n"
                "    winget install --id Gyan.FFmpeg -e\n"
                "Depois FECHE e abra o terminal de novo e rode este script outra vez.")
    if so == "Darwin":
        return "No macOS rode:  brew install ffmpeg"
    return "No Linux rode:  sudo apt install ffmpeg   (ou o gerenciador da sua distro)"


def achar_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    # winget as vezes instala mas o PATH so atualiza em terminal novo
    if platform.system() == "Windows":
        base = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
        for p in base.glob("Gyan.FFmpeg*/**/bin/ffmpeg.exe"):
            return str(p)
    return None


def fmt_tempo(seg):
    seg = int(round(seg))
    h, r = divmod(seg, 3600)
    m, s = divmod(r, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def extrair_audio(ffmpeg, video, wav):
    cmd = [ffmpeg, "-nostdin", "-loglevel", "error", "-y", "-i", str(video),
           "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", str(wav)]
    r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    if r.returncode != 0 or not wav.exists() or wav.stat().st_size < 1000:
        raise RuntimeError("ffmpeg falhou ao extrair audio (o video tem som?): " + r.stderr.strip()[-500:])


def ler_wav(wav):
    import numpy as np
    with wave.open(str(wav), "rb") as w:
        dados = w.readframes(w.getnframes())
    return np.frombuffer(dados, dtype=np.int16).astype(np.float32) / 32768.0


def main():
    ap = argparse.ArgumentParser(description="Transcreve videos .mp4 em pt-BR")
    ap.add_argument("pasta", nargs="?", default=str(AQUI / "videos"), help="pasta com os .mp4 (padrao: ./videos)")
    ap.add_argument("--limite", type=int, default=0, help="processa so os N primeiros (teste)")
    ap.add_argument("--modelo", default="small", help="modelo whisper (padrao: small)")
    args = ap.parse_args()

    print(f"Sistema: {platform.system()} {platform.release()} | Python {platform.python_version()}")

    pasta = Path(args.pasta)
    if not pasta.is_dir():
        sys.exit(f"ERRO: pasta nao encontrada: {pasta}\nCrie a pasta e coloque os .mp4 nela.")
    videos = sorted([p for p in pasta.iterdir() if p.suffix.lower() == ".mp4"], key=lambda p: p.name.lower())
    if not videos:
        sys.exit(f"ERRO: nenhum .mp4 em {pasta}")
    if args.limite:
        videos = videos[:args.limite]

    ffmpeg = achar_ffmpeg()
    if not ffmpeg:
        sys.exit("ERRO: ffmpeg nao encontrado.\n" + instrucoes_ffmpeg())

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("ERRO: faster-whisper nao instalado. Rode:  pip install -r requirements.txt")

    print(f"Carregando modelo '{args.modelo}' (na 1a vez baixa ~460 MB; depois roda offline)...")
    model = WhisperModel(args.modelo, device="cpu", compute_type="int8")

    SAIDA.mkdir(exist_ok=True)
    resultados = []  # (nome, duracao, texto)
    erros = []
    tmp = Path(tempfile.mkdtemp(prefix="transcrever_"))

    for i, video in enumerate(videos, 1):
        print(f"[{i}/{len(videos)}] {video.name} ... ", end="", flush=True)
        t0 = time.time()
        try:
            wav = tmp / "audio.wav"
            extrair_audio(ffmpeg, video, wav)
            audio = ler_wav(wav)
            segmentos, info = model.transcribe(audio, language="pt", beam_size=5, vad_filter=True)
            segmentos = list(segmentos)
            texto = " ".join(s.text.strip() for s in segmentos).strip()
            # As vezes o whisper devolve tudo sem pontuacao; refaz com um prompt pontuado
            palavras = len(texto.split())
            if palavras > 30 and sum(texto.count(c) for c in ".,?!") < palavras / 40:
                segmentos, info = model.transcribe(audio, language="pt", beam_size=5, vad_filter=True,
                    initial_prompt="Olá, tudo bem? Hoje vamos falar sobre isso, com pontuação correta.")
                segmentos = list(segmentos)
                texto = " ".join(s.text.strip() for s in segmentos).strip()
            texto = texto or "(nenhuma fala detectada)"
            dur = fmt_tempo(info.duration)

            stem = video.stem
            (SAIDA / f"{stem}.txt").write_text(
                f"Arquivo: {video.name}\nDuracao: {dur}\n\n{texto}\n", encoding="utf-8")
            linhas = [f"[{fmt_tempo(s.start)} - {fmt_tempo(s.end)}] {s.text.strip()}" for s in segmentos]
            (SAIDA / f"{stem}.timestamps.txt").write_text(
                f"Arquivo: {video.name}\nDuracao: {dur}\n\n" + "\n".join(linhas) + "\n", encoding="utf-8")

            resultados.append((video.name, dur, texto))
            print(f"ok ({dur} de video, {time.time() - t0:.0f}s)")
        except Exception as e:
            print("FALHOU: " + " | ".join(str(e).splitlines())[:300])
            erros.append(f"{video.name}: {e}\n{traceback.format_exc()}")

    shutil.rmtree(tmp, ignore_errors=True)

    todos = SAIDA / "_todos.txt"
    blocos = [f"===== {nome} ({dur}) =====\n\n{texto}\n" for nome, dur, texto in resultados]
    todos.write_text("\n\n".join(blocos), encoding="utf-8")

    erros_txt = SAIDA / "_erros.txt"
    if erros:
        erros_txt.write_text("\n\n".join(erros), encoding="utf-8")
    elif erros_txt.exists():
        erros_txt.unlink()

    print(f"\nPronto: {len(resultados)} ok, {len(erros)} com erro.")
    print(f"Arquivo final: {todos}")
    if erros:
        print(f"Erros registrados em: {erros_txt}")


if __name__ == "__main__":
    main()
