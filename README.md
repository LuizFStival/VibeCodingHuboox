# Vibe Coding Huboox

Coletânea curada de skills e ferramentas para IA de código, pronta para ser aplicada em **todo projeto novo**. Em vez de copiar arquivos de terceiros para dentro deste repo (o que desatualiza rápido e complica licenças), cada recurso é referenciado na fonte oficial e instalado sob demanda — este repo é o **catálogo + o roteiro de bootstrap**.

## O catálogo

| # | Recurso | Especialidade | Como é instalado |
|---|---------|----------------|-------------------|
| 1 | [Graphify](https://github.com/Graphify-Labs/graphify) | Mapeia o projeto inteiro (código, docs, PDFs, imagens, vídeos) num knowledge graph consultável | CLI standalone (`uv tool install`) |
| 2 | [frontend-design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md) (anthropics/skills) | Front-end / UI | Plugin do Claude Code |
| 3 | [copywriting](https://github.com/coreyhaines31/marketingskills/blob/main/skills/copywriting/SKILL.md) (marketingskills) | Copywriting / conversão | Plugin do Claude Code |
| 4 | [Humanizer](https://github.com/blader/humanizer) | Humanização de texto — tira o "cheiro de IA" sem mudar o conteúdo | Plugin do Claude Code |
| 5 | [semgrep/skills](https://github.com/semgrep/skills) | Segurança (OWASP Top 10, código, infra, LLM) | `npx skills add` |
| 6 | [Impeccable](https://github.com/pbakaus/impeccable) | Fluência de design de UI/front-end (polish visual e anti-padrões), não arquitetura de sistema | Plugin do Claude Code |
| 7 | [Vibe Coding Toolkit](https://github.com/soumatheusgomes/vibe-coding-toolkit) | Metodologia de trabalho com IA: Superpowers, orquestração de subagentes, quality gates de lint, template de `CLAUDE.md` | Plugin (Superpowers) + docs/templates a seguir |

Detalhes de cada um (quando usar, o que exatamente instala, links de referência) estão em [`docs/resources.md`](docs/resources.md).

> Nota sobre o #6: o link original foi descrito como "system design", mas o Impeccable é sobre fluência de **design de front-end/UI** (detecção de anti-padrões visuais, `/impeccable audit`, `/impeccable critique`, etc.), não sobre arquitetura de sistemas.

## Como usar em um projeto novo

Siga [`SETUP.md`](SETUP.md) — é a lista exata de comandos, na ordem certa, para rodar dentro do Claude Code (ou do shell, onde indicado). No fim, copie [`templates/CLAUDE.md.template`](templates/CLAUDE.md.template) para a raiz do projeto novo como `CLAUDE.md` e ajuste o checklist de skills instaladas.

Resumo do fluxo:

1. Adicionar os marketplaces e instalar os plugins (frontend-design, copywriting, humanizer, impeccable, Superpowers).
2. Instalar o Graphify (CLI) e o pacote de skills de segurança do Semgrep (`npx skills add`).
3. Copiar o template de `CLAUDE.md` para o projeto e preencher o checklist do que foi instalado.
4. Rodar `/graphify .` uma vez para gerar o mapa do projeto.

## Por que não vendorizar os arquivos?

- Todos os 7 recursos já têm um mecanismo oficial de distribuição (marketplace de plugin do Claude Code, `npx skills add`, ou instalador de CLI). Copiar os arquivos duplicaria conteúdo que os próprios autores mantêm atualizado.
- Licenças variam (Apache-2.0, MIT, e a Semgrep Rules License, mais restritiva) — instalar direto da fonte evita qualquer ambiguidade de redistribuição.
- Atualizações upstream (novas regras de segurança, novos padrões de design) chegam automaticamente da próxima vez que o plugin/skill for atualizado, sem esse repo precisar sincronizar nada.
