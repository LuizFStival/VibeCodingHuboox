# transcrever-reels

Transcreve a fala de vídeos .mp4 (pt-BR) **localmente** com faster-whisper (modelo `small`).
Depois do 1º download do modelo (~460 MB), nada sai do seu computador.

## Instalar (uma vez) — Windows (PowerShell)

```powershell
winget install --id Gyan.FFmpeg -e
winget install --id Python.Python.3.12 -e
```
Feche e reabra o PowerShell. Depois, dentro desta pasta:
```powershell
py -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
```
(macOS/Linux: `brew install ffmpeg` / `sudo apt install ffmpeg`, depois `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`)

## Usar

1. Coloque os .mp4 em `videos\` (ou passe outra pasta como argumento).
2. Teste com 1 vídeo: `.\.venv\Scripts\python transcrever.py --limite 1`
3. Rode todos: `.\.venv\Scripts\python transcrever.py`
   - outra pasta: `.\.venv\Scripts\python transcrever.py "C:\Users\voce\Downloads\reels"`

## Saída (`saida\`)

- `<video>.txt` — nome, duração, texto corrido
- `<video>.timestamps.txt` — mesmo texto com `[mm:ss - mm:ss]`
- `_todos.txt` — tudo junto, em ordem alfabética, com título por vídeo
- `_erros.txt` — só aparece se algum vídeo falhar (os outros continuam)
