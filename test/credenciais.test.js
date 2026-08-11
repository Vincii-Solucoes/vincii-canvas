'use strict';

// Testes do núcleo de credenciais — o ÚNICO ponto do app que resolve a senha de
// um host, inclusive quando ela mora num cofre externo.
//
// Três propriedades que precisam valer sempre, e cujas falhas são todas
// silenciosas:
//
//   1. a senha vinda do cofre NUNCA toca o disco;
//   2. enquanto ela existe em memória, ela está no cadastro de REDAÇÃO — senão
//      uma senha que apareça na saída de um comando vai em texto claro para a
//      API da Anthropic (é o buraco que a integração de cofre abre no
//      `redigir()` de lib/agent.js, que monta a lista a partir do data.json);
//   3. o erro do cofre chega traduzido em CÓDIGO, porque é o código que decide
//      entre "tenta de novo", "falha só este host" e "para tudo" — decidir isso
//      lendo texto em português seria decidir errado na primeira tradução.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Diretório próprio ANTES de qualquer require do app: o store lê a env ao
// carregar, e o teste não pode escrever no data.json de quem desenvolve.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-cred-'));
process.env.SSHC_DATA_DIR = DIR;

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const naoOk = (c, m) => { assert.ok(!c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// Cofre de mentira controlável: cada teste diz o que a próxima resposta é.
let proximaResposta = null;
let pedidos = [];
const servidor = http.createServer((req, res) => {
  pedidos.push({ url: req.url, auth: req.headers.authorization });
  const r = proximaResposta || { status: 200, corpo: {} };
  res.writeHead(r.status, { 'Content-Type': 'application/json', ...(r.cabecalhos || {}) });
  res.end(JSON.stringify(r.corpo));
});

(async () => {
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;

  const store = require('../lib/store');
  const segredosDeCofre = require('../lib/cofresegredos');
  const credenciais = require('../lib/credenciais');

  const d = store.get();
  d.cofres = [{ apelido: 'lab', tipo: 'nativo', nome: 'Teste',
    config: { baseUrl: `http://127.0.0.1:${porta}/v1` } }];
  d.hosts = [
    { id: 'h-cofre', name: 'do cofre', host: '10.0.0.5', port: 22, username: 'root',
      auth: { type: 'cofre' }, segredo: { cofre: 'lab', id: 'sec_1' } },
    { id: 'h-senha', name: 'senha local', host: '10.0.0.6', port: 22, username: 'root',
      auth: { type: 'password', password: 'senha-do-cadastro' } },
    { id: 'h-orfao', name: 'cofre sumido', host: '10.0.0.7', port: 22, username: 'root',
      auth: { type: 'cofre' }, segredo: { cofre: 'nao-existe', id: 'sec_9' } },
  ];
  store.save();
  segredosDeCofre.definir('lab', { chave: 'a-chave' });

  const host = (id) => store.get().hosts.find((h) => h.id === id);

  // ---------- o caminho de sempre continua igual ----------

  {
    const c = await credenciais.resolver(host('h-senha'));
    igual(c.type, 'password', 'host com senha no cadastro resolve como antes');
    igual(c.password, 'senha-do-cadastro', 'com a senha do cadastro');
    naoOk(c.deCofre, 'e sabendo que não veio de cofre');
    igual(credenciais.segredosVivos(), [],
      'senha do CADASTRO não entra no cadastro de redação: ela já está no data.json, '
      + 'de onde o redigir() de agent.js a lê sozinho');
    c.dispose();
  }

  // ---------- a senha do cofre e o cadastro de redação ----------

  {
    proximaResposta = { status: 200, corpo: { id: 'sec_1', tipo: 'senha', usuario: 'root', senha: 'senha-do-cofre' } };
    pedidos = [];
    const c = await credenciais.resolver(host('h-cofre'));
    igual(c.password, 'senha-do-cofre', 'a senha vem do cofre');
    ok(c.deCofre, 'e vem marcada como tal');
    igual(pedidos[0].auth, 'Bearer a-chave', 'a chave vai no cabeçalho, não na URL');
    ok(!pedidos[0].url.includes('a-chave'), 'e a URL não a carrega — ali ela entraria em log');

    igual(credenciais.segredosVivos(), ['senha-do-cofre'],
      'ENQUANTO resolvida, a senha está no cadastro de redação — sem isto ela iria '
      + 'em texto claro para a API da IA se aparecesse na saída de um comando');

    // Duas sessões com o mesmo segredo: a primeira a encerrar não pode
    // desproteger a outra.
    const c2 = await credenciais.resolver(host('h-cofre'));
    c.dispose();
    igual(credenciais.segredosVivos(), ['senha-do-cofre'],
      'com duas sessões abertas, encerrar uma NÃO desprotege a outra');
    c2.dispose();
    igual(credenciais.segredosVivos(), [], 'encerrada a última, o valor sai do cadastro');

    c2.dispose();
    igual(credenciais.segredosVivos(), [], 'dispose duas vezes não desconta a mais');
  }

  {
    // O que este módulo existe para garantir: nada em disco.
    const antes = fs.readFileSync(path.join(DIR, 'data.json'), 'utf8');
    proximaResposta = { status: 200, corpo: { tipo: 'senha', senha: 'jamais-em-disco' } };
    const c = await credenciais.resolver(host('h-cofre'));
    c.dispose();
    const depois = fs.readFileSync(path.join(DIR, 'data.json'), 'utf8');
    naoOk(depois.includes('jamais-em-disco'), 'a senha do cofre NÃO pode ser gravada');
    igual(depois, antes, 'e o data.json nem é tocado por uma resolução');
  }

  // ---------- chave SSH ----------

  {
    // Chave de mentira, mas com o CORPO base64 comprido de uma de verdade: é o
    // que faz a redação por linha ser testável (linha curta é filtrada por ser
    // curta demais, e aí o teste passaria por acidente).
    const MIOLO = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdzc2gt';
    const CHAVE = `-----BEGIN OPENSSH PRIVATE KEY-----\n${MIOLO}\n-----END OPENSSH PRIVATE KEY-----`;
    proximaResposta = { status: 200, corpo: {
      tipo: 'chave-ssh', usuario: 'deploy', chavePrivada: CHAVE, passphrase: 'frase-longa',
    } };
    const c = await credenciais.resolver(host('h-cofre'));
    igual(c.type, 'key', 'chave do cofre vira o tipo que o ssh2 entende');
    ok(c.privateKey.startsWith('-----BEGIN'), 'a chave vem em memória, sem passar por arquivo');
    ok(credenciais.segredosVivos().includes('frase-longa'),
      'a passphrase também precisa ser redigida — ela abre a chave');

    // A CHAVE em si. Faltava, e a falta era pior do que parece: a passphrase
    // era apagada da saída e a chave que ela protege atravessava inteira, na
    // MESMA saída de comando, a caminho da API da Anthropic.
    ok(credenciais.segredosVivos().includes(CHAVE),
      'a chave privada inteira entra no cadastro de redação — proteger só a '
      + 'passphrase é trancar a porta e deixar a chave na fechadura');

    // E cada LINHA, porque `redigir()` casa substring exata: uma chave que
    // passou por um terminal volta com \r\n, ou reembrulhada por um grep no
    // caminho, e o blob inteiro deixa de casar.
    ok(credenciais.segredosVivos().includes(MIOLO),
      'cada linha do PEM entra sozinha — é o que sobrevive à reformatação do terminal');

    // Prova de ponta a ponta, com o mesmo algoritmo do redigir() de agent.js.
    const apagar = (t) => {
      let x = t;
      for (const v of credenciais.segredosVivos().filter((y) => y.length >= 6)) {
        x = x.split(v).join('[…removido…]');
      }
      return x;
    };
    const saida = `deploy@web-01:~$ cat /opt/deploy/id_rsa\n${CHAVE}\n$ echo $PASS\nfrase-longa`;
    naoOk(apagar(saida).includes(MIOLO), 'a saída limpa não contém o corpo da chave');
    naoOk(apagar(saida.replace(/\n/g, '\r\n')).includes(MIOLO),
      'nem quando a saída vem com quebra de linha de terminal (\\r\\n), que é o '
      + 'caso REAL: é assim que um PTY entrega o texto');
    naoOk(apagar(saida).includes('frase-longa'), 'e a passphrase continua apagada');

    c.dispose();
    igual(credenciais.segredosVivos(), [],
      'e o dispose() devolve tudo: linha por linha, sem sobrar resíduo protegido '
      + 'para sempre no cadastro');
  }

  // ---------- erros: o código é o que decide o comportamento ----------

  {
    const casos = [
      [401, { erro: { codigo: 'chave_invalida' } }, 'chave_invalida'],
      [401, { erro: { codigo: 'chave_expirada' } }, 'chave_expirada'],
      [403, { erro: { codigo: 'sem_permissao' } }, 'sem_permissao'],
      [404, { erro: { codigo: 'nao_encontrado' } }, 'nao_encontrado'],
      // Erro FORA do contrato: o adaptador deduz pelo status, para o núcleo
      // ainda saber se insiste ou desiste.
      [403, { mensagem: 'nope' }, 'sem_permissao'],
      [500, {}, 'indisponivel'],
    ];
    for (const [status, corpo, esperado] of casos) {
      proximaResposta = { status, corpo };
      let codigo = null;
      try { await credenciais.resolver(host('h-cofre')); } catch (e) { codigo = e.codigo; }
      igual(codigo, esperado, `status ${status} vira o código "${esperado}"`);
    }
    igual(credenciais.segredosVivos(), [],
      'resolução que falhou não deixa nada pendurado no cadastro de redação');
  }

  {
    // Resposta 200 mas SEM a senha. É o caso que passaria despercebido: o app
    // conectaria com senha vazia e culparia o servidor remoto.
    proximaResposta = { status: 200, corpo: { tipo: 'senha', usuario: 'root' } };
    let codigo = null;
    try { await credenciais.resolver(host('h-cofre')); } catch (e) { codigo = e.codigo; }
    igual(codigo, 'resposta_invalida', 'segredo sem valor é ERRO, não senha vazia');
  }

  {
    // Restaurar um backup noutra máquina produz exatamente isto.
    let e = null;
    try { await credenciais.resolver(host('h-orfao')); } catch (err) { e = err; }
    igual(e && e.codigo, 'cofre_ausente', 'host apontando para cofre inexistente tem código próprio');
    ok(/nao-existe/.test(e.message),
      'e a mensagem NOMEIA o cofre que falta — é a única pista de onde consertar');
  }

  // ---------- recuo: só para erro transitório ----------

  {
    proximaResposta = { status: 503, corpo: { erro: { codigo: 'indisponivel' } } };
    pedidos = [];
    try { await credenciais.resolver(host('h-cofre')); } catch {}
    ok(pedidos.length > 1, 'erro transitório é tentado de novo');

    proximaResposta = { status: 401, corpo: { erro: { codigo: 'chave_invalida' } } };
    pedidos = [];
    try { await credenciais.resolver(host('h-cofre')); } catch {}
    igual(pedidos.length, 1,
      'chave inválida NÃO é insistida: martelar um cofre com chave morta costuma ser '
      + 'o que faz ele bloquear a chave de vez');
  }

  // ---------- a chave de API fica fora do data.json ----------

  // ---------- o Keychain não é tocado sem ter o que proteger ----------
  //
  // A primeira versão perguntava ao sistema no ARRANQUE do app. No macOS essa
  // pergunta é `safeStorage.isEncryptionAvailable()`, que abre o Keychain — e o
  // macOS pedia a senha de login TODA VEZ que o app abria, sem nenhum cofre
  // configurado e sem nada a proteger. Pior: o app é assinado ad-hoc e
  // reassinado a cada versão, então o Keychain nunca reconhecia o app anterior e
  // a pergunta voltava sempre. Medido no app empacotado, perfil zerado: 1 acesso
  // por arranque; depois do conserto, 0.
  {
    const os2 = require('os');
    const dir2 = fs.mkdtempSync(path.join(os2.tmpdir(), 'vc-kc-'));
    const antigo = process.env.SSHC_DATA_DIR;
    process.env.SSHC_DATA_DIR = dir2;
    delete require.cache[require.resolve('../lib/cofresegredos')];
    const seg = require('../lib/cofresegredos');
    let toques = 0;
    seg.usarCofreDoSistema({
      disponivel: () => { toques += 1; return true; },
      cifrar: (t) => Buffer.from('C:' + t),
      decifrar: (b) => b.toString().replace(/^C:/, ''),
    });
    igual(toques, 0, 'INJETAR a interface do sistema não pode perguntar nada — era aqui que o '
      + 'arranque do app abria o Keychain');
    igual(seg.estadoDaProtecao(), 'ainda-nao-perguntado',
      'e a tela sabe dizer isso sem forçar a pergunta');
    seg.pegar('qualquer');
    igual(toques, 0, 'ler sem arquivo nenhum também não pergunta');

    seg.definir('lab', { chave: 'k' });
    igual(toques, 1, 'a pergunta acontece ao GRAVAR uma chave de verdade — aí há o que proteger');
    igual(seg.estadoDaProtecao(), 'sistema', 'e só então o estado é conhecido');
    igual(seg.pegar('lab'), { chave: 'k' }, 'a chave volta decifrada');
    igual(toques, 1, 'a resposta do sistema é guardada: não se pergunta duas vezes');

    // Desligado pelo usuário: o Keychain não é tocado nem para gravar.
    const dir3 = fs.mkdtempSync(path.join(os2.tmpdir(), 'vc-kc2-'));
    process.env.SSHC_DATA_DIR = dir3;
    delete require.cache[require.resolve('../lib/cofresegredos')];
    const seg2 = require('../lib/cofresegredos');
    let toques2 = 0;
    seg2.usarCofreDoSistema({ disponivel: () => { toques2 += 1; return true; },
      cifrar: (t) => Buffer.from(t), decifrar: (b) => b.toString() });
    seg2.definirPreferencia(false);
    seg2.definir('lab', { chave: 'k' });
    igual(toques2, 0, 'com o armazenamento do sistema DESLIGADO, nada de Keychain — nem ao gravar');
    const arq = JSON.parse(fs.readFileSync(path.join(dir3, 'cofres-chaves.json'), 'utf8'));
    igual(arq.formato, 'texto-claro', 'a chave vai para o arquivo, no regime das demais credenciais');
    igual(fs.statSync(path.join(dir3, 'cofres-chaves.json')).mode & 0o777, 0o600, 'com permissão 600');
    igual(seg2.pegar('lab'), { chave: 'k' }, 'e volta de lá sem perguntar nada');

    process.env.SSHC_DATA_DIR = antigo;
    delete require.cache[require.resolve('../lib/cofresegredos')];
    try { fs.rmSync(dir2, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(dir3, { recursive: true, force: true }); } catch {}
  }

  {
    const bruto = fs.readFileSync(path.join(DIR, 'data.json'), 'utf8');
    naoOk(bruto.includes('a-chave'),
      'a chave do cofre NÃO mora no data.json — é o que torna "nunca vai no backup" '
      + 'uma garantia estrutural, e não uma regra que alguém precisa lembrar');
    ok(fs.existsSync(path.join(DIR, 'cofres-chaves.json')), 'ela mora em arquivo próprio');
    const modo = fs.statSync(path.join(DIR, 'cofres-chaves.json')).mode & 0o777;
    igual(modo, 0o600, 'com permissão 600');
  }

  {
    // O export só enxerga o objeto que recebe; a chave não está nele.
    const { buildXml } = require('../lib/exportxml');
    const xml = buildXml(store.get(), { includeSecrets: true });
    naoOk(xml.includes('a-chave'),
      'nem com "incluir segredos" a chave do cofre vai para o backup: um .xml vazado '
      + 'com ela dentro entregaria o COFRE INTEIRO, e não uma senha');
    ok(xml.includes('apelido="lab"'), 'mas o endereço e o tipo vão — restaurar só pede a chave');
    ok(xml.includes('<segredo cofre="lab"'), 'e a referência do host também');
  }

  // ---------- a última barreira antes da API da IA ----------
  //
  // `redigir()` de lib/agent.js monta a lista de segredos a remover da saída dos
  // comandos A PARTIR DO data.json. Com a senha vindo de cofre, ela não está lá:
  // sem a ligação com o cadastro de redação, a lista fica VAZIA e a senha vai em
  // texto claro para a Anthropic. Medido tirando a linha: vaza.
  {
    const { redigir } = require('../lib/agent');
    proximaResposta = { status: 200, corpo: { tipo: 'senha', senha: 'SENHA-QUE-NAO-PODE-VAZAR' } };
    const c = await credenciais.resolver(host('h-cofre'));
    const saida = redigir('o serviço registrou SENHA-QUE-NAO-PODE-VAZAR no log');
    naoOk(saida.includes('SENHA-QUE-NAO-PODE-VAZAR'),
      'senha do cofre que apareça na saída de um comando NÃO pode chegar à API da IA');
    ok(/removido/.test(saida), 'e o lugar dela fica marcado, em vez de sumir sem explicação');

    c.dispose();
    const depois = redigir('o serviço registrou SENHA-QUE-NAO-PODE-VAZAR no log');
    ok(depois.includes('SENHA-QUE-NAO-PODE-VAZAR'),
      'encerrada a sessão, o valor sai da lista — guardá-lo para sempre seria '
      + 'manter segredo em memória sem ninguém usando');
  }

  servidor.close();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  console.log(`\n${n} verificações passaram`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
