'use strict';

// O ÚNICO ponto do app que resolve a credencial de um host.
//
// Antes deste módulo, `host.auth.password` era lido diretamente em sete lugares:
// runner.js (lote), terminal.js (Telnet), files.js (FTP), a rota de credencial
// de RDP/VNC, o `redigir()` do agente de IA, o export do backup e o publicHost.
// Sete leitores é exatamente como este projeto já perdeu campo três vezes
// (protocolo, rdpDomain, url): alguém acrescenta um caminho e esquece de um.
// Com cofre externo no jogo, um caminho esquecido não devolve "campo vazio" —
// devolve "conecta sem senha" ou "manda a senha para a API da IA".
//
// Aqui dentro moram três coisas, e só elas:
//   1. resolver(host)  -> a credencial pronta para o cliente de conexão usar;
//   2. o cadastro de redação, que mantém vivo o valor a ser removido da saída
//      antes de ela ir para a IA;
//   3. o que fazer quando o cofre erra — recuo, desistência, ou parar tudo.

const cofres = require('./cofres');
const segredosDeCofre = require('./cofresegredos');
const { ErroDeCofre } = require('./cofres/http');
const store = require('./store');

// ---------------- cadastro de redação ----------------
//
// `lib/agent.js` monta a lista de segredos a remover da saída dos comandos a
// partir do data.json. Com a senha vindo do cofre, ela NÃO está lá — e uma senha
// que aparecesse na saída de um comando iria em texto claro para a API da
// Anthropic. Por isso toda credencial resolvida se registra aqui enquanto viver,
// e `agent.js` passa a ler daqui também.
//
// Contagem por valor, e não um conjunto: o mesmo segredo pode estar resolvido em
// duas sessões ao mesmo tempo, e a primeira a encerrar não pode desproteger a
// outra.
const emUso = new Map();

function registrarParaRedacao(valores) {
  for (const v of valores) {
    if (typeof v !== 'string' || v.length < 6) continue; // curto demais casaria com texto comum
    emUso.set(v, (emUso.get(v) || 0) + 1);
  }
}

function esquecerDaRedacao(valores) {
  for (const v of valores) {
    if (typeof v !== 'string' || v.length < 6) continue;
    const n = (emUso.get(v) || 0) - 1;
    if (n > 0) emUso.set(v, n); else emUso.delete(v);
  }
}

const segredosVivos = () => [...emUso.keys()];

// ---------------- configuração dos cofres ----------------

function listaDeCofres() {
  const d = store.get();
  return Array.isArray(d.cofres) ? d.cofres : [];
}

function cofrePorApelido(apelido) {
  return listaDeCofres().find((c) => c.apelido === apelido) || null;
}

// Junta o que está no data.json (endereço, tipo) com o que está no armazenamento
// protegido (a chave). O objeto resultante NUNCA é devolvido ao navegador.
function configCompleta(cofre) {
  return { ...(cofre.config || {}), ...segredosDeCofre.pegar(cofre.apelido),
    certificadoFixado: cofre.certificadoFixado || null };
}

function fixarCertificado(apelido, impressao) {
  const d = store.get();
  const c = (d.cofres || []).find((x) => x.apelido === apelido);
  if (!c || c.certificadoFixado) return;
  c.certificadoFixado = impressao;
  store.save();
  console.error(`[cofres] certificado de "${apelido}" fixado: ${impressao}`);
}

// ---------------- chamadas ao cofre ----------------

function adaptadorDe(cofre) {
  const a = cofres.pegar(cofre.tipo);
  if (!a) throw new ErroDeCofre('config_invalida', `Cofre de tipo desconhecido: ${cofre.tipo}.`);
  return a;
}

// Recuo exponencial curto. Só vale para erro TRANSITÓRIO: chave inválida ou
// segredo inexistente não melhoram com insistência, e insistir com chave morta
// costuma ser o que faz o cofre bloquear a chave de vez.
const TRANSITORIO = new Set(['indisponivel', 'limite_de_taxa']);
const TENTATIVAS = 3;

