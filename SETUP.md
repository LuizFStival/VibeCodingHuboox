# Setup — aplicar a coletânea em um projeto novo

Rode isto dentro do projeto novo. Comandos que começam com `/` são **slash commands do Claude Code** (colar no chat, não no shell); os demais são shell.

## 1. Plugins do Claude Code

Cole um bloco de cada vez no chat do Claude Code:

```
/plugin marketplace add anthropics/skills
/plugin install example-skills@anthropic-agent-skills
```

```
/plugin marketplace add coreyhaines31/marketingskills
/plugin install marketing-skills@marketingskills
```

```
/plugin marketplace add blader/humanizer
/plugin install humanizer@humanizer
```

```
/plugin marketplace add pbakaus/impeccable
/plugin install impeccable@impeccable
```

```
/plugin marketplace add anthropics/claude-plugins-official
/plugin install superpowers@claude-plugins-official
```

> `example-skills` traz o `frontend-design` junto com outras skills de exemplo da Anthropic. `marketing-skills` traz o `copywriting` junto com as outras ~50 skills de marketing do Corey Haines. Não há como instalar só a skill isolada via marketplace — é o plugin inteiro.

## 2. Segurança — Semgrep (via npx, fora do Claude Code)

```bash
npx skills add semgrep/skills
```

Isso traz três skills: `code-security` (OWASP Top 10 + infra), `llm-security` (OWASP Top 10 para apps LLM) e `semgrep` (rodar/escrever regras Semgrep).

## 3. Graphify — CLI standalone

```bash
uv tool install graphifyy      # ou: pipx install graphifyy
graphify install               # registra o skill /graphify no seu assistente
```

Depois, no chat do Claude Code, dentro do projeto:

```
/graphify .
```

Também dá para rodar tudo de uma vez com [`scripts/install-graphify.sh`](scripts/install-graphify.sh).

## 4. Template de projeto

Copie o template de `CLAUDE.md` deste repo para a raiz do projeto novo:

```bash
cp /caminho/para/VibeCodingHuboox/templates/CLAUDE.md.template ./CLAUDE.md
```

Marque no checklist do arquivo o que foi de fato instalado nesse projeto (nem todo projeto precisa dos 7).

## 5. Metodologia (Vibe Coding Toolkit)

O Superpowers já foi instalado no passo 1. O resto do toolkit — orquestração de subagentes em ondas paralelas, quality gates de ESLint/Biome — é doc, não plugin. Vale ler direto na fonte quando o projeto crescer:

- Onboarding completo: https://github.com/soumatheusgomes/vibe-coding-toolkit/blob/main/docs/02-playbook-onboarding.md
- Orquestração de subagentes: https://github.com/soumatheusgomes/vibe-coding-toolkit/blob/main/docs/tools/02-subagent-orchestration.md
- Quality gates de lint: https://github.com/soumatheusgomes/vibe-coding-toolkit/blob/main/docs/tools/06-eslint-biome-quality-gates.md
