'use strict';

// Homem Vitruviano de mentira: as quatro rotas do cofre v1, como a
// especificação as descreve.
//
// Serve para desenvolver e testar o adaptador sem depender do ERP no ar — e,
// tão importante quanto, para exercitar os caminhos que o ERP real quase nunca
// vai produzir sob demanda: token expirado, cliente inativo, 429 com
// Retry-After, 503 de cofre sem chave de cifra, e os DOIS envelopes de erro.
//
// Uso:
//   node test/vitruviano-local.js
//   VC_HV_PORT=4712 VC_HV_TOKEN=hvk_meu node test/vitruviano-local.js
//
// Modos:
//   --401 --expira --403 --inativo --429 --503
//   --erp-validation     erro no envelope do ERP (error/code, em inglês)
//   --erp-500            internal_error
//   --conflict           409 conflict (envelope do ERP, texto em português)
//   --sem-cliente        /v1/secrets sem cofre/cofreNome (ERP anterior a 11/08)
//   --sem-janela         nenhum cliente tem janela de atendimento
//   --fora-de-horario    /v1/secrets/{id} recusa com sem_permissao (a trava real)
//   --lento=3000

const http = require('http');

const PORTA = Number(process.env.VC_HV_PORT || 4712);
let registrarNoConsole = false;
const TOKEN = process.env.VC_HV_TOKEN || 'hvk_teste';

function modosDaLinhaDeComando(args) {
  const tem = (f) => args.includes(f);
  const num = (f, p) => { const a = args.find((x) => x.startsWith(f + '=')); return a ? Number(a.split('=')[1]) : p; };
  return {
    invalida: tem('--401'), expira: tem('--expira'), semPermissao: tem('--403'),
    inativo: tem('--inativo'), funcionarioInativo: tem('--desligado'),
    limite: tem('--429'), indisponivel: tem('--503'),
    erpValidation: tem('--erp-validation'), erp500: tem('--erp-500'),
    conflito: tem('--conflict'), semCliente: tem('--sem-cliente'),
    semJanela: tem('--sem-janela'), foraDeHorario: tem('--fora-de-horario'),
    lento: num('--lento', 0),
  };
}

const VELONIC = '5c323807-0000-4000-8000-000000000001';
const MAYLINK = '3b70f4d8-0000-4000-8000-000000000002';

// Janela 24 h — COMO O ERP DE VERDADE MANDA, e não como o exemplo do documento.
//
// A especificação ilustra 24/7 com `diaInicio 0 → diaFim 6, fim 23:59`. O
// produtor real manda outra coisa: um turno que FECHA O CÍRCULO no mesmo dia.
//
//   { diaInicio: 0, inicio: "00:00", diaFim: 0, fim: "00:00", rotulo: "24h" }
//
// Enquanto este arquivo copiava o exemplo do documento, ele validava uma forma
// que a produção não produz — e uma mudança que quebrou o 24/7 real passou por
// 1306 verificações verdes. Fake que diverge do produtor testa a si mesmo.
//
// A forma do documento vai junto, num terceiro cliente, porque as duas precisam
// funcionar: é o mesmo significado escrito de dois jeitos.
const JANELA_24H = { fuso: '-03:00', turnos: [
  { diaInicio: 0, inicio: '00:00', diaFim: 0, fim: '00:00', rotulo: '24h' }] };
const JANELA_24H_DO_DOCUMENTO = { fuso: '-03:00', turnos: [
  { diaInicio: 0, inicio: '00:00', diaFim: 6, fim: '23:59', rotulo: '24h' }] };
// Comercial com feriado e véspera reduzida.
const JANELA_COMERCIAL = { fuso: '-03:00',
  turnos: [{ diaInicio: 0, inicio: '08:00', diaFim: 4, fim: '18:00', rotulo: 'Comercial' }],
  excecoes: [
    { data: '2026-09-07', fechado: true, rotulo: 'Independência' },
    { data: '2026-12-24', fechado: false, inicio: '09:00', fim: '13:00' },
  ] };

