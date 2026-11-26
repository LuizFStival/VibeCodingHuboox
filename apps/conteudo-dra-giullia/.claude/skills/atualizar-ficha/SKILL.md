---
name: atualizar-ficha
description: Atualiza o que a máquina sabe sobre a Dra. Giullia (formação, título, atendimentos, regras, limites, datas). Use quando ela contar uma novidade sobre ela ou pedir para mudar uma informação ou regra.
---

# Atualizar a ficha

1. Leia `marca/ficha-giullia.json`.
2. Encontre o item que muda (ou a seção onde um item novo entra). Mostre para ela, em linguagem simples, **como está** e **como vai ficar**, e peça confirmação.
3. Com o ok: atualize o item no JSON (`atualizado_em` = hoje, `atualizado_por` = "Giullia") e o trecho correspondente em `marca/01` a `06`.
4. Se a mudança afetar uma regra (ex.: título de especialista registrado no CFO), atualize também `CLAUDE.md` e `maquinas/03-revisor-cfo.md`.
5. Salve no Git e confirme em uma frase o que mudou.
