'use strict';

// As três esperas da integração — o que fazia ela parecer lenta.
//
// O ERP responde em ~230 ms e as rotas locais em ~3 ms: nada aqui é lento por
// rede. O que a pessoa sentia era QUANDO as coisas apareciam, e isso vinha de
// três decisões, cada uma com um teto próprio:
//
//   1. o cache do cofre só era buscado quando a primeira tela pedia. Como a
//      busca é assíncrona (de propósito: a tela não pode abrir esperando o ERP),
//      esse primeiro pedido sempre pegava o cache frio;
//   2. a janela só relia o estado a cada 10 s, então o resultado da busca acima
//      levava até dez segundos para virar pixel;
//   3. salvar um cofre novo não disparava busca nenhuma — a pessoa olhava para
//      uma lista sem os sistemas do cliente até o ciclo seguinte.
//
// Somadas, davam mais de dez segundos entre abrir o app e ver a mesa de
// trabalho do cliente. Este arquivo confere no fonte que as três continuam
// resolvidas: são decisões de ORDEM e de MOMENTO, e um teste de comportamento
// mediria o relógio da máquina em vez da regra.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

const raiz = path.join(__dirname, '..');
const servidor = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
const tela = fs.readFileSync(path.join(raiz, 'public', 'app.js'), 'utf8');
const dados = require('../lib/dadosdecofre');

// ---------- 1. o cache é aquecido quando o servidor sobe ----------

{
  const i = servidor.indexOf('const server = app.listen(');
  ok(i > 0, 'achei o listen do servidor');
  const bloco = servidor.slice(i, i + 2000);
  ok(/dadosDeCofre\.renovarSeVencido\(\)/.test(bloco),
    'o cofre é buscado JÁ na partida, e não na primeira tela: a janela leva ~1 s '
    + 'para aparecer e o ERP responde em ~0,5 s, então o primeiro /api/state já '
    + 'vem com os sistemas do cliente dentro');
  ok(/try \{[\s\S]{0,120}renovarSeVencido/.test(bloco),
    'e protegido: exceção dentro do callback de listen sobe sem dono e derruba o '
    + 'processo ANTES de a janela existir — o app não abriria, e sem mensagem');
}

// ---------- 2. salvar um cofre busca na hora ----------

{
  const i = servidor.indexOf("app.post('/api/cofres'");
  ok(i > 0, 'achei a rota que salva cofre');
  const bloco = servidor.slice(i, servidor.indexOf("app.delete('/api/cofres", i));
  ok(/dadosDeCofre\.renovarAgora\(apelido\)/.test(bloco),
    'salvar um cofre dispara a busca imediatamente — o segundo depois de salvar é '
    + 'justamente quando a pessoa mais quer ver o resultado');
  ok(/renovarAgora\(apelido\)\.catch/.test(bloco),
    'sem esperar: a resposta do formulário não fica presa no tempo do ERP');
}

// ---------- 3. os primeiros segundos da tela são apertados ----------

{
  const i = tela.indexOf('function iniciarAgenda(');
  ok(i > 0, 'achei iniciarAgenda');
  const bloco = tela.slice(i, i + 1600);
  ok(/}, 1000\);/.test(bloco),
    'os primeiros tiques são de 1 s, não de 10: se o ERP estiver lento, dez '
    + 'segundos com a tela na cara do usuário é lento de um jeito que ele sente');
  ok(/clearInterval\(tique\)/.test(bloco) && /INTERVALO_AGENDA_MS/.test(bloco),
    'e depois assenta no intervalo normal, para não virar tráfego eterno');
  ok(/apressados/.test(bloco), 'com um número FINITO de tiques apressados');
}

// ---------- 4. reler não pode redesenhar à toa ----------

{
  ok(/if \(sePrecisar && assinatura === assinaturaDoEstado\)/.test(tela),
    'o tique periódico sai calado quando nada mudou. Sem isso, apertar o '
    + 'intervalo para 1 s refaria a lista inteira uma vez por segundo e piscaria '
    + 'a tela na cara de quem está usando');
  ok(/async function loadState\(sePrecisar\)/.test(tela),
    'e quem chama depois de salvar alguma coisa NÃO passa a bandeira: redesenha '
    + 'sempre, mesmo que a assinatura por acaso não tenha mudado');
}

// ---------- 5. o custo continua desprezível ----------

{
  igual(dados.VALIDADE_MS, 2 * 60 * 1000,
    'o cache vale 2 minutos. Eram 5, pensados só no horário de atendimento (que '
    + 'muda em escala de dias) — mas os SISTEMAS entram na mesma renovação, e '
    + 'esses mudam quando o admin mexe no cadastro do cliente');

  // Duas requisições (ping + sistemas) por cofre por validade.
  const porMinuto = 2 / (dados.VALIDADE_MS / 60000);
  ok(porMinuto <= 2,
    `${porMinuto}/min por cofre — o limite do Homem Vitruviano é 120/min POR IP e `
    + 'do ERP inteiro, dividido com o navegador do próprio analista. Mesmo com '
    + 'dez pessoas atrás do mesmo NAT dá 10 de 120');
}

console.log(`\n${n} verificações passaram`);