const PLANTAO = '7d10aa22-0000-4000-8000-000000000003';
const SANTACLARA = '9e55bb33-0000-4000-8000-000000000004';
const REDEFIBRA = 'a166cc44-0000-4000-8000-000000000005';

const CLIENTES = [
  { id: VELONIC, nome: 'Velonic', janela: JANELA_24H },
  { id: MAYLINK, nome: 'Maylink', janela: JANELA_COMERCIAL },
  // Terceiro cliente só para a OUTRA escrita de 24 h ficar exercitada.
  { id: PLANTAO, nome: 'Plantão', janela: JANELA_24H_DO_DOCUMENTO },
  // Os dois estados de "sem janela" (16/08). O primeiro tem o nome do caso
  // REAL da produção do usuário: cliente sem turno cadastrado, credencial
  // travada até alguém cadastrar os horários no ERP.
  { id: SANTACLARA, nome: 'Santa Clara Resort', semJanela: 'sem_turnos' },
  { id: REDEFIBRA, nome: 'Rede Fibra', semJanela: 'encaminhamento_desativado' },
];

const SISTEMAS = [
  { id: '8f21c000-0000-4000-8000-000000000001', cofre: VELONIC, cofreNome: 'Velonic',
    nome: 'OPA', url: 'https://opa.velonic.com.br/atendente/' },
  { id: 'b3d90700-0000-4000-8000-000000000002', cofre: VELONIC, cofreNome: 'Velonic',
    nome: 'IXC', url: 'https://velonic.velonic.com.br/adm.php',
    campos: [{ nome: 'IP', valor: '10.0.0.5' }] },
  // Sistema SEM url, SEM campos e SEM id: os três são opcionais na prática. O
  // id falta em sistema antigo que ainda não passou por um save no ERP, e o
  // adaptador precisa cair no `cliente + nome` sem quebrar.
  { cofre: MAYLINK, cofreNome: 'Maylink', nome: 'Rede interna' },
];

const SEGREDOS = [
  { id: '9a1f0000-0000-4000-8000-000000000001', cliente: VELONIC,
    nome: 'root@web-01', caminho: 'Produção', tipo: 'senha',
    atualizadoEm: '2026-08-11T12:00:00Z', usuario: 'root', host: '10.0.0.5', porta: 22,
    valor: { senha: 'senha-do-web-01' } },
  { id: '9a1f0000-0000-4000-8000-000000000002', cliente: VELONIC,
    nome: 'demo@sshd-local', caminho: null, tipo: 'senha',
    atualizadoEm: '2026-08-05T09:30:00Z', usuario: 'demo', host: '127.0.0.1', porta: 2388,
    // Bate com test/sshd-local.js: dá para conectar de verdade no teste de ponta
    // a ponta, com uma senha que o Canvas nunca gravou.
    valor: { senha: 'segredo123' } },
  { id: '9a1f0000-0000-4000-8000-000000000003', cliente: MAYLINK,
    nome: 'deploy (chave)', caminho: 'CI', tipo: 'chave-ssh',
    atualizadoEm: '2026-07-20T18:00:00Z', usuario: 'deploy',
    valor: { chavePrivada: '-----BEGIN OPENSSH PRIVATE KEY-----\nmentira\n-----END OPENSSH PRIVATE KEY-----\n',
      passphrase: 'frase-secreta' } },
  { id: '9a1f0000-0000-4000-8000-000000000004', cliente: MAYLINK,
    // cofreNome null: o contrato avisa que pode vir, e sem alguém mandando
    // null o "trate como anulável" nunca é exercitado.
    semNomeDeCliente: true,
    nome: 'admin@roteador', caminho: 'Filial Norte', tipo: 'senha',
    atualizadoEm: '2026-06-11T08:00:00Z', usuario: 'admin', host: '192.168.1.1', porta: 443,
    // `protocolo` (14/ago): um dos seis do Canvas, quando o admin preencheu.
    protocolo: 'telnet',
    valor: { senha: 'admin-do-roteador' } },
  // Os tipos de 14/ago — na FORMA que o produto manda, não na do exemplo da
  // documentação. "certificado" é PEM (campo chavePrivada), os outros três são
  // valor único (campo senha). Foi um "tipo novo em forma velha" que provou que
  // decidir a forma pelo NOME quebrava: o certificado caía no ramo da senha.
  { id: '9a1f0000-0000-4000-8000-000000000005', cliente: VELONIC,
    nome: 'API do provisionador', caminho: null, tipo: 'token',
    atualizadoEm: '2026-08-14T10:00:00Z', host: 'https://api.velonic.com.br',
    valor: { senha: 'tok_a1b2c3' } },
  { id: '9a1f0000-0000-4000-8000-000000000006', cliente: VELONIC,
    nome: 'postgres do IXC', caminho: 'ixcprovedor', tipo: 'banco',
    atualizadoEm: '2026-08-14T10:05:00Z', usuario: 'ixc', host: '10.0.0.8', porta: 5432,
    valor: { senha: 'senha-do-banco' } },
  { id: '9a1f0000-0000-4000-8000-000000000007', cliente: MAYLINK,
    nome: 'licença do mikrotik', caminho: null, tipo: 'nota',
    atualizadoEm: '2026-08-14T10:10:00Z',
    valor: { senha: 'SN: ABCD-1234 — chave de licença nível 6' } },
  { id: '9a1f0000-0000-4000-8000-000000000008', cliente: MAYLINK,
    nome: 'certificado do concentrador', caminho: 'VPN', tipo: 'certificado',
    atualizadoEm: '2026-08-14T10:15:00Z',
    valor: { chavePrivada: '-----BEGIN CERTIFICATE-----\nfaz-de-conta\n-----END CERTIFICATE-----\n'
      + '-----BEGIN PRIVATE KEY-----\ntambem-nao\n-----END PRIVATE KEY-----\n',
      passphrase: 'senha-do-pem' } },
  // RDP com Active Directory: `dominio` e `protocolo` juntos (14/ago).
  { id: '9a1f0000-0000-4000-8000-000000000009', cliente: VELONIC,
    nome: 'administrador@ad-server', caminho: 'Datacenter', tipo: 'senha',
    atualizadoEm: '2026-08-14T10:20:00Z', usuario: 'administrador',
    host: '10.0.0.20', porta: 3389, protocolo: 'rdp', dominio: 'VELONIC',
    valor: { senha: 'senha-do-ad' } },
];

