# Carteira IA

Lê os PDFs mensais de carteiras recomendadas (Ações, FIIs e Internacional), pesquisa cada ativo com IA, compara com a sua carteira e diz **onde colocar o aporte do mês**, respeitando o seu perfil, o "aguardar" da casa e da pesquisa, o dólar que já está no exterior e o envio mínimo da corretora.

**Guia de uso todo mês:** [docs/GUIA-DO-MES.md](docs/GUIA-DO-MES.md)

## Onde abrir

| Jeito | Para quem | Onde ficam os dados |
|---|---|---|
| **Painel do Claude** (Artifact privado) | uso do dia a dia, em qualquer aparelho | na sua conta do Claude, numa área que só você lê |
| **Windows:** dois cliques em `Abrir Carteira IA (Windows).bat` | usar no computador, sem instalar nada | só neste navegador (`localStorage`) |
| **Node.js 20+:** `npm start` → http://127.0.0.1:3334 | desenvolvimento | só neste navegador |

O código fica num repositório público, mas **nenhum valor seu vai para o código**: posições, aportes e senha ficam só no armazenamento de quem usa.

## Privacidade

- **Senha** (Configurações → Senha e privacidade): o app pede a senha ao abrir e depois de um tempo parado (5 min a 1 h, ou nunca). Fica guardado só um hash PBKDF2, nunca a senha. É uma trava contra olhares curiosos, não criptografia dos dados.
- **Ocultar valores** (botão no topo): reais, dólares e quantidades viram `•••`, inclusive nos campos; porcentagens e nomes continuam. Há a opção de abrir sempre oculto.
- Esqueceu a senha? No painel, peça ao Claude no chat para removê-la. No navegador, restaure um backup.

## As etapas

| Aba | O que faz |
|---|---|
| **1 · Carteiras** | Passo a passo do mês e os PDFs lidos pela IA (tipo e mês vêm do nome do arquivo). O cartão **Conferir a leitura** mostra as verificações e a página original da tabela. |
| **2 · Análise IA** | Pesquisa de cada ativo (no painel, pelo Claude; ou copiando e colando com o GPT/Gemini do site, que pesquisam na web). Depois, o **Ranking do mês** (nota 0–100) e o parecer da IA. |
| **3 · Minha carteira** | Patrimônio por classe e segmento, diagnóstico de cada posição, balanço mensal, **histórico de aportes** e as posições (edite ou cole). |
| **4 · Aporte** | Perfil de alocação, valor, dólar na corretora, caixinha do dólar e envio mínimo → **Propor aporte** → ajustes → **Registrar as compras** (as posições, o caixa e o balanço se atualizam) → opinião final da IA. |

### Regras do aporte

- Vai primeiro para as classes e os segmentos mais abaixo do alvo; dentro do segmento, reforça o que você já tem antes de abrir posição nova (no máximo N novas por mês).
- Nunca compra o que a casa manda **aguardar**; o "aguardar" da pesquisa vira "atenção".
- Não compra acima do preço teto nem onde a pesquisa (com web) discorda.
- Internacional: o dólar já na corretora compra direto; a parte em reais junta na **caixinha do dólar** até passar do envio mínimo (Nomad: US$ 50) e então o app propõe enviar tudo.
- Ações e FIIs em cotas inteiras; internacional fracionado. Nada é vendido.

## Estrutura

```
apps/carteira-ia/
  public/                 o app (sem build): index.html, app.js (interface), styles.css
    core/report.js        modelo do relatório, tipo/mês pelo nome do arquivo, conferências
    core/prompts.js       pedidos para a IA (leitura, pesquisa, pareceres)
    core/ranking.js       nota 0–100 e grupos do ranking
    core/portfolio.js     comparação com a carteira e cálculo do aporte (funções puras)
    core/service.js       casos de uso (relatórios, análises, posições, aportes, balanço)
    core/store.js         armazenamento local + backup
    core/db-storage.js    armazenamento no banco do painel do Claude
    core/lock.js          senha (hash) e "ocultar valores"
    core/claude-ai.js     IA do painel do Claude
    core/gemini.js        API do Gemini (opcional, fora do painel)
    core/pdf.js           PDF → imagens (pdf.js em vendor/)
  scripts/                servidor local (Node e PowerShell) e build do painel (build-artifact.mjs)
  test/                   testes (npm test)
  docs/                   guia do mês
  reels/                  vídeo de divulgação (canvas + narração)
```

## Desenvolvimento

```bash
cd apps/carteira-ia
npm test                          # testes do núcleo
npm start                         # app local em http://127.0.0.1:3334
node scripts/build-artifact.mjs   # gera dist-artifact/ para o painel do Claude
```

### API do Gemini (opcional)

Fora do painel, dá para usar uma chave do Gemini ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)) em Configurações. Ela fica só no navegador e não vai para o backup. O plano gratuito tem limites baixos e, nos modelos novos, costuma não ter cota de pesquisa na web; por isso o fluxo padrão é o copiar e colar.

## Limites

- A leitura pode errar um número: confira no cartão da leitura e use **Corrigir dados**.
- Não versione os PDFs (têm marca d'água com dados do assinante).
- Ferramenta de apoio, não recomendação de investimento.