async function comRecuo(fn) {
  let ultimo;
  for (let i = 0; i < TENTATIVAS; i++) {
    try { return await fn(); } catch (e) {
      ultimo = e;
      if (!(e instanceof ErroDeCofre) || !TRANSITORIO.has(e.codigo) || i === TENTATIVAS - 1) throw e;
      const espera = e.esperaSegundos ? e.esperaSegundos * 1000 : 400 * (2 ** i);
      await new Promise((r) => setTimeout(r, Math.min(espera, 5000)));
    }
  }
  throw ultimo;
}

async function ping(apelidoOuCofre, configExtra) {
  const cofre = typeof apelidoOuCofre === 'string' ? cofrePorApelido(apelidoOuCofre) : apelidoOuCofre;
  if (!cofre) throw new ErroDeCofre('nao_encontrado', 'Cofre não configurado.');
  const a = adaptadorDe(cofre);
  const cfg = { ...configCompleta(cofre), ...(configExtra || {}) };
  return comRecuo(() => a.ping(cfg));
}

async function listarSegredos(apelido, opcoes) {
  const cofre = cofrePorApelido(apelido);
  if (!cofre) throw new ErroDeCofre('nao_encontrado', `Cofre "${apelido}" não configurado.`);
  const a = adaptadorDe(cofre);
  if (!a.capacidades.listar) {
    throw new ErroDeCofre('sem_listagem', `${a.nome} não lista segredos — informe o caminho à mão.`);
  }
  return comRecuo(() => a.listar(configCompleta(cofre), opcoes || {}));
}

// ---------------- o que o resto do app chama ----------------

// Devolve a credencial pronta, no formato que os clientes de conexão já usam
// hoje. Quem chama DEVE chamar `dispose()` ao encerrar — é ele que tira o valor
// do cadastro de redação.
async function resolver(host) {
  const auth = (host && host.auth) || {};
  const nada = () => {};

  if (auth.type !== 'cofre') {
    // Caminho de sempre: a credencial está no próprio host. Passa por aqui
    // mesmo assim, para existir UM formato e UM ponto de saída.
    return {
      type: auth.type || 'agent',
      password: auth.password || '',
      keyPath: auth.keyPath || '',
      passphrase: auth.passphrase || '',
      privateKey: null,
      deCofre: false,
      dispose: nada,
    };
  }

  const ref = host.segredo || {};
  const cofre = cofrePorApelido(ref.cofre);
  if (!cofre) {
    throw new ErroDeCofre('cofre_ausente',
      `Este host usa o cofre "${ref.cofre || '(sem apelido)'}", que não está configurado nesta `
      + 'máquina. Configure-o em Configurações → Cofres de credenciais.');
  }
  if (!ref.id) {
    throw new ErroDeCofre('nao_encontrado', 'Este host não aponta para nenhum segredo do cofre.');
  }

  const a = adaptadorDe(cofre);
  const cfg = configCompleta(cofre);
  const s = await comRecuo(() => a.ler(cfg, ref.id));

  const valores = [s.senha, s.passphrase].filter((v) => typeof v === 'string' && v);
  registrarParaRedacao(valores);
  let solto = false;

  return {
    type: s.tipo === 'chave-ssh' ? 'key' : 'password',
    password: s.tipo === 'senha' ? s.senha : '',
    privateKey: s.tipo === 'chave-ssh' ? s.chavePrivada : null,
    passphrase: s.passphrase || '',
    keyPath: '',
    // O cofre pode saber o usuário; quem manda é o cadastro do host, e o do
    // cofre só entra quando o host não define — senão editar o host deixaria de
    // ter efeito sem explicação.
    usuario: s.usuario || '',
    expiraEm: s.expiraEm || null,
    deCofre: true,
    dispose() {
      if (solto) return;
      solto = true;
      esquecerDaRedacao(valores);
    },
  };
}

module.exports = {
  resolver,
  ping,
  listarSegredos,
  listaDeCofres,
  cofrePorApelido,
  configCompleta,
  fixarCertificado,
  segredosVivos,
  ErroDeCofre,
  // exportados para teste
  _emUso: emUso,
};
