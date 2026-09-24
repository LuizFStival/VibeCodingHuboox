# Fatura Dashboard

Plataforma local para analisar a fatura do cartão (CSV do Nubank) mês a mês: quanto gastou, em quê, quanto é parcela e quanto das próximas faturas já está comprometido.

## Rodar

Requer **Node.js 22.13+**. Não há dependências para instalar.

```bash
cd apps/fatura-dashboard
npm start          # http://127.0.0.1:3333
npm test           # testes de domínio + API
```

Os dados ficam em `data/financas.db` (SQLite, fora do git). Para fazer backup, basta copiar esse arquivo. Variáveis opcionais: `PORT`, `HOST` (padrão `127.0.0.1`, só local) e `DB_FILE`.

## Como usar

1. No app do Nubank: **Cartão → Faturas → escolha a fatura → Exportar (CSV)**.
2. Clique em **Subir fatura** ou arraste um ou mais `.csv` para a página. O mês vem do nome do arquivo (`Nubank_2026-10-02.csv` → fatura de out/2026) e pode ser ajustado antes de importar.
3. Reenviar o mesmo mês **substitui** os lançamentos daquela fatura, mas mantém as correções que você fez.

### Abas

| Aba | O que mostra |
|---|---|
| **Resumo** | Total da fatura e variação contra o mês anterior, parcelas, valor comprometido, ticket médio, maior gasto, leitura rápida com insights, ranking por categoria e por estabelecimento, gastos por dia e gastos recorrentes |
| **Lançamentos** | Lista completa com busca, filtro por categoria, tipo (à vista/parcelado/crédito), dia e período (esta fatura ou **todas**). Mostra o total filtrado ("quanto foi em Mercado?"). A categoria de cada linha pode ser editada |
| **Parcelas** | Cada compra parcelada: parcela atual/total, quanto falta, total da compra, quando termina. Gráfico do que já está comprometido nas próximas faturas |
| **Mês a mês** | Total por fatura com linha da média, mapa de calor categoria × mês, parcelas por mês, lista das faturas importadas |
| **Regras** | Regras aprendidas (estabelecimento → categoria), com opção de remover, e cadastro de novas categorias |

### Categorização (e como ela aprende)

A categoria é resolvida em três camadas, da mais forte para a mais fraca:

1. **Manual:** correção feita em um lançamento só.
2. **Regra:** correção salva para o estabelecimento. Vale para todas as faturas, inclusive as que você ainda vai subir.
3. **Automática:** palavras-chave embutidas (`src/domain/categorizer.js`).

Ao trocar a categoria na aba Lançamentos, a opção *"aplicar a todas as compras do mesmo estabelecimento"* (ligada por padrão) cria a regra. O estabelecimento é identificado por uma chave normalizada: sem acento, sem pontuação e sem o sufixo "- Parcela x/y". Assim, "Loja Virus - Parcela 6/10" e "Loja Virus - Parcela 7/10" contam como o mesmo estabelecimento.

Como a categoria é calculada na hora da leitura (e não gravada no lançamento), uma regra nova corrige o histórico inteiro.

## Arquitetura

```
server.js                 composição: repo + service + http
src/domain/               regras de negócio puras (sem I/O), 100% testáveis
  money.js                valores em centavos (inteiros): nada de erro de float
  merchant.js             parcela "x/y" + chave normalizada do estabelecimento
  parser.js               CSV → lançamentos; ids determinísticos por conteúdo
  categorizer.js          manual > regra > palavra-chave
  analytics.js            agregações do dashboard, projeção de parcelas, histórico
src/db/repository.js      SQLite nativo (node:sqlite), transações atômicas
src/service.js            casos de uso (importar, corrigir categoria, dashboard…)
src/http/server.js        API JSON + arquivos estáticos
public/                   front-end sem build (ES modules, SVG puro)
test/                     node:test: domínio e API ponta a ponta
```

Decisões:

- **Zero dependências.** Usa `node:http`, `node:sqlite` e `node:test`. Nada para atualizar, nada para quebrar.
- **Dinheiro em centavos.** Evita `0,1 + 0,2 ≠ 0,3` em somas de fatura.
- **Pagamentos e estornos** (valores negativos) não contam como gasto. Aparecem no filtro "Pagamentos/créditos".
- **Correções num lançamento sobrevivem à reimportação.** O id do lançamento é o hash de mês + data + descrição + valor + ocorrência, e as correções ficam numa tabela separada.
- **Só local.** O servidor escuta em `127.0.0.1` por padrão, e o front-end insere dados da fatura via `textContent` (sem `innerHTML`).

### API

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/months` | faturas importadas com total |
| `POST` | `/api/import?filename=&month=` | corpo = CSV cru |
| `GET` / `DELETE` | `/api/months/:AAAA-MM` | dashboard do mês / excluir fatura |
| `GET` | `/api/transactions[?month=]` | lançamentos (todos os meses sem `month`) |
| `PATCH` | `/api/transactions/:id` | `{ category, scope: "merchant" \| "single" }` |
| `GET` | `/api/history` | matriz mês × categoria |
| `GET` / `POST` | `/api/categories` | listar / criar (`{ name }`) |
| `GET` / `DELETE` | `/api/rules[/:merchantKey]` | regras aprendidas |

## Próximos passos possíveis

- Metas/orçamento por categoria com alerta ao estourar.
- Suporte a outros bancos (basta um parser novo em `src/domain/`).
- Exportar o histórico para CSV/Excel.
