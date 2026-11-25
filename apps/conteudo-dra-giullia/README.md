# Máquina de conteúdo · Dra. Giullia Campioni

Sistema que gera os posts do Instagram da **Dra. Giullia Campioni** (@giucampioni · CRO-PR 39945): carrossel, post único e stories, com o tom de voz, o público e a identidade visual dela, passando por uma revisão das regras de publicidade do CFO.

```
Pesquisador de pautas → Copywriter → Revisor CFO → Diretor de arte → aprovação da Giullia → postagem
   (temas da semana)    (texto + JSON)   (checa ética)    (PNG no template)
```

## Páginas
| Página | Para quê |
|---|---|
| [Ficha da Giullia](https://claude.ai/artifact/MCtt9NzFXpgToijNKMhpze) | **Fonte da verdade editável**: fatos e regras (título profissional, formação, atendimentos, limites). Quem tem acesso de edição altera direto; quem não tem copia uma sugestão para o WhatsApp. Antes de gerar conteúdo, a máquina confere a ficha e atualiza `marca/` se algo mudou. |
| [Design System](https://claude.ai/artifact/Ni4rgZQoPh1m5U4Ss6XEr7) | Cores, fontes, logo, fotos, ícones e os modelos de slide |
| [Briefing](https://claude.ai/artifact/SUhz5QZDc69kMETwdihcwG) | Formulário respondido pela cliente (nov/2026) |

## Estrutura
| Pasta | O que tem |
|---|---|
| `marca/` | Base de conhecimento, montada a partir do briefing respondido pela cliente: quem é ela, público, tom de voz, pilares e pautas, identidade visual, regras do CFO |
| `maquinas/` | Instruções (prompts) de cada uma das 4 máquinas |
| `templates/` | Template visual das artes (`estilo.css`) e montagem dos tipos de slide (`slides.js`) |
| `scripts/render.js` | Gera os PNGs a partir do JSON aprovado |
| `assets/` | Logos (preto e branco) e, futuramente, `fotos/` |
| `conteudos/` | Um post por pasta: `post.json` + `png/` gerado |

## Fase 1: usar no Claude (sem automação)
1. No claude.ai, crie um Projeto **"Dra. Giullia · Conteúdo"**.
2. Em *Conhecimento do projeto*, suba os 6 arquivos de `marca/` e os logos.
3. Em *Instruções do projeto*, cole: "Você trabalha no conteúdo da Dra. Giullia Campioni. Siga sempre os arquivos de marca. Nunca a chame de odontopediatra ou especialista."
4. Crie uma conversa por máquina e cole o arquivo de `maquinas/` correspondente como primeira mensagem:
   - **Pautas:** "pautas da semana 01/12"
   - **Copy:** cole a pauta escolhida → recebe o JSON + a legenda
   - **Revisão:** cole o JSON → recebe o status e o JSON corrigido
5. Salve o JSON aprovado em `conteudos/<data>-<tema>/post.json` e gere as artes (abaixo).

## Gerar as artes
Requer Node 20+ e Playwright (com o Chromium).
```bash
cd apps/conteudo-dra-giullia
npm install          # só na primeira vez (se o Playwright não estiver instalado)
npm run render -- conteudos/2026-12-carrossel-mitos/post.json
```
Saída: `conteudos/<pasta>/png/01.png …` (1080×1350, ou 1080×1920 em stories) + `legenda.txt`.
O script avisa se algum texto não coube no slide ou se as fontes não carregaram.

Tipos de slide disponíveis: `capa` (com ou sem `foto`), `mito` (pergunta e resposta: "É mito.", "Verdade." ou "Depende."), `texto` (com ou sem `foto`), `lista`, `final`. Esquema completo em `maquinas/02-copywriter.md`.

## Fase 2: automação (próximo passo)
- Pesquisa de pautas agendada toda semana (tarefa agendada no Claude) → pautas caem num quadro do Notion
- A Giullia aprova no Notion ou no WhatsApp → copy e revisão rodam pela API → PNGs gerados e anexados ao card
- Futuro: publicação agendada no Instagram via API da Meta

## Pendências
- [ ] A Giullia validar os carrosséis de exemplo (`conteudos/2026-12-carrossel-mitos` e `conteudos/2026-12-carrossel-primeira-consulta`), com atenção às afirmações clínicas
- [ ] Receber mais fotos dela e do consultório → `assets/fotos/` (por enquanto, as 2 do site)
- [ ] Fotos de banco (Unsplash/Pexels): precisam de uma chave de API ou de baixar manualmente
- [ ] Analisar os 10 posts de referência que ela enviou (ver `marca/05-identidade-visual.md`)
- [ ] Templates de stories com enquete e de post único com foto
