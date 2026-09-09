# Recursos, em detalhe

## 1. Graphify

- Repo: https://github.com/Graphify-Labs/graphify
- O quê: CLI que lê o projeto inteiro (código via tree-sitter/AST local, docs/PDFs/imagens/vídeo via o modelo do próprio assistente) e monta um knowledge graph — não um índice vetorial, um grafo navegável de verdade.
- Quando usar: para entender rápido uma base de código desconhecida, achar o caminho entre dois conceitos, ou parar de fazer grep manual em projeto grande.
- Saída: `graphify-out/graph.html` (visual, clicável), `GRAPH_REPORT.md` (destaques), `graph.json` (o grafo cru).
- Instalar: `uv tool install graphifyy && graphify install`, depois `/graphify .` no chat.

## 2. frontend-design (anthropics/skills)

- Repo: https://github.com/anthropics/skills — skill em `skills/frontend-design/SKILL.md`
- O quê: skill oficial da Anthropic para trabalho de front-end/UI — orienta decisões de layout, componentes, acessibilidade e consistência visual.
- Quando usar: qualquer tarefa que mexa em UI/CSS/componentes visuais.
- Instalar: `/plugin marketplace add anthropics/skills` → `/plugin install example-skills@anthropic-agent-skills` (o plugin também traz outras skills de exemplo: algorithmic-art, brand-guidelines, canvas-design, doc-coauthoring, internal-comms, mcp-builder, skill-creator, slack-gif-creator, theme-factory, web-artifacts-builder, webapp-testing).
- Licença: Apache-2.0.

## 3. copywriting (coreyhaines31/marketingskills)

- Repo: https://github.com/coreyhaines31/marketingskills — skill em `skills/copywriting/SKILL.md`
- O quê: parte de uma coleção de ~50 skills de marketing técnico (CRO, copy, SEO, ads, e-mail, pricing, etc.). O `copywriting` cobre estrutura de texto persuasivo, headlines, CTAs.
- Quando usar: landing pages, e-mails, anúncios, qualquer texto cujo objetivo é converter.
- Instalar: `/plugin marketplace add coreyhaines31/marketingskills` → `/plugin install marketing-skills@marketingskills`.
- Licença: MIT.

## 4. Humanizer

- Repo: https://github.com/blader/humanizer
- O quê: reescreve texto com "cheiro de IA" para soar natural, sem mudar o que foi dito — remove os tiques característicos de texto gerado (excesso de "além disso", listas demais, entusiasmo genérico).
- Quando usar: antes de publicar qualquer texto gerado por IA voltado a leitor humano (posts, e-mails, descrições, respostas de suporte).
- Instalar: `/plugin marketplace add blader/humanizer` → `/plugin install humanizer@humanizer`.
- Licença: MIT.

## 5. semgrep/skills (segurança)

- Repo: https://github.com/semgrep/skills
- O quê: três skills geradas a partir das regras da Semgrep Engineering — `code-security` (OWASP Top 10, Terraform, Kubernetes, Docker, GitHub Actions, 15+ linguagens), `llm-security` (OWASP Top 10 para aplicações LLM: prompt injection, vazamento de dado sensível, supply chain de modelo) e `semgrep` (rodar scans e escrever regras Semgrep custom).
- Quando usar: escrevendo código novo, revisando PR, configurando infra como código, ou construindo qualquer coisa que fale com um LLM.
- Instalar: `npx skills add semgrep/skills`.
- Licença: Semgrep Rules License v1.0 (mais restritiva que MIT/Apache — por isso a recomendação aqui é sempre instalar da fonte, nunca vendorizar cópia).

## 6. Impeccable

- Repo: https://github.com/pbakaus/impeccable
- O quê, de verdade: **não é system design** (arquitetura de sistemas) — é fluência de design de front-end/UI. Detecta anti-padrões visuais (contraste, espaçamento, hierarquia, dimensões de pixel explícitas em vez de responsivas, etc.) e expõe 23 comandos (`/impeccable polish`, `/impeccable audit`, `/impeccable critique`...).
- Quando usar: no polish final de uma tela/UI, depois que a funcionalidade já está pronta — é complementar ao `frontend-design`, focado em crítica e detecção de erro, não em construção.
- Instalar: `/plugin marketplace add pbakaus/impeccable` → `/plugin install impeccable@impeccable`.

## 7. Vibe Coding Toolkit

- Repo: https://github.com/soumatheusgomes/vibe-coding-toolkit
- O quê: não é uma skill isolada, é uma metodologia de trabalho com agentes de IA em produção, com três peças centrais:
  - **Superpowers** (plugin): disciplina de explorar → planejar → só então codar, em vez de arriscar a primeira interpretação plausível.
  - **Orquestração de subagentes em ondas paralelas**: protocolo estrutural para eliminar colisão de arquivo e disputa de commit entre subagentes.
  - **Quality gates de ESLint/Biome**: promoção de warning para erro como migração rastreada, incluindo teto de linhas por arquivo.
  - Também inclui um `templates/CLAUDE.md.template` próprio e um playbook de onboarding ponta a ponta.
- Quando usar: como a "cola" do fluxo de trabalho do projeto inteiro, não como uma skill pontual.
- Instalar o Superpowers: `/plugin marketplace add anthropics/claude-plugins-official` → `/plugin install superpowers@claude-plugins-official`. O resto (orquestração, lint gates) é lido e aplicado manualmente a partir dos docs do repo.
- Licença: MIT.
