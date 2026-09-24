# Fatura Dashboard

Plataforma para analisar a fatura do cartão mês a mês: quanto gastou, em quê, quanto é parcela e quanto das próximas faturas já está comprometido.

**Bancos:** Nubank ✅ ativo · Banco do Brasil ⏳ em breve (aparece em cinza até existir uma fatura modelo).

É um **site estático**: toda a lógica roda no navegador e os dados ficam salvos nele (`localStorage`). Não há servidor, banco de dados nem login, e por isso dá para hospedar na Vercel de graça.

## Rodar localmente

Requer Node.js 20+. Não há dependências para instalar.

```bash
cd apps/fatura-dashboard
npm start          # http://127.0.0.1:3333
npm test           # testes (domínio + serviço)
```

## Hospedar na Vercel

Não tem etapa de build: a Vercel só publica a pasta `public/`. As configurações estão em `vercel.json`, que também define cabeçalhos de segurança (CSP).

**Pelo site (recomendado, com deploy automático a cada push):**

1. Em [vercel.com/new](https://vercel.com/new), importe o repositório do GitHub.
2. **Root Directory:** `apps/fatura-dashboard`
3. **Framework Preset:** `Other` (build e output já vêm do `vercel.json`)
4. Clique em **Deploy**. Você recebe uma URL `https://<nome>.vercel.app`.

**Pela linha de comando:**

```bash
cd apps/fatura-dashboard
npx vercel          # primeira vez: login + cria o projeto (preview)
npx vercel --prod   # publica em produção
```

### E a privacidade?

A URL pode ser pública sem problema: quem abrir o site vê um app vazio. Suas faturas só existem no navegador em que você importou, e nada é enviado para a Vercel nem para outro lugar.

Como consequência, **cada navegador/dispositivo tem os próprios dados**. Para levar do computador para o celular (ou guardar uma cópia), use **Regras & dados → Exportar backup** e depois **Restaurar backup** no outro aparelho. Limpar os dados do navegador apaga as faturas, por isso vale exportar o backup de vez em quando.

> Se um dia quiser sincronizar automaticamente entre dispositivos, o caminho é adicionar login + um banco gerenciado (ex.: Vercel + Neon/Turso) e trocar só o `core/store.js`. O resto do código não muda.

## Como usar

1. No app do Nubank: **Cartão → Faturas → escolha a fatura → Exportar fatura (CSV)**.
2. Clique em **Subir fatura** ou arraste um ou mais `.csv` para a página. Escolha o banco (vem detectado) e confira o mês. O mês vem do nome do arquivo: `Nubank_2026-10-02.csv` → fatura de out/2026.
3. Reenviar a fatura de um mês já importado **substitui** os lançamentos, mas mantém as suas correções.

### Abas

| Aba | O que mostra |
|---|---|
| **Resumo** | Total da fatura e variação contra o mês anterior, parcelas, valor comprometido, ticket médio, maior gasto, leitura rápida, ranking por categoria e por estabelecimento, gastos por dia e gastos recorrentes |
| **Lançamentos** | Lista completa com busca e filtros por categoria, tipo (à vista/parcelado/crédito), dia e período (esta fatura ou **todas**). Mostra o total filtrado ("quanto foi em Mercado?"). A categoria de cada linha pode ser editada |
| **Parcelas** | Cada compra parcelada: parcela atual/total, quanto falta, total da compra, quando termina. Gráfico do que já está comprometido nas próximas faturas |
| **Mês a mês** | Total por fatura com linha da média, mapa de calor categoria × mês, faturas importadas (com o banco de cada uma) |
| **Regras & dados** | Regras aprendidas, cadastro de categorias, exportar/restaurar backup |

### Categorização (e como ela aprende)

A categoria é resolvida em três camadas, da mais forte para a mais fraca:

1. **Manual:** correção feita em um lançamento só.
2. **Regra:** correção salva para o estabelecimento. Vale para todas as faturas, inclusive as que você ainda vai subir.
3. **Automática:** palavras-chave embutidas (`core/categorizer.js`).

Ao trocar a categoria na aba Lançamentos, a opção *"aplicar a todas as compras do mesmo estabelecimento"* (ligada por padrão) cria a regra. O estabelecimento é identificado por uma chave normalizada: sem acento, sem pontuação e sem o sufixo "- Parcela x/y". Como a categoria é calculada na hora da leitura, uma regra nova corrige o histórico inteiro.

## Arquitetura

```
public/                      ← tudo que a Vercel publica
  index.html, styles.css
  app.js                     UI (sem framework, sem build)
  core/                      regras de negócio puras — rodam no navegador e nos testes
    banks/
      index.js               registro de bancos
      nubank.js              leitor do CSV do Nubank (ativo)
      bancodobrasil.js       esqueleto do BB (status "soon")
    csv.js                   CSV, datas e montagem do lançamento (comum a todos os bancos)
    money.js                 valores em centavos (inteiros): nada de erro de float
    merchant.js              parcela "x/y" + chave normalizada do estabelecimento
    categorizer.js           manual > regra > palavra-chave
    analytics.js             agregações, projeção de parcelas, histórico
    service.js               casos de uso (importar, corrigir categoria, dashboard, backup)
    store.js                 persistência (localStorage) — único ponto a trocar p/ nuvem
    hash.js                  id estável dos lançamentos
scripts/serve.js             servidor estático só para rodar local
vercel.json                  config de deploy + cabeçalhos de segurança
test/                        node:test
```

Decisões:

- **Uma fatura = banco + mês.** O dashboard de um mês soma as faturas de todos os bancos daquele mês. Quando o BB entrar, os dois cartões aparecem juntos.
- **Dinheiro em centavos.** Evita `0,1 + 0,2 ≠ 0,3` em somas de fatura.
- **Pagamentos e estornos** (valores negativos) não contam como gasto.
- **Correções sobrevivem à reimportação.** O id do lançamento é o hash de banco + mês + data + descrição + valor + ocorrência.
- **Segurança:** dados da fatura entram na tela só via `textContent` (sem `innerHTML`), e a CSP bloqueia scripts de terceiros.

## Ativar o Banco do Brasil

Com uma fatura CSV do BB em mãos:

1. Salve um exemplo anonimizado em `test/fixtures/`.
2. Em `public/core/banks/bancodobrasil.js`: mapeie as colunas (o BB costuma usar `;` como separador, e `parseCsv(text, ';')` já suporta isso), implemente `parse()` usando `buildTransactions()` (veja `nubank.js`), ajuste `monthFromFilename()` e `detect()`.
3. Troque `status: 'soon'` para `'active'`. O cartão do BB deixa de ficar cinza automaticamente.
4. Adicione um teste em `test/domain.test.js`.
