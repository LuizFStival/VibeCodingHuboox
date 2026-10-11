# Carteira IA

Lê os PDFs mensais de carteiras recomendadas (Ações, FIIs e Internacional), organiza as recomendações numa tela clara, pede ao **Gemini** uma segunda opinião com pesquisa na web, compara com a sua carteira e diz **onde colocar o próximo aporte**.

Site estático, igual ao `fatura-dashboard`: tudo roda no navegador, os dados ficam no `localStorage` e o Gemini é chamado direto do navegador com a **sua** chave.

## Rodar localmente

Node.js 20+, sem dependências.

```bash
cd apps/carteira-ia
npm start          # http://127.0.0.1:3334
npm test
```

Na Vercel: importe o repositório com **Root Directory** `apps/carteira-ia` e preset `Other` (o `vercel.json` já define a pasta `public/` e a CSP).

## Chave do Gemini

Crie uma chave gratuita em [aistudio.google.com/apikey](https://aistudio.google.com/apikey) e cole em **Configurações**. Ela fica só no navegador (não vai para o backup). O modelo padrão é `gemini-2.5-flash`; dá para trocar por `gemini-2.5-pro` (lê tabelas melhor) ou digitar outro.

## As etapas

| Aba | O que faz |
|---|---|
| **1 · Carteiras** | Suba os PDFs (pode ser os três de uma vez, ou arrastar). Tipo e mês vêm do nome do arquivo (`Carteira_Fiis_-_Outubro26.pdf` → FIIs, out/2026). As páginas viram imagens no navegador (pdf.js) e o Gemini extrai a tabela, as teses, as mudanças do mês, o contexto macro e o desempenho. Mostra pesos, DY, preço × preço teto, potencial, recomendação e gráficos por ativo e por segmento. **Corrigir dados** permite ajustar um número lido errado. |
| **2 · Análise IA** | Para um, dois ou os três relatórios do mês, o Gemini pesquisa cada ativo no Google Search: DRE, margens, ROE e dívida (ações); P/VP, DY, vacância, inadimplência e emissões (FIIs); resultados, ETFs, juros e câmbio (internacional). Devolve um veredito (concorda / em parte / discorda), uma recomendação própria, fundamentos, notícias, riscos e fontes. |
| **3 · Minha carteira** | Cadastre ou cole suas posições (`TICKER QTD [PREÇO MÉDIO] [PREÇO ATUAL]`). Mostra a distribuição por classe × alvo, seu peso × peso recomendado em cada ativo e alertas (recomendação de venda, IA discorda, ativo fora da carteira, recomendados que você não tem). |
| **4 · Aporte** | Informe o valor, os % alvo por classe e o dólar. O aporte vai primeiro para as classes mais abaixo do alvo e, dentro delas, para os ativos em **COMPRAR** mais abaixo do peso recomendado (opções: excluir onde a IA discorda, incluir AGUARDAR, fracionar internacional). Nada é vendido. Ações e FIIs em cotas inteiras. **Pedir opinião** manda o plano para o Gemini comentar. |

Cada mês fica separado (seletor no topo), o que mantém o histórico de relatórios.

## Estrutura

```
public/
  app.js              interface (sem build, texto sempre via textContent)
  core/report.js      modelo do relatório, detecção de tipo/mês, normalização
  core/prompts.js     prompts, schema de extração e normalização das respostas da IA
  core/gemini.js      cliente REST do Gemini (fetch injetável)
  core/portfolio.js   comparação e cálculo do aporte (funções puras)
  core/service.js     casos de uso
  core/store.js       localStorage + backup
  core/pdf.js         PDF → JPEG (pdf.js)
  vendor/pdfjs/       pdfjs-dist 4.10.38 (Apache-2.0)
test/                 testes com Gemini falso
```

## Privacidade e limites

- Os PDFs **não** são guardados: vão só para a API do Gemini, como imagens. Não versione os PDFs no repositório (costumam ter marca d'água com dados do assinante).
- A extração pode errar um número; confira a tabela e use **Corrigir dados** se precisar.
- É uma ferramenta de apoio, não recomendação de investimento.
