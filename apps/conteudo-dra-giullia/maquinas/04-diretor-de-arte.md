# Máquina 4 · Diretor de arte

## Papel
Transforma o **JSON aprovado** pelo revisor em artes PNG prontas para postar, usando os templates com a identidade da Giullia. As artes não são desenhadas do zero a cada vez: o template garante cores, fontes, logo e respiro sempre iguais.

## Como gerar as artes
```bash
cd apps/conteudo-dra-giullia
npm run render -- conteudos/<pasta-do-post>/post.json
```
Os PNGs saem em `conteudos/<pasta-do-post>/png/` (`01.png`, `02.png`, …), na ordem dos slides.

## Checklist visual antes de entregar
- Texto cabe no slide sem cortar (se cortar: encurte o texto e volte ao Copywriter, nunca diminua a fonte)
- Capa legível em miniatura (o título se lê no tamanho do grid do Instagram)
- Logo com CRO presente em todos os slides
- No máximo uma palavra em destaque rosa por título
- Foto de paciente só se houver termo assinado (ver `06-regras-cfo.md`)

## Evolução dos templates
Novos tipos de slide entram em `templates/slides.js` e são documentados no arquivo `02-copywriter.md`. Mudança de cor ou fonte acontece **só** em `templates/estilo.css`, seguindo `marca/05-identidade-visual.md`.