function responder(res, status, corpo, cab = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', ...cab });
  res.end(JSON.stringify(corpo));
}
// Envelope DO CONTRATO (português)
const erro = (res, status, codigo, mensagem, cab) =>
  responder(res, status, { erro: { codigo, mensagem } }, cab);
// Envelope GENÉRICO DO ERP (inglês) — nasce antes do cofre
const erroErp = (res, status, code, message) => {
  // O 422 do ERP NÃO tem `message`: só `details`. Mandar message aqui deixaria
  // o teste passar contra um formato que a API real não produz.
  if (status === 422) {
    const i = String(message).indexOf(': ');
    const campo = i > 0 ? String(message).slice(0, i) : 'parametro';
    const motivo = i > 0 ? String(message).slice(i + 2) : String(message);
    return responder(res, status, { error: { code,
      details: [{ loc: ['query', campo], msg: motivo }] } });
  }
  return responder(res, status, { error: { code, message } });
};

// A referência é o segredo MENOS o valor.
//
// `cofre` (id do cliente) passou a vir sempre; `cofreNome` pode vir null — e o
// fake devolve null de propósito num deles, porque "pode ser null" só vira
// código correto quando alguém manda null.
function referenciaDe(s, M) {
  const r = { id: s.id, nome: s.nome, caminho: s.caminho, tipo: s.tipo,
    atualizadoEm: s.atualizadoEm };
  if (!M.semCliente) {
    r.cofre = s.cliente;
    const c = CLIENTES.find((x) => x.id === s.cliente);
    r.cofreNome = s.semNomeDeCliente ? null : (c ? c.nome : null);
  }
  if (s.usuario) r.usuario = s.usuario;
  if (s.host) r.host = s.host;
  if (s.porta) r.porta = s.porta;
  // Novos de 14/ago — como tudo aqui, só aparecem quando preenchidos.
  if (s.protocolo) r.protocolo = s.protocolo;
  if (s.dominio) r.dominio = s.dominio;
  return r;
}

