'use strict';

// Testes do horário de um host — as duas fontes e o cache que as alimenta.
//
// A pergunta "este host precisa estar aberto agora?" tem duas respostas
// possíveis (a agenda digitada no host e a janela de atendimento do cliente,
// vinda do ERP), formatos diferentes, e QUATRO lugares no app que perguntam.
// Este arquivo trava três coisas que falham em silêncio:
//
//   1. quem manda quando as duas existem. Se a janela do cofre passasse por
//      cima, uma agenda digitada à mão seria ignorada sem nenhum aviso;
//   2. o cache NUNCA pode bloquear e NUNCA pode apagar o que já sabe. O ERP
//      caindo às 14h não muda o horário de atendimento do cliente — mas apagar
//      a janela destravaria todas as abas de uma vez;
//   3. um cofre que não tem o conceito de cliente não pode ser consultado por
//      causa disso: seria gastar requisição para receber um campo inexistente.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-horario-'));
process.env.SSHC_DATA_DIR = DIR;

const horario = require('../public/horario');
const fake = require('./vitruviano-local');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const naoOk = (c, m) => { assert.ok(!c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// 2026-08-10 é segunda. 15:00Z = 12:00 em Brasília.
const SEGUNDA_MEIO_DIA = new Date('2026-08-10T15:00:00Z');
const DOMINGO_MADRUGADA = new Date('2026-08-16T06:00:00Z');

const janela24h = { fuso: '-03:00', turnos: [
  { diaInicio: 0, inicio: '00:00', diaFim: 6, fim: '23:59' }] };
const janelaComercial = { fuso: '-03:00', turnos: [
  { diaInicio: 0, inicio: '08:00', diaFim: 4, fim: '18:00' }] };

// ---------- 1. as duas fontes, e quem manda ----------

{
  const soAgenda = { agenda: { inicio: '08:00', fim: '18:00' } };
  igual(horario.fonteDeHorario(soAgenda).tipo, 'agenda', 'host só com agenda usa a agenda');
  ok(horario.noHorario(soAgenda, SEGUNDA_MEIO_DIA), 'e ao meio-dia está no horário');

  const soCofre = { janelaDoCofre: { cliente: 'Velonic', janela: janela24h } };
  igual(horario.fonteDeHorario(soCofre).tipo, 'cofre',
    'host sem agenda usa o horário de atendimento do cliente — é o recurso que '
    + 'faz o sistema do cliente abrir sozinho sem ninguém digitar horário');
  ok(horario.noHorario(soCofre, DOMINGO_MADRUGADA), 'cliente 24h atende de madrugada');

  const semNada = { name: 'host comum' };
  naoOk(horario.temHorario(semNada), 'host comum não tem horário nenhum');
  naoOk(horario.noHorario(semNada, SEGUNDA_MEIO_DIA), 'e nunca está "no horário"');
  igual(horario.fimDoHorario(semNada, SEGUNDA_MEIO_DIA), null, 'nem tem fim de horário');
  igual(horario.descreverHorario(semNada), '', 'nem etiqueta');
  igual(horario.motivoDoHorario(semNada, SEGUNDA_MEIO_DIA), '',
    'e nenhum motivo de trava — senão a aba de um host comum ficaria sem "×"');
}

{
  // O caso que decide o desenho: as DUAS fontes no mesmo host.
  const ambas = {
    agenda: { inicio: '22:00', fim: '02:00' },
    janelaDoCofre: { cliente: 'Velonic', janela: janela24h },
  };
  igual(horario.fonteDeHorario(ambas).tipo, 'agenda',
    'a agenda DIGITADA manda sobre a janela do cliente — configuração escrita à '
    + 'mão que o sistema ignora em silêncio é pior do que não existir');
  naoOk(horario.noHorario(ambas, SEGUNDA_MEIO_DIA),
    'ao meio-dia a agenda (22:00–02:00) diz que não, mesmo com o cliente 24h dizendo que sim');
  ok(horario.descreverHorario(ambas).includes('22:00'),
    'e a etiqueta mostra a agenda, que é o que está valendo');
}

// ---------- 2. a etiqueta diz DE ONDE veio ----------

{
  const doCofre = { janelaDoCofre: { cliente: 'Maylink', janela: janelaComercial } };
  const texto = horario.descreverHorario(doCofre);
  ok(texto.includes('Maylink'),
    'a etiqueta nomeia o cliente — sem isso, "por que este host abriu sozinho?" '
    + 'não tem resposta na tela, e nem onde ir mexer');

  const motivo = horario.motivoDoHorario(doCofre, SEGUNDA_MEIO_DIA);
  ok(motivo.includes('atendimento') && motivo.includes('Maylink'),
    'e o cadeado explica que é o horário de atendimento do cliente');
  ok(!motivo.includes('agenda deste host'),
    'sem dizer "agenda deste host", que mandaria a pessoa procurar num campo vazio');

  const daAgenda = { agenda: { inicio: '08:00', fim: '18:00' } };
  ok(horario.motivoDoHorario(daAgenda, SEGUNDA_MEIO_DIA).includes('agenda deste host'),
    'o cadeado da agenda continua apontando para a agenda');
}

{
  // Janela que existe mas está fora do horário: sem fim, e sem trava.
  const fora = { janelaDoCofre: { cliente: 'Maylink', janela: janelaComercial } };
  naoOk(horario.noHorario(fora, DOMINGO_MADRUGADA), 'domingo de madrugada o comercial não atende');
  igual(horario.fimDoHorario(fora, DOMINGO_MADRUGADA), null,
    'e não há "aberto até" — devolver uma data aí faria o cadeado prometer o que não vale');
  ok(horario.temHorario(fora),
    'mas o host CONTINUA tendo horário: some da lista de "abrir agora", não da de "tem horário"');
}

{
  // Cliente que veio do cofre sem janela declarada. É diferente de janela vazia.
  const semJanela = { janelaDoCofre: { cliente: 'Velonic', janela: null } };
  naoOk(horario.temHorario(semJanela),
    'cliente sem horário declarado não vira host agendado — travar a tela por um '
    + 'campo ausente prenderia a aba para sempre');
}

// ---------- 3. o cache de janelas ----------

(async () => {
  const store = require('../lib/store');
  const segredosDeCofre = require('../lib/cofresegredos');
  const dadosDeCofre = require('../lib/dadosdecofre');

  const servidor = fake.criar({});
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;

  const d = store.get();
  d.cofres = [
    { apelido: 'erp', tipo: 'vitruviano', nome: 'ERP',
      config: { baseUrl: `http://127.0.0.1:${porta}/api/cofre/v1` } },
    // Um cofre do contrato aberto, que NÃO tem clientes.
    { apelido: 'aberto', tipo: 'nativo', nome: 'Genérico',
      config: { baseUrl: `http://127.0.0.1:${porta}/v1` } },
  ];
  d.hosts = [];
  store.save();
  segredosDeCofre.definir('erp', { chave: fake.TOKEN });
  segredosDeCofre.definir('aberto', { chave: fake.TOKEN });

  const hostDoCliente = { segredo: { cofre: 'erp', id: 'x', cliente: fake.VELONIC } };

  // Antes de qualquer busca: sem janela, e sem travar nada.
  igual(dadosDeCofre.janelaDoHost(hostDoCliente), null,
    'antes da primeira busca o host não tem janela — e a tela abre na mesma hora, '
    + 'em vez de esperar o ERP responder');

  // Dispara e SEGUE: a função não pode ser aguardável, senão a rota de estado
  // fica presa no tempo de resposta do ERP.
  const antes = Date.now();
  dadosDeCofre.renovarSeVencido();
  ok(Date.now() - antes < 50,
    'renovarSeVencido devolve na hora — é chamada no carregamento da tela');

  await dadosDeCofre.renovarAgora('erp');

  const j = dadosDeCofre.janelaDoHost(hostDoCliente);
  ok(j && j.janela, 'depois da busca, o host do cliente tem janela');
  igual(j.cliente, 'Velonic', 'com o nome do cliente, para a etiqueta');
  ok(horario.noHorario({ janelaDoCofre: j }, SEGUNDA_MEIO_DIA),
    'e ela alimenta a decisão de horário de ponta a ponta');

  // Só o cofre que declara ter clientes é consultado.
  const estado = dadosDeCofre.estado();
  ok(estado.erp && estado.erp.clientes.length === fake.CLIENTES.length,
    'o cofre com clientes foi lido');
  igual(await dadosDeCofre.renovarAgora('aberto'), null,
    'o cofre do contrato aberto NÃO é consultado por causa de janela: ele não tem '
    + 'esse conceito, e a requisição só gastaria o limite de taxa');

  // Host que aponta para cliente desconhecido, ou sem cliente nenhum.
  igual(dadosDeCofre.janelaDoHost({ segredo: { cofre: 'erp', id: 'x', cliente: 'sumiu' } }), null,
    'cliente que não está mais na lista do analista não tem janela');
  igual(dadosDeCofre.janelaDoHost({ segredo: { cofre: 'erp', id: 'x' } }), null,
    'segredo sem cliente também não — é o host antigo, de antes deste campo existir');
  igual(dadosDeCofre.janelaDoHost({ auth: { type: 'password' } }), null,
    'host sem cofre nenhum passa longe disso');

  // ---------- falha do ERP NÃO apaga o que já se sabe ----------

  await new Promise((r) => servidor.close(r));
  const caido = fake.criar({ indisponivel: true });
  await new Promise((r) => caido.listen(porta, '127.0.0.1', r));

  await dadosDeCofre.renovarAgora('erp');
  const depois = dadosDeCofre.janelaDoHost(hostDoCliente);
  ok(depois && depois.janela,
    'com o ERP fora do ar, a janela conhecida CONTINUA valendo — apagá-la '
    + 'destravaria todas as abas de uma vez, e o horário do cliente não mudou');
  ok(dadosDeCofre.estado().erp.erro,
    'mas o erro fica registrado, para a tela poder dizer que o dado está velho');

  await new Promise((r) => caido.close(r));

  // ---------- esquecer ----------

  dadosDeCofre.esquecer('erp');
  igual(dadosDeCofre.janelaDoHost(hostDoCliente), null,
    'apagar o cofre apaga as janelas dele — senão o cache vira lixo permanente');

  // ---------- lista vazia: "não perguntei" x "você não atende ninguém" ----------

  {
    const dc2 = require('../lib/dadosdecofre');
    dc2.esquecer('erp');
    igual(dc2.estado().erp, undefined, 'cofre esquecido some do estado');

    // Cofre que responde 200 com ZERO clientes — é o que um analista desligado
    // recebe, idêntico a quem acabou de abrir o app.
    const vazio = fake.criar({});
    const original = fake.CLIENTES.splice(0, fake.CLIENTES.length);
    await new Promise((r) => vazio.listen(porta, '127.0.0.1', r));
    await dc2.renovarAgora('erp');
    const e = dc2.estado().erp;
    igual(e.clientes, [], 'a lista vem vazia');
    ok(e.jaBuscou,
      'mas o app SABE que perguntou — sem essa marca a tela diz "ainda não chegou" '
      + 'para quem perdeu o acesso, e a pessoa fica esperando algo que não vem');
    igual(e.erro, null, 'e não é erro: o cofre respondeu 200, só não há cliente nenhum');
    fake.CLIENTES.push(...original);
    await new Promise((r) => vazio.close(r));
  }

  console.log(`\n${n} verificações passaram`);
})().catch((e) => { console.error(e); process.exit(1); });
