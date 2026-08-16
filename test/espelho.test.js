'use strict';

// Testes do ESPELHO: os sistemas do cliente aparecem como hosts, e o ERP manda.
//
// A promessa do recurso é "não digitar duas vezes o que o ERP já sabe". O que
// torna isso verdade não é a lista aparecer — é ela NÃO ser gravada:
//
//   - gravada, a cópia local sobreviveria à remoção no ERP e viraria um host
//     fantasma apontando para um sistema que não é mais daquele cliente;
//   - gravada, iria no backup, e restaurar noutra máquina traria a mesa de
//     trabalho de quem exportou, e não a de quem importou;
//   - gravada e editável, o campo mexido à mão seria apagado na renovação
//     seguinte, em silêncio.
//
// Por isso os testes abaixo insistem tanto no que o espelho NÃO faz.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-esp-'));
process.env.SSHC_DATA_DIR = DIR;

const fake = require('./vitruviano-local');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const naoOk = (c, m) => { assert.ok(!c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

(async () => {
  const store = require('../lib/store');
  const segredosDeCofre = require('../lib/cofresegredos');
  const dados = require('../lib/dadosdecofre');
  const horario = require('../public/horario');

  let servidor = fake.criar({});
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;

  const d = store.get();
  d.cofres = [{ apelido: 'erp', tipo: 'vitruviano', nome: 'HV',
    config: { baseUrl: `http://127.0.0.1:${porta}/api/cofre/v1` } }];
  d.hosts = [];
  store.save();
  segredosDeCofre.definir('erp', { chave: fake.TOKEN });

  // ---------- 1. antes de buscar, nada ----------

  igual(dados.hostsEspelhados(), [],
    'sem ter falado com o ERP ainda, não há espelho — a tela abre com os hosts '
    + 'cadastrados e o resto chega depois, sem travar o carregamento');

  await dados.renovarAgora('erp');

  // ---------- 2. o que vira host, e o que não vira ----------

  {
    const hs = dados.hostsEspelhados();
    igual(hs.filter((h) => h.protocol === 'web').map((h) => h.name).sort(), ['IXC', 'OPA'],
      'os sistemas COM URL viram hosts');
    naoOk(hs.some((h) => h.name === 'Rede interna'),
      'sistema SEM url não vira host — não haveria o que abrir, e um host que '
      + 'não conecta é pior que a ausência dele');

    // E os SEGREDOS com protocolo + endereço também viram hosts — foi o pedido
    // que nasceu na prática: a credencial da VM entrou no cofre e a máquina
    // tinha que aparecer sozinha, como os sistemas aparecem.
    const esperados = fake.SEGREDOS.filter((s) => s.protocolo && s.host).map((s) => s.nome).sort();
    igual(hs.filter((h) => h.protocol !== 'web').map((h) => h.name).sort(), esperados,
      'segredo com protocolo + endereço vira host de conexão');
    naoOk(hs.some((h) => h.name === 'root@web-01'),
      'segredo SEM protocolo não vira host: sem saber o que abrir, não se inventa');
    naoOk(hs.some((h) => h.name === 'licença do mikrotik'),
      'nota sem endereço também não — nem tudo que mora no cofre é uma máquina');

    const ad = hs.find((h) => h.name === 'administrador@ad-server');
    igual(ad.protocol, 'rdp', 'o protocolo vem do segredo');
    igual(ad.port, 3389, 'a porta também');
    igual(ad.rdpDomain, 'VELONIC', 'e o domínio do Active Directory, quando o segredo o traz');
    igual(ad.auth.type, 'cofre', 'a autenticação é o próprio cofre');
    igual(ad.segredo.id, '9a1f0000-0000-4000-8000-000000000009',
      'apontando para o segredo que o originou — conectar busca o valor na hora');
    igual(ad.group, 'Velonic', 'agrupado pelo cliente, como os sistemas');
    ok(ad.espelho, 'e é espelho: sem Editar nem Excluir — quem manda é o ERP');
    ok(dados.ehEspelhado(ad.id), 'o id se identifica como espelho');
    const j = dados.janelaDoHost(ad);
    ok(j && j.janela, 'e herda a janela de atendimento do cliente dele');

    const opa = hs.find((h) => h.name === 'OPA');
    igual(opa.protocol, 'web', 'o sistema do cliente é uma página: host web');
    igual(opa.url, 'https://opa.velonic.com.br/atendente/', 'com a URL que o ERP deu');
    igual(opa.host, 'opa.velonic.com.br', 'e o endereço extraído dela, para a tela mostrar');
    igual(opa.group, 'Velonic', 'agrupado pelo CLIENTE — é assim que a mesa de trabalho '
      + 'de cada cliente fica junta na lista');
    igual(opa.auth.type, 'agent',
      'sem credencial no host: a senha, quando existir, vem do cofre na hora de entrar');
  }

  // ---------- 3. o id é ESTÁVEL entre renovações ----------

  {
    const antes = dados.hostsEspelhados().find((h) => h.name === 'OPA').id;
    await dados.renovarAgora('erp');
    const depois = dados.hostsEspelhados().find((h) => h.name === 'OPA').id;
    igual(depois, antes,
      'o id não muda a cada busca. É ele que amarra a aba aberta ao host: um id '
      + 'novo a cada cinco minutos faria a aba perder o dono, a agenda abrir uma '
      + 'segunda e a trava soltar sozinha');
    ok(dados.ehEspelhado(antes), 'e ele se identifica como espelho pelo prefixo');
    naoOk(dados.ehEspelhado('h-comum'), 'id de host cadastrado não se confunde com espelho');
  }

  // ---------- 4. o horário de atendimento do cliente vale aqui ----------

  {
    const opa = dados.hostsEspelhados().find((h) => h.name === 'OPA');
    const j = dados.janelaDoHost(opa);
    ok(j && j.janela,
      'o host espelhado herda a janela do CLIENTE dele — é o ponto todo: o sistema '
      + 'do cliente abre sozinho durante o expediente sem ninguém digitar horário');
    igual(j.cliente, 'Velonic', 'e a etiqueta sabe de quem é');
    ok(horario.noHorario({ janelaDoCofre: j }, new Date('2026-08-10T15:00:00Z')),
      'e a decisão de horário funciona de ponta a ponta (Velonic é 24 h)');
  }

  // ---------- 5. NÃO é gravado ----------

  {
    const salvo = JSON.parse(fs.readFileSync(path.join(DIR, 'data.json'), 'utf8'));
    igual(salvo.hosts, [],
      'nenhum espelhado no data.json — é o que faz o ERP mandar de verdade. '
      + 'Gravado, ele sobreviveria à remoção lá e viraria host fantasma');

    const { buildXml } = require('../lib/exportxml');
    const xml = buildXml({ hosts: salvo.hosts }, { includeSecrets: false });
    naoOk(/OPA|IXC/.test(xml),
      'nem no backup: restaurar noutra máquina traz o que o ERP disser PARA AQUELE '
      + 'analista, e não a mesa de trabalho de quem exportou');
  }

  // ---------- 6. some quando sai do ERP, muda quando muda lá ----------

  // O tamanho esperado do espelho vem do FAKE, não de um número decorado: os
  // sistemas com URL e os segredos com protocolo + endereço.
  const TOTAL = fake.SISTEMAS.filter((s) => s.url).length
    + fake.SEGREDOS.filter((s) => s.protocolo && s.host).length;

  {
    const original = fake.SISTEMAS.splice(0, fake.SISTEMAS.length);
    fake.SISTEMAS.push({ ...original[0], nome: 'OPA renomeado no ERP' });
    await dados.renovarAgora('erp');
    const hs = dados.hostsEspelhados().filter((h) => h.protocol === 'web');
    igual(hs.map((h) => h.name), ['OPA renomeado no ERP'],
      'renomear no ERP renomeia aqui, e o que saiu de lá some daqui — sem isso o '
      + '"espelho" seria só uma cópia velha com outro nome');

    fake.SISTEMAS.splice(0, fake.SISTEMAS.length, ...original);
    await dados.renovarAgora('erp');
    igual(dados.hostsEspelhados().length, TOTAL, 'e volta quando volta lá');
  }

  // ---------- 7. não duplica o que a pessoa já cadastrou ----------

  {
    const url = 'https://opa.velonic.com.br/atendente/';
    const hs = dados.hostsEspelhados([url]);
    naoOk(hs.some((h) => h.name === 'OPA'),
      'um sistema que a pessoa JÁ cadastrou à mão não aparece de novo — ela pode '
      + 'ter mudado nome, grupo ou ícone, e o espelho por cima desfaria isso');
    igual(hs.length, TOTAL - 1, 'os outros continuam');

    igual(dados.hostsEspelhados(['https://opa.velonic.com.br/atendente']).length, TOTAL - 1,
      'a comparação passa pela normalização de URL: barra final a mais não cria '
      + 'um segundo host do mesmo endereço');

    // O dedupe do SEGREDO é por destino: protocolo + endereço + porta. O host
    // manual da mesma máquina vence, e o espelho não duplica — foi exatamente o
    // caso real: a VM cadastrada à mão E no cofre.
    const comManual = dados.hostsEspelhados([
      { protocol: 'rdp', host: '10.0.0.20', port: 3389 },
    ]);
    naoOk(comManual.some((h) => h.name === 'administrador@ad-server'),
      'host manual SEM usuário é "esta máquina, seja qual for o login" — '
      + 'esconde o espelho do destino');
    igual(comManual.length, TOTAL - 1, 'e só ele some');
    ok(dados.hostsEspelhados([{ protocol: 'ssh', host: '10.0.0.20', port: 3389 }])
      .some((h) => h.name === 'administrador@ad-server'),
      'protocolo diferente no mesmo endereço NÃO é o mesmo destino — RDP e SSH '
      + 'na mesma máquina são dois hosts legítimos');
    ok(dados.hostsEspelhados([
      { protocol: 'rdp', host: '10.0.0.20', port: 3389, username: 'operador' },
    ]).some((h) => h.name === 'administrador@ad-server'),
      'manual COM usuário diferente NÃO esconde: admin e operador são dois acessos');
  }

  // ---------- 7b. as bordas do segredo-espelho ----------

  {
    fake.SEGREDOS.push(
      // Segredo "web" não vira host: o ERP nem aceita (manda para /v1/sistemas),
      // e se um dia escapar, o lugar dele continua sendo lá.
      { id: 'tmp-web-0000-0000-000000000001', cliente: fake.VELONIC, nome: 'painel-web',
        tipo: 'senha', protocolo: 'web', host: 'painel.velonic.com.br', valor: { senha: 'x' } },
      // Sem porta, vale a padrão do protocolo — um telnet sem porta é 23.
      { id: 'tmp-tel-0000-0000-000000000002', cliente: fake.VELONIC, nome: 'sw-borda',
        tipo: 'senha', protocolo: 'telnet', host: '10.0.0.30', valor: { senha: 'x' } },
    );
    await dados.renovarAgora('erp');
    const hs = dados.hostsEspelhados();
    naoOk(hs.some((h) => h.name === 'painel-web'),
      'segredo de protocolo web não vira host — página é sistema, não segredo');
    igual(hs.find((h) => h.name === 'sw-borda').port, 23,
      'segredo sem porta usa a padrão do protocolo');
    fake.SEGREDOS.splice(fake.SEGREDOS.findIndex((s) => s.id.startsWith('tmp-web')), 1);
    fake.SEGREDOS.splice(fake.SEGREDOS.findIndex((s) => s.id.startsWith('tmp-tel')), 1);
    await dados.renovarAgora('erp');
  }

  // ---------- 7c. o TOFU do espelhado sobrevive à renovação ----------

  {
    const antes = dados.hostsEspelhados().find((h) => h.name === 'administrador@ad-server');
    igual(antes.fingerprint, null, 'antes da primeira conexão, sem fingerprint');
    ok(dados.fixarFingerprint(antes.id, 'SHA256:prova-de-identidade', antes),
      'a primeira conexão fixa o fingerprint no cofre de confiança');
    naoOk(dados.fixarFingerprint('h-comum', 'SHA256:x'),
      'host cadastrado não passa por aqui — o pin dele mora no próprio cadastro');
    await dados.renovarAgora('erp');
    igual(dados.hostsEspelhados().find((h) => h.name === 'administrador@ad-server').fingerprint,
      'SHA256:prova-de-identidade',
      'o host RENASCE com o pin — sem isto, toda reconexão era "primeira conexão" '
      + 'e o TOFU não protegia nada: um servidor trocado no caminho seria aceito mudo');

    // A CHAVE é o destino (a máquina), nunca o id: o id embute o apelido do
    // cofre, e renomear o cofre órfãva todos os pins — reabrindo a janela de
    // MITM numa edição banal de cadastro. Achado da revisão, por execução.
    const salvo = JSON.parse(fs.readFileSync(path.join(DIR, 'data.json'), 'utf8'));
    igual(salvo.hosts, [], 'e os hosts espelhados continuam FORA do data.json');
    ok(salvo.espelhoConfianca && salvo.espelhoConfianca['rdp|10.0.0.20:3389'],
      'a confiança persiste chaveada pelo DESTINO — sobrevive a renomear o cofre');

    // NUNCA sobrescreve: pin diferente só entra depois do esquecimento
    // explícito — sobrescrever calado era o que uma corrida de duas conexões
    // fazia, aceitando o servidor trocado que o TOFU existe para barrar.
    dados.fixarFingerprint(antes.id, 'SHA256:impostor', antes);
    igual(dados.hostsEspelhados().find((h) => h.name === 'administrador@ad-server').fingerprint,
      'SHA256:prova-de-identidade', 'o pin gravado não é sobrescrito por outra "primeira conexão"');

    // E existe a SAÍDA: servidor legitimamente reinstalado precisa do
    // esquecer — sem ele o espelhado ficava inconectável para sempre.
    ok(dados.esquecerFingerprint(antes.id), 'esquecer o fingerprint de um espelhado funciona');
    igual(dados.hostsEspelhados().find((h) => h.name === 'administrador@ad-server').fingerprint,
      null, 'e a próxima conexão aprende a identidade nova');

    // O GC: destino que saiu do ERP leva o pin junto — senão o mapa só cresce.
    dados.fixarFingerprint(antes.id, 'SHA256:de-novo', antes);
    const idx = fake.SEGREDOS.findIndex((s) => s.nome === 'administrador@ad-server');
    const [removido] = fake.SEGREDOS.splice(idx, 1);
    await dados.renovarAgora('erp');
    {
      const s2 = JSON.parse(fs.readFileSync(path.join(DIR, 'data.json'), 'utf8'));
      naoOk(s2.espelhoConfianca && s2.espelhoConfianca['rdp|10.0.0.20:3389'],
        'segredo removido do ERP leva o pin do destino junto — confiança órfã não acumula');
    }
    fake.SEGREDOS.splice(idx, 0, removido);
    await dados.renovarAgora('erp');

    // E o GC NUNCA roda em cima de busca falhada: com o ERP fora do ar, a
    // lista vem vazia por acidente, não por remoção — apagar pins aí seria
    // TOFU zerado por um blip de rede, a janela de MITM aberta pelo zelo.
    const antes2 = dados.hostsEspelhados().find((h) => h.name === 'administrador@ad-server');
    dados.fixarFingerprint(antes2.id, 'SHA256:sobrevive-ao-blip', antes2);
    await new Promise((r) => servidor.close(r));
    const caido = fake.criar({ indisponivel: true });
    await new Promise((r) => caido.listen(porta, '127.0.0.1', r));
    await dados.renovarAgora('erp');
    {
      const s3 = JSON.parse(fs.readFileSync(path.join(DIR, 'data.json'), 'utf8'));
      ok(s3.espelhoConfianca && s3.espelhoConfianca['rdp|10.0.0.20:3389'],
        'ERP fora do ar NÃO apaga pin — confiança só sai quando a lista veio inteira e boa');
    }
    await new Promise((r) => caido.close(r));
    servidor = fake.criar({});
    await new Promise((r) => servidor.listen(porta, '127.0.0.1', r));
    await dados.renovarAgora('erp');
    dados.esquecerFingerprint(antes2.id);

    // O caso de DOIS cofres: o segundo ainda não respondeu nesta sessão, e a
    // renovação do primeiro NÃO pode apagar os pins dele — no arranque, isso
    // seria TOFU zerado de metade do parque por ordem de chegada.
    const d2 = store.get();
    d2.cofres.push({ apelido: 'erp2', tipo: 'vitruviano', nome: 'HV2',
      config: { baseUrl: 'http://127.0.0.1:1/api/cofre/v1' } });
    store.save();
    dados.fixarFingerprint('erp:erp2:seg:x', 'SHA256:do-outro-cofre',
      { protocol: 'ssh', host: '10.99.0.1', port: 22 });
    await dados.renovarAgora('erp');
    {
      const s4 = JSON.parse(fs.readFileSync(path.join(DIR, 'data.json'), 'utf8'));
      ok(s4.espelhoConfianca && s4.espelhoConfianca['ssh|10.99.0.1:22'],
        'renovar um cofre não apaga a confiança de outro que ainda não respondeu');
    }
    d2.cofres = d2.cofres.filter((c) => c.apelido !== 'erp2');
    store.save();
    dados.esquecer('erp2');
    await dados.renovarAgora('erp'); // com o erp2 fora, o GC limpa o pin dele
  }

  // ---------- 7c-2. dois acessos na mesma máquina são dois hosts ----------

  {
    // Dedupe pela máquina SEM o usuário fazia o segundo acesso sumir — e a
    // ordem da listagem do ERP decidia qual sobrevivia, trocando a identidade
    // do host (e zerando o pin) em silêncio a cada renovação.
    fake.SEGREDOS.push({ id: 'tmp-op-0000-0000-000000000003', cliente: fake.VELONIC,
      nome: 'operador@ad-server', tipo: 'senha', usuario: 'operador',
      host: '10.0.0.20', porta: 3389, protocolo: 'rdp', valor: { senha: 'x' } });
    await dados.renovarAgora('erp');
    const nomes = dados.hostsEspelhados().map((h) => h.name);
    ok(nomes.includes('administrador@ad-server') && nomes.includes('operador@ad-server'),
      'admin e operador da MESMA máquina são dois hosts — dois acessos legítimos');
    fake.SEGREDOS.splice(fake.SEGREDOS.findIndex((s) => s.id.startsWith('tmp-op')), 1);
    await dados.renovarAgora('erp');
  }

  // ---------- 7c-3. host manual que aponta o MESMO segredo esconde o espelho ----------

  {
    const alvo = fake.SEGREDOS.find((s) => s.nome === 'administrador@ad-server');
    const hs = dados.hostsEspelhados([
      { protocol: 'rdp', host: 'outro-endereco.com', port: 3389, username: 'eu',
        segredo: { cofre: 'erp', id: alvo.id } },
    ]);
    naoOk(hs.some((h) => h.name === 'administrador@ad-server'),
      'quem já cadastrou um host apontando para este segredo deu a ele nome e '
      + 'grupo próprios — o espelho não aparece por cima, mesmo com endereço diferente');
  }

  // ---------- 7d. espelhado de segredo NÃO abre sozinho ----------

  {
    // A janela vale para a CREDENCIAL; conectar é por clique. Guarda de fonte,
    // como as outras: a agenda exclui espelhado que não seja web.
    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    ok(app.includes("!(h.espelho && h.protocol !== 'web')"),
      'a agenda não abre sessão SSH/RDP sozinha em host espelhado de segredo — '
      + 'mesa de trabalho web é recurso; logar sozinho em equipamento é incidente');
    ok(app.includes("if (h.espelho && h.protocol !== 'web') return false;"),
      'e a aba de espelhado conectado por CLIQUE não trava: a janela do cliente '
      + 'governa a credencial, não o fechamento da aba');
    ok(app.includes('Esquecer fingerprint'),
      'o card do espelhado tem o botão de esquecer — sem Editar, era um beco');
  }

  // ---------- 7e. as cadeias que a revisão pegou mudas ----------

  {
    // Guardas de fonte: cada resolução de host que o espelhado alcançou por
    // execução na revisão. RDP e VNC eram QUEBRA: a aba abria, a credencial
    // vinha — e a ponte respondia "Host não encontrado".
    const leia = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok(/pegarHost/.test(leia('lib/rdp.js')), 'a ponte RDP resolve espelhado');
    ok(/pegarHost/.test(leia('lib/desktop.js')), 'a ponte VNC resolve espelhado');
    ok(/fixarFingerprint/.test(leia('lib/agent.js')),
      'o agente autônomo fixa o fingerprint de espelhado no cofre de confiança');
    const srv = leia('server.js');
    ok(/ehEspelhado\(req\.params\.id\)[\s\S]{0,200}esquecerFingerprint/.test(srv),
      'forget-fingerprint conhece espelhado');
    ok(/api\/hosts\/:id\/test'[\s\S]{0,300}pegarHost/.test(srv), 'a rota Testar conhece espelhado');
    ok(/parseFavoriteBody[\s\S]{0,900}pegarHost/.test(srv) || /favorito/i.test(srv) === false,
      'favorito com escopo de espelhado é aceito');
  }

  // ---------- 8. o interruptor ----------

  {
    const c = store.get().cofres[0];
    c.espelharSistemas = false;
    store.save();
    igual(dados.hostsEspelhados(), [], 'desligado, some tudo — sistemas E segredos');
    c.espelharSistemas = true;
    store.save();
    igual(dados.hostsEspelhados().length, TOTAL, 'ligado, volta');
    delete c.espelharSistemas;
    store.save();
    igual(dados.hostsEspelhados().length, TOTAL,
      'e cofre antigo, sem o campo, espelha: o recurso nasce ligado, como foi pedido');
  }

  // ---------- 9. busca por id, como o servidor faz ----------

  {
    const opa = dados.hostsEspelhados().find((h) => h.name === 'OPA');
    igual(dados.pegarHost(opa.id).name, 'OPA', 'o servidor acha o espelhado pelo id');
    igual(dados.pegarHost('qc_qualquer'), null, 'e não responde por id que não é dele');
    igual(dados.pegarHost(null), null, 'nem por id ausente');

    // O ARRANQUE FRIO: o espelho só existe depois da primeira conversa com o
    // ERP, e o clique rápido (Recentes, aba reatada) chegava antes — "Host não
    // encontrado" para um host que ia existir dois segundos depois. A busca
    // com renovação espera essa primeira conversa.
    dados.esquecer('erp');
    igual(dados.pegarHost(opa.id), null, 'com o cache frio, a busca direta não acha');
    const renovado = await dados.pegarHostRenovando(opa.id);
    igual(renovado && renovado.name, 'OPA',
      'a busca com renovação acha — é o que atende o clique dos Recentes no arranque');
    igual(await dados.pegarHostRenovando('h-comum'), null,
      'host cadastrado não passa por aqui, nem dispara renovação à toa');
  }

  // ---------- 10. as rotas de ESCRITA recusam ----------

  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    for (const rota of ["app.put('/api/hosts/:id'", "app.delete('/api/hosts/:id'"]) {
      const i = src.indexOf(rota);
      ok(i > 0, `achei ${rota}`);
      const bloco = src.slice(i, i + 420);
      ok(/dadosDeCofre\.ehEspelhado\(req\.params\.id\)/.test(bloco),
        `${rota} recusa host espelhado — sem isso a edição "funciona", devolve 200, `
        + 'e some na renovação seguinte sem nenhum aviso');
    }
  }

  await new Promise((r) => servidor.close(r));
  console.log(`\n${n} verificações passaram`);
})().catch((e) => { console.error(e); process.exit(1); });
