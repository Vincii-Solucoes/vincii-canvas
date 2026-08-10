'use strict';

// Cofre de credenciais de mentira, implementando o CONTRATO ABERTO descrito em
// docs/cofres-de-credenciais.md.
//
// Serve a dois propósitos, e o segundo é tão importante quanto o primeiro:
//
//   1. destravar o desenvolvimento e o teste sem depender de nenhum cofre real
//      no ar — igual ao test/sshd-local.js, que existe pela mesma razão;
//   2. ser a IMPLEMENTAÇÃO DE REFERÊNCIA para quem for escrever o outro lado.
//      Um documento descreve; um servidor que responde tira a dúvida.
//
// Uso:
//   node test/cofre-local.js
//   VC_COFRE_PORT=4711 VC_COFRE_CHAVE=minha-chave node test/cofre-local.js
//
// Modos de defeito, para exercitar o tratamento de erro do cliente (que é onde
// mora a diferença entre "o cofre reiniciou" e "a chave foi revogada"):
//   --expira        a chave responde 401 chave_expirada
//   --401           401 chave_invalida
//   --403           403 sem_permissao ao LER (a listagem continua funcionando)
//   --429           429 com Retry-After: 2
//   --503           503 indisponivel
//   --lento=3000    atrasa toda resposta em N ms
//   --sem-listagem  501 em /v1/secrets — simula produto que só lê por id
//
// É HTTP puro de propósito. O contrato exige https em produção; aqui, forçar TLS
// obrigaria todo teste a lidar com certificado, e o que se está exercitando é o
// formato das respostas, não o transporte.

const http = require('http');

const PORTA = Number(process.env.VC_COFRE_PORT || 4711);
const CHAVE = process.env.VC_COFRE_CHAVE || 'chave-de-teste';
const args = process.argv.slice(2);
const tem = (f) => args.includes(f);
const valor = (f, padrao) => {
  const a = args.find((x) => x.startsWith(f + '='));
  return a ? Number(a.split('=')[1]) : padrao;
};

const MODO = {
  expira: tem('--expira'),
  invalida: tem('--401'),
  semPermissao: tem('--403'),
  limite: tem('--429'),
  indisponivel: tem('--503'),
  lento: valor('--lento', 0),
  semListagem: tem('--sem-listagem'),
};

// Acervo de mentira. `host`/`porta` existem para o Canvas conseguir sugerir o
// segredo certo ao cadastrar um host com aquele endereço — errar isso é o modo
// de falha mais comum da integração (apontar o host para o segredo do vizinho).
const ACERVO = [
  {
    id: 'sec_web01', nome: 'root@web-01', caminho: 'Infraestrutura/Produção',
    tipo: 'senha', usuario: 'root', host: '10.0.0.5', porta: 22,
    atualizadoEm: '2026-08-01T12:00:00Z',
    valor: { senha: 'senha-do-web-01' },
  },
  {
    id: 'sec_demo', nome: 'demo@sshd-local', caminho: 'Laboratório',
    tipo: 'senha', usuario: 'demo', host: '127.0.0.1', porta: 2388,
    atualizadoEm: '2026-08-05T09:30:00Z',
    // Bate com o test/sshd-local.js, para o teste de ponta a ponta conectar
    // de verdade com uma senha que o Canvas nunca gravou em disco.
    valor: { senha: 'segredo123' },
  },
  {
    id: 'sec_chave', nome: 'deploy (chave)', caminho: 'Infraestrutura/CI',
    tipo: 'chave-ssh', usuario: 'deploy', host: '10.0.0.9', porta: 22,
    atualizadoEm: '2026-07-20T18:00:00Z',
    valor: {
      chavePrivada: '-----BEGIN OPENSSH PRIVATE KEY-----\nchave-de-mentira\n-----END OPENSSH PRIVATE KEY-----\n',
      passphrase: 'frase-secreta',
    },
  },
  {
    id: 'sec_roteador', nome: 'admin@roteador-filial', caminho: 'Clientes/Filial Norte',
    tipo: 'senha', usuario: 'admin', host: '192.168.1.1', porta: 443,
    atualizadoEm: '2026-06-11T08:00:00Z',
    valor: { senha: 'admin-do-roteador' },
  },
];

function responder(res, status, corpo, cabecalhos = {}) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // Obrigatório no contrato para a rota de leitura; mandar em todas é mais
    // simples e não custa nada.
    'Cache-Control': 'no-store',
    ...cabecalhos,
  });
  res.end(texto);
}

const erro = (res, status, codigo, mensagem, cab) =>
  responder(res, status, { erro: { codigo, mensagem } }, cab);

