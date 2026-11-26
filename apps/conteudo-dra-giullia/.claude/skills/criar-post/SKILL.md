---
name: criar-post
description: Cria um post completo da Dra. Giullia (carrossel, post único ou stories): texto no tom dela, revisão das regras do CFO, artes em PNG, legenda e PDF editável para o Canva. Use quando ela pedir para criar, montar ou fazer um post, carrossel, story ou arte sobre um tema.
---

# Criar post

## 1. Entender o pedido
Tema, formato (carrossel é o padrão) e se ela quer foto. Se faltar algo essencial, pergunte UMA vez, em uma frase. Senão, siga.

## 2. Escrever (máquina Copywriter)
Siga `maquinas/02-copywriter.md` e `marca/03-tom-de-voz.md`. Monte o `post.json` em `conteudos/AAAA-MM-<tema-curto>/post.json`.
- Fotos: use só arquivos que existem em `assets/fotos/`. Capa com foto → título de até 6 palavras.
- Ilustração na capa: `"ilustracao": "<nome>"` com um arquivo de `templates/ilustracoes/`.
- Alterne estilos no feed: veja os últimos posts em `conteudos/` e não repita o mesmo estilo de capa três vezes seguidas.

## 3. Revisar (máquina Revisor CFO)
Aplique `maquinas/03-revisor-cfo.md` ao JSON. Corrija o que der. Se algo depender dela (afirmação clínica), anote para perguntar no fim.

## 4. Gerar as artes
`npm run render -- conteudos/<pasta>/post.json`. Se avisar texto cortado, encurte o texto e gere de novo (nunca diminua a fonte).

## 5. Entregar
Mostre os PNGs (envie os arquivos), cole a legenda pronta e diga onde está o PDF para o Canva. Em seguida, em poucas linhas:
- o que precisa do ok dela (informação clínica, foto de paciente);
- "Quer mudar alguma coisa? Pode falar do seu jeito, tipo: 'troca o título do slide 2'."

Ajustes: edite o `post.json`, gere de novo e mostre só os slides que mudaram. Quando ela aprovar, mude `"status"` para `"aprovado"` e salve no Git.