// Fábrica, e não um servidor solto: o teste automatizado sobe o MESMO servidor
// em porta zero, com outros modos. Um fake que só funciona rodado à mão vira um
// segundo fake dentro do teste — e aí os dois divergem do produto real.
function criar(M = {}, token = TOKEN) {
  const diario = {
    lidos: [],   // ids de segredo efetivamente lidos, para o teste conferir
    pedidos: [], // urls, para conferir paginação e parâmetros
  };
  const s = http.createServer((req, res) => {
    const seguir = () => atender(req, res, M, token, diario);
    if (M.lento) setTimeout(seguir, M.lento); else seguir();
  });
  s.diario = diario;
  return s;
}

function atender(req, res, M, token, diario) {
  let url;
  try { url = new URL(req.url, `http://127.0.0.1:${PORTA}`); }
  catch { return erroErp(res, 400, 'validation_error', 'URL ilegível.'); }

  const p = url.pathname.replace(/^\/api\/cofre/, '');
  diario.pedidos.push(req.url);

  const auth = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return erro(res, 401, 'chave_invalida', 'Falta o cabeçalho Authorization: Bearer.');
  if (m[1] !== token) return erro(res, 401, 'chave_invalida', 'Token desconhecido ou revogado.');

  if (M.invalida) return erro(res, 401, 'chave_invalida', 'Token revogado (modo de teste).');
  if (M.expira) return erro(res, 401, 'chave_expirada', 'Token vencido (modo de teste).');
  if (M.inativo) return erro(res, 403, 'cliente_inativo', 'Contrato encerrado (modo de teste).');
  // Analista DESLIGADO (16/08): 403 com código próprio nas rotas de DADOS —
  // inclusive a listagem SEM filtro, que antes devolvia 200 [] muda. O ping
  // continua respondendo: é ele que identifica a chave.
  if (M.funcionarioInativo && p !== '/v1/ping') {
    return erro(res, 403, 'funcionario_inativo', 'Seu usuário foi desativado no ERP.');
  }
  if (M.limite) return erro(res, 429, 'limite_de_taxa', 'Devagar (modo de teste).', { 'Retry-After': '2' });
  if (M.indisponivel) return erro(res, 503, 'indisponivel', 'Cofre sem chave de cifra (modo de teste).');
  if (M.erpValidation) return erroErp(res, 422, 'validation_error', 'limite: must be between 1 and 200');
  if (M.erp500) return erroErp(res, 500, 'internal_error', 'Falha inesperada do cofre.');
  // conflict sai em PORTUGUÊS, no envelope do ERP — o idioma não indica o envelope.
  if (M.conflito) return erroErp(res, 409, 'conflict', 'O cadastro mudou durante a leitura.');

  if (req.method !== 'GET') return erroErp(res, 405, 'http_error', 'Method Not Allowed');

  // Validação de parâmetro: é RECUSA, não ajuste — igual à API real.
  const busca = url.searchParams.get('busca');
  const cofre = url.searchParams.get('cofre');
  const limiteBruto = url.searchParams.get('limite');
  if (cofre && cofre.length > 64) return erroErp(res, 422, 'validation_error', 'cofre: max 64');
  if (busca && busca.length > 128) return erroErp(res, 422, 'validation_error', 'busca: max 128');
  let limite = 50;
  if (limiteBruto !== null) {
    limite = Number(limiteBruto);
    if (!Number.isInteger(limite) || limite < 1 || limite > 200) {
      return erroErp(res, 422, 'validation_error', 'limite: 1..200');
    }
  }

  if (p === '/v1/ping') {
    return responder(res, 200, {
      produto: 'Homem Vitruviano', versao: '1.0',
      chave: { id: 'hvk_3f4hoG', rotulo: 'Canvas — laboratório' },
      permissoes: ['ler'],
      cofres: CLIENTES.map((c) => {
        const base = { id: c.id, nome: c.nome };
        if (M.semJanela) return base;
        if (c.janela) base.janela = c.janela;
        // O estado de "sem janela" (16/08) — só aparece quando a janela falta.
        if (!c.janela && c.semJanela) base.semJanela = c.semJanela;
        return base;
      }),
    });
  }

  if (p === '/v1/sistemas') {
    const b = (busca || '').toLowerCase();
    return responder(res, 200, {
      itens: SISTEMAS
        .filter((s) => !cofre || s.cofre === cofre)
        .filter((s) => !b || s.nome.toLowerCase().includes(b) || (s.url || '').toLowerCase().includes(b)),
    });
  }

  if (p === '/v1/secrets') {
    const b = (busca || '').toLowerCase();
    const todos = SEGREDOS
      .filter((s) => !cofre || s.cliente === cofre)
      .filter((s) => !b || s.nome.toLowerCase().includes(b));
    // Paginação de mentira, mas de verdade: uma página por vez, para o cliente
    // exercitar o `proximoCursor` — que na API real vem SEMPRE, null no fim.
    // Cursor inválido NÃO dá erro: degrada para a primeira página com 200. É o
    // comportamento real, e é o que pode fazer um laço de paginação repetir
    // itens sem nada avisar.
    const cursorBruto = url.searchParams.get('cursor');
    const n = Number(cursorBruto);
    const inicio = (cursorBruto && Number.isInteger(n) && n >= 0 && n <= todos.length) ? n : 0;
    const pagina = todos.slice(inicio, inicio + Math.min(limite, 2));
    const fim = inicio + pagina.length;
    return responder(res, 200, {
      itens: pagina.map((x) => referenciaDe(x, M)),
      proximoCursor: fim < todos.length ? String(fim) : null,
    });
  }

  const lendo = /^\/v1\/secrets\/(.+)$/.exec(p);
  if (lendo) {
    if (M.semPermissao || M.foraDeHorario) {
      return erro(res, 403, 'sem_permissao',
        M.foraDeHorario ? 'Fora do horário de atendimento do cliente.' : 'Você não atende esse cliente.');
    }
    const s = SEGREDOS.find((x) => x.id === decodeURIComponent(lendo[1]));
    if (!s) return erro(res, 404, 'nao_encontrado', 'Segredo apagado ou inativo.');
    diario.lidos.push(s.id);
    if (registrarNoConsole) console.error(`[hv-local] leram ${s.id} (${s.nome})`);
    const cliente = CLIENTES.find((c) => c.id === s.cliente);
    const corpo = { id: s.id, nome: s.nome, tipo: s.tipo, ...s.valor };
    if (s.usuario) corpo.usuario = s.usuario;
    // `dominio` e `protocolo` (14/ago) vêm também na leitura, quando preenchidos.
    if (s.dominio) corpo.dominio = s.dominio;
    if (s.protocolo) corpo.protocolo = s.protocolo;
    if (cliente && cliente.janela && !M.semJanela) corpo.janela = cliente.janela;
    // Sem janela, o estado vem no lugar (16/08) — igual ao ping.
    if (cliente && !cliente.janela && cliente.semJanela && !M.semJanela) corpo.semJanela = cliente.semJanela;
    return responder(res, 200, corpo);
  }

  return erroErp(res, 404, 'http_error', 'Not Found');
}

if (require.main === module) {
  const M = modosDaLinhaDeComando(process.argv.slice(2));
  registrarNoConsole = true; // rodando à mão, toda leitura aparece na tela
  const servidor = criar(M);
  servidor.listen(PORTA, '127.0.0.1', () => {
    const modos = Object.entries(M).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
    console.log(`[hv-local] http://127.0.0.1:${PORTA}/api/cofre/v1 — token: ${TOKEN}`);
    console.log(`[hv-local] ${CLIENTES.length} clientes, ${SISTEMAS.length} sistemas, `
      + `${SEGREDOS.length} segredos${modos.length ? ' | modos: ' + modos.join(' ') : ''}`);
  });
}

module.exports = { criar, CLIENTES, SISTEMAS, SEGREDOS, TOKEN, PORTA, VELONIC, MAYLINK, PLANTAO,
  SANTACLARA, REDEFIBRA,
  JANELA_24H, JANELA_24H_DO_DOCUMENTO, JANELA_COMERCIAL };