// A referência é o acervo MENOS o valor. A separação é o ponto do contrato: a
// listagem não pode vazar segredo em campo nenhum, e derivar por omissão
// explícita evita que um campo novo do acervo escorra para a lista sem querer.
const referenciaDe = (s) => ({
  id: s.id, nome: s.nome, caminho: s.caminho, tipo: s.tipo,
  usuario: s.usuario, host: s.host, porta: s.porta, atualizadoEm: s.atualizadoEm,
});

const servidor = http.createServer((req, res) => {
  const seguir = () => atender(req, res);
  if (MODO.lento) setTimeout(seguir, MODO.lento); else seguir();
});

function atender(req, res) {
  let url;
  try { url = new URL(req.url, `http://127.0.0.1:${PORTA}`); }
  catch { return erro(res, 400, 'requisicao_invalida', 'URL ilegível.'); }

  // A chave NUNCA em query string: aceitar ali faria a chave entrar em log de
  // servidor, histórico de proxy e mensagem de erro. O contrato exige recusar,
  // e recusar em voz alta é melhor do que ignorar em silêncio.
  if (url.searchParams.has('chave') || url.searchParams.has('token')
      || url.searchParams.has('api_key')) {
    return erro(res, 400, 'requisicao_invalida',
      'A chave não pode ir na URL. Use o cabeçalho Authorization: Bearer.');
  }

  const auth = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return erro(res, 401, 'chave_invalida', 'Falta o cabeçalho Authorization: Bearer.');
  if (m[1] !== CHAVE) return erro(res, 401, 'chave_invalida', 'Chave desconhecida.');

  if (MODO.invalida) return erro(res, 401, 'chave_invalida', 'Chave revogada (modo de teste).');
  if (MODO.expira) return erro(res, 401, 'chave_expirada', 'Chave vencida (modo de teste).');
  if (MODO.limite) return erro(res, 429, 'limite_de_taxa', 'Devagar (modo de teste).', { 'Retry-After': '2' });
  if (MODO.indisponivel) return erro(res, 503, 'indisponivel', 'Cofre reiniciando (modo de teste).');

  if (req.method === 'GET' && url.pathname === '/v1/ping') {
    return responder(res, 200, {
      produto: 'Cofre local de teste',
      versao: '1.0',
      chave: { id: 'chv_teste', rotulo: 'Canvas — laboratório', expiraEm: '2027-01-31T00:00:00Z' },
      permissoes: ['ler'],
      cofres: [
        { id: 'infra', nome: 'Infraestrutura' },
        { id: 'lab', nome: 'Laboratório' },
        { id: 'clientes', nome: 'Clientes' },
      ],
    });
  }

  if (req.method === 'GET' && url.pathname === '/v1/secrets') {
    if (MODO.semListagem) {
      return erro(res, 501, 'sem_listagem', 'Este cofre só lê por id.');
    }
    const busca = String(url.searchParams.get('busca') || '').toLowerCase();
    const limite = Math.min(Number(url.searchParams.get('limite')) || 50, 200);
    const itens = ACERVO
      .filter((s) => !busca
        || s.nome.toLowerCase().includes(busca)
        || (s.caminho || '').toLowerCase().includes(busca)
        || (s.host || '').includes(busca))
      .slice(0, limite)
      .map(referenciaDe);
    return responder(res, 200, { itens, proximoCursor: null });
  }

  const lendo = /^\/v1\/secrets\/(.+)$/.exec(url.pathname);
  if (req.method === 'GET' && lendo) {
    if (MODO.semPermissao) {
      return erro(res, 403, 'sem_permissao', 'A chave não alcança este segredo (modo de teste).');
    }
    const s = ACERVO.find((x) => x.id === decodeURIComponent(lendo[1]));
    if (!s) return erro(res, 404, 'nao_encontrado', 'Segredo não existe.');
    console.error(`[cofre-local] leram ${s.id} (${s.nome})`);
    return responder(res, 200, { id: s.id, nome: s.nome, tipo: s.tipo, usuario: s.usuario, ...s.valor });
  }

  return erro(res, 404, 'nao_encontrado', 'Rota desconhecida.');
}

servidor.listen(PORTA, '127.0.0.1', () => {
  const modos = Object.entries(MODO).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
  console.log(`[cofre-local] http://127.0.0.1:${PORTA}/v1 — chave: ${CHAVE}`);
  console.log(`[cofre-local] ${ACERVO.length} segredos${modos.length ? ' | modos: ' + modos.join(' ') : ''}`);
});

module.exports = { servidor, ACERVO, CHAVE, PORTA };
