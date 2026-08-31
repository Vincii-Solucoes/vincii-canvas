'use strict';

// Testes do contrato entre a janela que solta uma aba e a janela que nasce.
//
// O defeito que este arquivo existe para impedir não é hipotético: as duas
// pontas viviam em funções distantes de app.js, cada uma com sua lista de
// campos escrita à mão. Escrever `protocol` de um lado e ler `protocolo` do
// outro derruba a janela nova em silêncio — ela abre, fica vazia, e não há
// erro em lugar nenhum. Aqui a ida e a volta são verificadas juntas.

const assert = require('assert');
const { montarUrlSolta, lerParamsSoltos, montarParamsSoltos } = require('../public/soltar');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// A volta completa: o que a aba era é o que a janela nova recebe.
const idaEVolta = (aba) => lerParamsSoltos(montarUrlSolta(aba).split('?')[1]);

// ---------- terminal: o único que transfere a sessão viva ----------

{
  const aba = {
    kind: 'term', hostId: 'h-42', hostName: 'web-01',
    sessaoId: 'ts_11111111-2222-3333-4444-555555555555',
  };
  const r = idaEVolta(aba);
  ok(r.solo, 'a janela precisa saber que é solta — sem isso ela abre o app inteiro');
  igual(r.tipo, 'term', 'tipo');
  igual(r.hostId, 'h-42', 'hostId');
  igual(r.nome, 'web-01', 'nome');
  igual(r.sessaoId, aba.sessaoId, 'o id da sessão viva precisa atravessar — é ele que '
    + 'faz o shell continuar de onde parou em vez de reconectar');
  igual(r.isLocal, false, 'host remoto não é local');
}

{
  // Terminal da própria máquina.
  const r = idaEVolta({ kind: 'term', isLocal: true, hostName: 'Meu computador', sessaoId: 'ts_x' });
  igual(r.isLocal, true, 'o terminal local precisa continuar local do outro lado');
  igual(r.hostId, null, 'terminal local não tem host');
  igual(r.sessaoId, 'ts_x', 'o local também transfere a sessão viva');
}

{
  // Sem id de sessão o servidor não mandou nenhum: a janela nova reconecta.
  const r = idaEVolta({ kind: 'term', hostId: 'h1', hostName: 'x' });
  igual(r.sessaoId, null, 'sem id, a janela nova abre conexão nova');
}

// ---------- desk e web: reconectam, e não podem levar id de sessão ----------

{
  const r = idaEVolta({
    kind: 'desk', hostId: 'h-9', hostName: 'PC da recepção', protocol: 'rdp',
  });
  igual(r.tipo, 'desk', 'tipo');
  igual(r.protocolo, 'rdp', 'o protocolo decide entre RDP e VNC — sem ele a janela '
    + 'nova não sabe qual cliente carregar');
  igual(r.sessaoId, null, 'área de trabalho mora no renderer: não há sessão a transferir');
}

{
  const r = idaEVolta({
    kind: 'web', hostId: 'h-7', hostName: 'Roteador', protocol: 'web',
    url: 'https://192.168.1.1/cgi-bin/luci?tok=a b&x=1',
  });
  igual(r.tipo, 'web', 'tipo');
  igual(r.url, 'https://192.168.1.1/cgi-bin/luci?tok=a b&x=1',
    'a URL vai inteira: espaço e & dentro dela não podem virar outros parâmetros');
  igual(r.sessaoId, null, 'página web mora no webview: nada a transferir');
}

{
  // Uma sessão de desk/web com sessaoId por engano não pode vazar o id.
  const p = montarParamsSoltos({ kind: 'web', hostName: 'x', sessaoId: 'ts_naovai' });
  igual(p.sessao, undefined, 'só terminal manda id de sessão');
}

// ---------- nomes que quebram query string ----------

{
  const nome = 'Servidor "de teste" & cia — 100% #1?x=2';
  const r = idaEVolta({ kind: 'term', hostId: 'h1', hostName: nome });
  igual(r.nome, nome, 'o nome da aba precisa chegar igual, com & # ? e acento');
}

// ---------- ausências não podem virar strings vazias ----------

{
  const r = lerParamsSoltos('?solo=1&tipo=term');
  igual(r.hostId, null, 'hostId ausente é null, não ""');
  igual(r.protocolo, null, 'protocolo ausente é null');
  igual(r.url, null, 'url ausente é null');
  igual(r.sessaoId, null, 'sessao ausente é null');
  igual(r.nome, 'Sessão', 'sem nome, um rótulo genérico');
}

{
  // Janela normal: nada de modo solo.
  const r = lerParamsSoltos('');
  igual(r.solo, false, 'sem solo=1 a janela é a principal');
  igual(r.tipo, 'term', 'na dúvida, terminal');
}

// ---------- agente autônomo viaja com a aba (o bug do "comando some") ----------
// Soltar a aba com o agente RODANDO transferia a sessão mas matava o agente e a
// janela nova abria sem saber dele. O id do run agora viaja na query string.
{
  const s = { kind: 'term', hostId: 'h1', hostName: 'web01', sessaoId: 'ts_1',
    ai: { agent: { id: 'run_abc', status: 'running' } } };
  const p = montarParamsSoltos(s);
  igual(p.agente, 'run_abc', 'agente rodando vai na URL');
  const lido = lerParamsSoltos('?' + new URLSearchParams(p).toString());
  igual(lido.agenteId, 'run_abc', 'a janela nova lê o id do agente');

  // agente que já terminou NÃO viaja (reanexar num run morto não faz sentido)
  const done = montarParamsSoltos({ kind: 'term', hostName: 'x', ai: { agent: { id: 'r', status: 'done' } } });
  igual(done.agente, undefined, 'agente encerrado não viaja');
  // starting (ainda sem resposta do servidor mas com id) viaja
  const starting = montarParamsSoltos({ kind: 'term', hostName: 'x', ai: { agent: { id: 'r2', status: 'starting' } } });
  igual(starting.agente, 'r2', 'agente starting com id viaja');
  // sessão sem IA nenhuma não estoura
  igual(montarParamsSoltos({ kind: 'term', hostName: 'x' }).agente, undefined, 'sem ai não estoura');
  // ausência vira null na leitura
  igual(lerParamsSoltos('?solo=1&tipo=term').agenteId, null, 'agente ausente é null');
}

console.log(`\n${n} verificações passaram`);
