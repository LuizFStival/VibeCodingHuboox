# Carteira IA

Lê os PDFs mensais de carteiras recomendadas (Ações, FIIs e Internacional), organiza as recomendações numa tela clara, pede ao **Gemini** uma segunda opinião com pesquisa na web, compara com a sua carteira e diz **onde colocar o próximo aporte**.

Site estático, igual ao `fatura-dashboard`: tudo roda no navegador, os dados ficam no `localStorage` e o Gemini é chamado direto do navegador com a **sua** chave.

## Rodar no Windows sem instalar nada

Dê dois cliques em **`Abrir Carteira IA (Windows).bat`**. Ele usa o PowerShell que já vem no Windows para abrir o app em http://localhost:3334 no navegador. Deixe a janela preta aberta enquanto usa e feche-a para parar.

## Rodar localmente (com Node.js)

Node.js 20+, sem dependências.

```bash
cd apps/carteira-ia
npm start          # http://127.0.0.1:3334
npm test
```

Na Vercel: importe o repositório com **Root Directory** `apps/carteira-ia` e preset `Other` (o `vercel.json` já define a pasta `public/` e a CSP).

## Chave do Gemini

Crie uma chave gratuita em [aistudio.google.com/apikey](https://aistudio.google.com/apikey) e cole em **Configurações**. Ela fica só no navegador (não vai para o backup). O modelo padrão é `gemini-flash-latest`, que sempre aponta para o Flash mais novo. Se o Google desativar o modelo escolhido, o app troca sozinho pelo que a API recomenda e avisa.

## As etapas

| Aba | O que faz |
|---|---|
| **1 · Carteiras** | Suba os PDFs (pode ser os três de uma vez, ou arrastar). Tipo e mês vêm do nome do arquivo (`Carteira_Fiis_-_Outubro26.pdf` → FIIs, out/2026). As páginas viram imagens no navegador (pdf.js) e o Gemini extrai a tabela, as teses, as mudanças do mês, o contexto macro e o desempenho. Mostra pesos, DY, preço × preço teto, potencial, recomendação e gráficos por ativo e por segmento. **Corrigir dados** permite ajustar um número lido errado. |
| **2 · Análise IA** | **Copiar e colar (padrão, grátis):** o app monta o pedido de cada carteira; você cola no Gemini ou ChatGPT do site, que pesquisam na web sem custo, e cola a resposta de volta. Se o chat cortar a resposta, o próximo pedido inclui só os ativos que faltam. **Automático pela API:** exige faturamento no Google AI Studio para a pesquisa na web. |
| **2 · Análise IA (detalhe)** | Para um, dois ou os três relatórios do mês, o Gemini pesquisa cada ativo no Google Search: DRE, margens, ROE e dívida (ações); P/VP, DY, vacância, inadimplência e emissões (FIIs); resultados, ETFs, juros e câmbio (internacional). Devolve um veredito (concorda / em parte / discorda), uma recomendação própria, fundamentos, notícias, riscos e fontes. |
| **3 · Minha carteira** | Cadastre ou cole suas posições (`TICKER QTD [PREÇO MÉDIO] [PREÇO ATUAL]`). Mostra a distribuição por classe × alvo, seu peso × peso recomendado em cada ativo e alertas (recomendação de venda, IA discorda, ativo fora da carteira, recomendados que você não tem). |
| **4 · Aporte** | Informe o valor, os % alvo por classe e o dólar. O aporte vai primeiro para as classes mais abaixo do alvo e, dentro delas, para os ativos em **COMPRAR** mais abaixo do peso recomendado (opções: excluir onde a IA discorda, incluir AGUARDAR, fracionar internacional). Nada é vendido. Ações e FIIs em cotas inteiras. **Dólar já na corretora (US$):** o caixa parado no exterior (Nomad, Avenue…) paga o internacional e conta no patrimônio; os reais do aporte ficam para ações e FIIs (opção de enviar reais se faltar lá fora, com IOF e spread). **Pedir opinião** manda o plano para o Gemini comentar. |

Cada mês fica separado (seletor no topo), o que mantém o histórico de relatórios.

### Do relatório ao aporte (fluxo do mês)

1. **Carteiras:** sobe os PDFs; a IA lê e o cartão "Conferir a leitura" valida.
2. **Análise:** pesquisa de cada ativo (copiar e colar com o GPT/Gemini do site, que pesquisam na web). Em seguida aparece o **Ranking do mês** — nota 0-100 (recomendação da casa + leitura da pesquisa + margem até o teto + DY) em Oportunidades, Potenciais, Aguardar e Em risco — e o **Parecer do mês** (Claude do painel, ou o GPT por copiar e colar).
3. **Minha carteira:** patrimônio, **Diagnóstico** de cada posição cruzado com o ranking (concentração, acima do teto, em risco) e a **Análise da carteira pela IA**; o balanço mensal guarda a evolução.
4. **Aporte:** perfil de alocação + valor → **Propor aporte** (cada compra com o motivo; os ativos de fora aparecem com a explicação) → **Opinião final da IA**. Os pareceres ficam salvos no mês.

## Conferir a leitura do PDF e velocidade

- Cada página vai para a IA com o rótulo "Página N"; ela informa em que página achou cada ativo. O app guarda a imagem da página da tabela e mostra, no topo de cada carteira, o cartão **Conferir a leitura**: modelo usado, tempo, páginas enviadas, verificações automáticas (pesos somam ~100%, preços e tetos presentes, valores fora do normal, códigos estranhos) e o botão **Ver página original da tabela** para comparar com o que foi extraído.
- **Leitura rápida (padrão):** só as 8 primeiras páginas (tabela, resumo, mudanças e desempenho), com o raciocínio do modelo reduzido e os PDFs lidos em paralelo. Se a tabela não fechar nessas páginas, o app lê o PDF inteiro automaticamente. **Leitura completa** (opção ao subir) inclui a tese de cada ativo.

## Limites da API e erros

O plano gratuito do Gemini tem limites baixos de requisições por minuto e por dia, e a análise faz cerca de uma chamada a cada 5 ativos. Para não estourar:

- as chamadas saem **uma por vez**, com intervalo mínimo entre elas;
- se a API responder **429 (limite por minuto)** ou instabilidade (5xx), o app espera o tempo que a própria API indica e tenta de novo (até 4 vezes), mostrando a espera na barra de progresso;
- se a **cota diária** acabar, a análise para na hora (não adianta insistir), guarda o que já veio e mostra **Continuar de onde parou** no cartão da carteira;
- se o modelo responder em texto em vez de JSON, uma segunda chamada (sem pesquisa) organiza o texto;
- cada ativo indica se a resposta veio **com ou sem pesquisa na web**;
- se a **pesquisa do Google** não tiver cota na sua chave (no plano gratuito ela costuma ter cota zero nos modelos novos), a análise segue sem pesquisa, só com o conhecimento do modelo. Para ter a pesquisa, ative o faturamento no Google AI Studio.

Em **Configurações** há três testes: conexão, pesquisa na web (Google Search) e a lista dos modelos disponíveis para a sua chave. O erro completo da API aparece ali e no cartão da análise.

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
