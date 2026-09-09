#!/usr/bin/env bash
# Instala o Graphify e registra o skill /graphify no assistente de IA configurado no diretorio atual.
# Uso: ./install-graphify.sh
set -euo pipefail

if command -v uv >/dev/null 2>&1; then
  uv tool install graphifyy
elif command -v pipx >/dev/null 2>&1; then
  pipx install graphifyy
else
  echo "Instale uv (https://docs.astral.sh/uv/) ou pipx antes de rodar este script." >&2
  exit 1
fi

graphify install

echo "Pronto. Dentro do projeto, no chat do assistente, rode: /graphify ."
