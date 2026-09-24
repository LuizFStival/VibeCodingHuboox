// Banco do Brasil — AINDA NÃO IMPLEMENTADO (aparece como "em breve" na tela).
//
// Para ativar, com uma fatura de exemplo em mãos:
//   1. Ajuste COLUMNS com os nomes reais do cabeçalho do CSV do BB
//      (e o separador: o BB costuma exportar com ";").
//   2. Implemente parse() nos moldes de nubank.js, usando buildTransactions().
//   3. Ajuste monthFromFilename() ao padrão de nome do arquivo do BB.
//   4. Troque status para 'active' e adicione uma fixture + teste em test/.

export const bancoDoBrasil = {
  id: 'bb',
  name: 'Banco do Brasil',
  status: 'soon',
  help: 'Em breve. Assim que houver uma fatura modelo, a leitura do BB é ativada aqui.',

  monthFromFilename: () => null,
  detect: () => false,
  parse() {
    throw new Error('Importação do Banco do Brasil ainda não está disponível.');
  },
};
