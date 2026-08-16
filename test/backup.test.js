'use strict';

// Testes do backup .xml.
//
// O defeito que motivou este arquivo: a lista de protocolos aceitos vivia
// copiada em cinco lugares, e quando RDP e VNC entraram no app o parser de
// importação ficou para trás com ['telnet','ftp']. Resultado medido contra o
// app real: exportar dois hosts (um RDP, um VNC) e restaurar num store vazio
// devolvia UM host, SSH na porta 3389. O arquivo estava certo; quem destruía
// era a leitura.
//
// Por isso os testes daqui são de TRÊS tipos:
//   1. o export emite cada campo que deve ir;
//   2. o import persiste cada campo que chega;
//   3. o parser do navegador LÊ cada atributo que o export escreve.
//
// O (3) é conferido no código-fonte de public/app.js, não executando — o parser
// depende de DOMParser, que não existe no Node. É feio, e é exatamente o teste
// que teria pegado o defeito: ele falha se alguém acrescentar um atributo ao
// export e esquecer da leitura.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildXml } = require('../lib/exportxml');
const campos = require('../public/backup-campos');
const agenda = require('../public/agenda');
const proto = require('../public/protocolos');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// Host de referência. ATENÇÃO ao que este bloco NÃO fazia: mantido só à mão,
// ele não pegava campo novo nenhum — bastava alguém acrescentar `host.etiquetas`
// em parseHostBody, no import e na tela para a suíte passar verde com o campo
// ausente do XML. O comentário de backup-campos.js chegava a AFIRMAR que
// quebrava. Não quebrava. Por isso o bloco 1b abaixo derruba a lista DO CÓDIGO
// e confronta com esta — a lista à mão virou só a fonte dos valores de teste.
const HOST_REF = {
  id: 'h1',
  name: 'WIN-DC',
  host: 'dc.corp.local',
  port: 3389,
  protocol: 'rdp',
  username: 'admin',
  // Os QUATRO atributos de <auth> juntos de propósito: a guarda de atributos de
  // elemento filho deriva a lista do EXPORT, e o export só escreve o que existe.
  // Com um auth só de senha, keyPath e passphrase não apareciam no arquivo de
  // referência e ficavam fora da conferência — que foi como o parser pôde deixar
  // de ler `keyPath` sem quebrar nada.
  auth: { type: 'password', password: 'S3nh4!', keyPath: '~/.ssh/id_ed25519', passphrase: 'frase' },
  fingerprint: 'SHA256:abc',
  ftps: 'auto',
  rdpDomain: 'CORP',
  url: 'https://192.168.1.1/admin',
  webCert: 'sha256/AAAA',
  group: 'Producao',
  subgroup: 'Web',
  icon: 'windows',
  color: 'azul',
  vars: { PAPEL: 'dc' },
  agenda: { inicio: '22:00', fim: '02:00' },
  segredo: { cofre: 'vitruviano-prod', id: 'sec_01HZX8Q3', cliente: 'cli_velonic', rotulo: 'root@web-01' },
  rdpLegado: true,
  rdpLegadoOk: true,
};

// ---------- 1b. a lista de referência acompanha o código ----------

// Lê os campos que parseHostBody devolve de fato. É a única fonte que cresce
// quando alguém acrescenta um campo de host — e a classe de bug que isto pega
// já mordeu o projeto três vezes (protocol, rdpDomain, url).
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf('function parseHostBody');
  ok(i > 0, 'achei parseHostBody em server.js');
  const corpo = src.slice(i, src.indexOf('\n}', i));
  const ret = corpo.slice(corpo.lastIndexOf('return {'));
  const doCodigo = [...ret.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:[,:}]|$)/g)]
    .map((m) => m[1])
    .filter((n) => !['return', 'hostAddr', 'true', 'false', 'null'].includes(n));
  // `host` aparece como `host: hostAddr`; o resto é abreviado.
  const esperados = new Set(doCodigo);
  const faltando = [...esperados].filter((k) => !(k in HOST_REF));
  igual(faltando, [],
    'parseHostBody devolve campo que o HOST_REF do teste não conhece — '
    + 'acrescente-o ao HOST_REF e classifique em backup-campos.js');

  // E a volta. Sem ela a guarda era de mão única: APAGAR um campo de
  // parseHostBody (o cadastro para de gravá-lo, o backup continua com a coluna
  // vazia) atravessava a suíte inteira em verde, porque a lista derivada do
  // código só encolhia. `id` e `fingerprint` nunca passaram por parseHostBody —
  // são gerados/aprendidos e estão classificados como EXCLUÍDOS.
  const naoSaoDoFormulario = new Set(Object.keys(campos.HOST_EXCLUIDOS));
  const sumiram = [...campos.HOST_ATRIBUTOS, ...campos.HOST_FILHOS]
    .filter((k) => !naoSaoDoFormulario.has(k) && !esperados.has(k));
  igual(sumiram, [],
    'backup-campos.js classifica um campo que parseHostBody NÃO devolve mais — '
    + 'ou o cadastro parou de gravá-lo, ou a classificação ficou para trás');
}

// ---------- 1. nenhum campo fica órfão ----------

{
  const classificados = new Set([
    ...campos.HOST_ATRIBUTOS, ...campos.HOST_FILHOS, ...Object.keys(campos.HOST_EXCLUIDOS),
  ]);
  const orfaos = Object.keys(HOST_REF).filter((k) => !classificados.has(k));
  igual(orfaos, [],
    'campo de host não classificado em backup-campos.js — decida se ele vai no arquivo');
  const sobrando = [...classificados].filter((k) => !(k in HOST_REF));
  igual(sobrando, [], 'backup-campos.js classifica campo que o host não tem mais');
}

// ---------- 2. o export emite o que prometeu ----------

{
  const cond = campos.HOST_ATRIBUTOS_CONDICIONAIS;
  const linhaDe = (h) => buildXml({ hosts: [h] }, { includeSecrets: true })
    .split('\n').find((l) => l.includes('<host '));
  const tem = (linha, a) => new RegExp(`\\b${a}="`).test(linha);

  const linha = linhaDe(HOST_REF);
  ok(linha, 'o export produziu uma linha de host');
  for (const a of campos.HOST_ATRIBUTOS) {
    if (cond[a] && cond[a] !== HOST_REF.protocol) continue;
    ok(tem(linha, a), `o export perdeu o atributo "${a}"`);
  }
  for (const e of Object.keys(campos.HOST_EXCLUIDOS)) {
    ok(!tem(linha, e), `"${e}" deveria ficar FORA do arquivo`);
  }

  // Cada atributo condicional aparece no SEU protocolo e some nos outros.
  for (const [a, protocolo] of Object.entries(cond)) {
    const doProtocolo = linhaDe({ ...HOST_REF, protocol: protocolo });
    ok(tem(doProtocolo, a), `"${a}" deveria sair num host ${protocolo}`);
    const outro = linhaDe({ ...HOST_REF, protocol: 'ssh' });
    ok(!tem(outro, a), `"${a}" não deveria sair num host ssh`);
  }

  const xml = buildXml({ hosts: [HOST_REF] }, { includeSecrets: true });
  ok(xml.includes('<var name="PAPEL">dc</var>'), 'vars vão como elementos filhos');
  // Genérico, e não um `ok` escrito à mão por filho: era assim que `agenda`
  // entrou classificada em backup-campos.js e atravessou a suíte inteira sem
  // que UMA linha conferisse se ela chegava ao arquivo. As três pernas abaixo
  // (export, leitura, gravação) já valiam para os atributos; os filhos passavam
  // por fora das três.
  for (const f of campos.HOST_FILHOS) {
    ok(xml.includes(`<${f}`), `o export perdeu o elemento filho "${f}"`);
  }

  // Dentro do filho, campo a campo — a partir do HOST DE REFERÊNCIA, não do
  // export.
  //
  // O teste 3 confere que o parser lê todo atributo que o EXPORT escreve. Isso
  // deixa um buraco exato: parar de exportar um campo apaga o guarda junto, e a
  // suíte passa verde com uma verificação a menos. Medido: tirar `cliente` do
  // export deixava 145 checagens OK em vez de 146, sem um único erro — e todo
  // host restaurado perdia o horário de atendimento do cliente.
  //
  // Aqui a expectativa vem do objeto de referência, que é o que descreve um
  // host completo. Acrescentar um campo a ele obriga o export a levá-lo, e o
  // teste 3 obriga o parser a lê-lo.
  const NOME_NO_ARQUIVO = {
    // `id` no arquivo é o id do HOST (que fica fora do backup). O id do item de
    // cofre sai como `item`, de propósito.
    'segredo.id': 'item',
  };
  for (const f of campos.HOST_FILHOS) {
    const valor = HOST_REF[f];
    if (f === 'vars' || !valor || typeof valor !== 'object') continue;
    const linhaFilho = xml.split('\n').find((l) => l.trim().startsWith(`<${f}`)) || '';
    for (const chave of Object.keys(valor)) {
      const atributo = NOME_NO_ARQUIVO[`${f}.${chave}`] || chave;
      ok(new RegExp(`\\b${atributo}="`).test(linhaFilho),
        `o host de referência tem ${f}.${chave} e o export NÃO o grava — o campo `
        + 'some da restauração, e o guarda derivado do export some junto com ele');
    }
  }
}

// ---------- 2b. o formato da agenda no arquivo casa com o validador ----------

// Conferir só a presença da tag não basta: o export grava as horas como texto
// ("22:00") e é `normalizarAgenda` — a MESMA função que a rota de importação
// chama — que recebe isso de volta. Se um dos lados mudar de formato (minutos
// desde a meia-noite, ISO, 12 h com AM/PM), a tag continua lá e a agenda volta
// VAZIA da restauração, com o cadastro parecendo completo e o host não abrindo
// no horário.
//
// O que este bloco NÃO faz: rodar a rota /api/import. Ela depende do express e
// do store, e o caminho completo (export → parser do navegador → POST → estado)
// é exercitado contra o app empacotado, não aqui. O que se verifica aqui é o
// acordo de FORMATO entre as duas pontas, que é onde o campo morre em silêncio.
{
  const xml = buildXml({ hosts: [HOST_REF] }, {});
  const tag = xml.split('\n').find((l) => l.includes('<agenda'));
  ok(tag, 'a agenda foi para o arquivo');
  const attr = (a) => (new RegExp(`${a}="([^"]*)"`).exec(tag) || [])[1];
  // Exatamente o que o parser do navegador entrega à rota de importação.
  const doArquivo = { inicio: attr('inicio'), fim: attr('fim') };
  ok(!/dias=/.test(tag), 'o arquivo não escreve mais dias da semana');
  igual(agenda.normalizarAgenda(doArquivo), HOST_REF.agenda,
    'o que o validador entende do arquivo precisa ser IDÊNTICO ao que foi exportado');

  // E um host sem agenda não pode ganhar uma tag vazia, que voltaria como erro
  // de validação na importação.
  const semAgenda = buildXml({ hosts: [{ ...HOST_REF, agenda: null }] }, {});
  ok(!semAgenda.includes('<agenda'), 'host sem agenda não escreve a tag');
}

// ---------- 3. o parser do navegador lê tudo que o export escreve ----------

{
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const i = src.indexOf("root.querySelectorAll(':scope > hosts > host')");
  ok(i > 0, 'achei o trecho do parser de hosts em public/app.js');
  // O recorte vai até onde os PLAYBOOKS começam, e não a um número fixo de
  // caracteres: com corte fixo, acrescentar campo empurrava o `vars` para fora
  // da janela e o teste passava a acusar ausência de um campo que estava lá.
  const fim = src.indexOf('playbooks: [...root.querySelectorAll', i);
  ok(fim > i, 'achei o fim do bloco de hosts do parser');
  const trecho = src.slice(i, fim);
  for (const a of campos.HOST_ATRIBUTOS) {
    ok(trecho.includes(`getAttribute('${a}')`),
      `o parser de importação NÃO lê o atributo "${a}" — foi assim que RDP virou SSH`);
  }
  // Exigir só o SELETOR do filho não bastava: o parser podia achar o <agenda> e
  // ler `getAttribute('start')` em vez de `inicio`, e a suíte inteira passava
  // verde. Medido com essa mutação exata: 129 + 82 verificações OK, e restaurar
  // o próprio backup APAGAVA a agenda de todo host, respondendo
  // {"hosts":{"updated":N},"skipped":[]} — zero avisos.
  //
  // Os atributos esperados de cada filho saem do EXPORT, não de uma lista à mão:
  // é o export que define o contrato, e assim um atributo novo entra na guarda
  // sozinho.
  const xmlRef = buildXml({ hosts: [HOST_REF] }, { includeSecrets: true });
  for (const f of campos.HOST_FILHOS) {
    ok(trecho.includes(`':scope > ${f}'`),
      `o parser de importação NÃO lê o elemento filho "${f}" — ele volta vazio da restauração`);
    if (f === 'vars') continue; // <vars> tem <var name=…> dentro, coberto por varsOf
    const linhaFilho = xmlRef.split('\n').find((l) => l.trim().startsWith(`<${f}`)) || '';
    const attrs = [...linhaFilho.matchAll(/\s([A-Za-z_][\w-]*)="/g)].map((m) => m[1]);
    ok(attrs.length > 0, `achei os atributos de <${f}> no export`);
    for (const a of attrs) {
      ok(trecho.includes(`getAttribute('${a}')`),
        `o export escreve <${f} ${a}="…"> e o parser NÃO lê "${a}" — o campo volta vazio da `
        + 'restauração e, pior, pode APAGAR o valor que estava aqui');
    }
  }
  for (const e of Object.keys(campos.HOST_EXCLUIDOS)) {
    ok(!trecho.includes(`getAttribute('${e}')`),
      `o parser lê "${e}", que deveria ficar fora do arquivo`);
  }
}

// ---------- 3b. o import PERSISTE cada atributo que chega ----------

// O teste anterior cobria export e leitura. Faltava a terceira ponta, e foi
// exatamente ali que o campo `url` se perdeu: o export gravava, o parser lia, e
// a rota de importação criava o host sem ele. Um campo pode morrer em qualquer
// uma das três pernas — agora as três são conferidas.
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("app.post('/api/import'");
  ok(i > 0, 'achei a rota de importação em server.js');
  const rota = src.slice(i, src.indexOf('app.get(', i) > 0 ? src.indexOf('app.get(', i) : i + 8000);
  // O bloco de hosts tem dois caminhos: atualizar um existente e criar um novo.
  const atualiza = rota.slice(rota.indexOf('Object.assign(ex'), rota.indexOf('Object.assign(ex') + 400);
  const cria = rota.slice(rota.indexOf('d.hosts.push('), rota.indexOf('d.hosts.push(') + 400);
  ok(atualiza.length > 50 && cria.length > 50, 'achei os dois caminhos do upsert de host');
  for (const a of campos.HOST_ATRIBUTOS) {
    ok(new RegExp(`\\b${a}\\b`).test(atualiza), `o import não aplica "${a}" ao atualizar um host`);
    ok(new RegExp(`\\b${a}\\b`).test(cria), `o import não grava "${a}" ao criar um host`);
  }
  // `auth` e `vars` são montados com nomes próprios no upsert; os demais filhos
  // entram pelo nome, igual aos atributos.
  for (const f of campos.HOST_FILHOS) {
    ok(new RegExp(`\\b${f}\\b`).test(atualiza), `o import não aplica "${f}" ao atualizar um host`);
    ok(new RegExp(`\\b${f}\\b`).test(cria), `o import não grava "${f}" ao criar um host`);
  }
  // A terceira perna, dentro do filho: o import monta a referência de cofre
  // CAMPO A CAMPO (para um XML de terceiro não injetar chave extra num objeto
  // que o app usa). O preço disso é que um campo esquecido ali some em silêncio
  // — o host restaura, conecta, e só não abre mais sozinho no horário.
  {
    const i2 = rota.indexOf('const segredo = opcional(h.segredo');
    ok(i2 > 0, 'achei o trecho que monta a referência de cofre na importação');
    const bloco = rota.slice(i2, i2 + 700);
    for (const chave of Object.keys(HOST_REF.segredo)) {
      ok(new RegExp(`\\b${chave}\\b`).test(bloco),
        `o import não copia "segredo.${chave}" do arquivo — a referência entra incompleta`);
    }
  }

  // O invariante é sobre a LEITURA, não sobre a escrita: `fingerprint: null` no
  // caminho de criação é o app zerando o campo de propósito. O que não pode
  // acontecer é o import tirar esses valores do objeto vindo do arquivo (`h`).
  for (const e of Object.keys(campos.HOST_EXCLUIDOS)) {
    if (e === 'id') continue; // o id é gerado aqui, nunca vem do arquivo
    ok(!new RegExp(`\\bh\\.${e}\\b`).test(rota),
      `o import lê "h.${e}" do arquivo — este campo é prova de identidade aprendida nesta máquina`);
  }
}

// ---------- 4. protocolos: uma lista só, e completa ----------

{
  for (const p of ['ssh', 'telnet', 'ftp', 'vnc', 'rdp']) {
    igual(proto.normalizarProtocolo(p), p, `${p} deveria ser um protocolo válido`);
  }
  igual(proto.normalizarProtocolo('rdp'), 'rdp', 'rdp sobrevive à normalização');
  igual(proto.normalizarProtocolo('vnc'), 'vnc', 'vnc sobrevive à normalização');
  igual(proto.normalizarProtocolo('inventado'), 'ssh', 'protocolo desconhecido vira ssh');
  igual(proto.normalizarProtocolo('constructor'), 'ssh', 'herança de protótipo não vira protocolo');
  igual(proto.portaPadrao('rdp'), 3389, 'porta padrão do RDP');
  igual(proto.portaPadrao('vnc'), 5900, 'porta padrão do VNC');
  igual(proto.portaPadrao('ftp'), 21, 'porta padrão do FTP');
  ok(!proto.PROTOCOLOS_SESSAO.includes('ftp'), 'FTP não abre sessão');

  // O mapa de portas esteve copiado em sete lugares; duas cópias tinham
  // esquecido o FTP. Se voltar a aparecer literal fora do módulo, quebra aqui.
  const arquivos = ['server.js', 'public/app.js'];
  for (const f of arquivos) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok(!/\{\s*telnet:\s*23/.test(src), `${f} voltou a ter um mapa de portas próprio`);
    ok(!/\['telnet',\s*'ftp'/.test(src), `${f} voltou a ter uma lista de protocolos própria`);
  }
}

// ---------- 5. escapes de XML ----------

{
  // Valores que já corromperam o arquivo ou o campo.
  const casos = [
    ['tab', 'a\tb'], ['lf', 'a\nb'], ['cr', 'a\rb'],
    ['aspas', 'a"b'], ['e-comercial', 'a&b'], ['tag', '<script>'],
  ];
  for (const [nome, valor] of casos) {
    const xml = buildXml({ hosts: [{ name: 'H', host: 'h', port: 22, username: 'u',
      auth: { type: 'password', password: valor } }] }, { includeSecrets: true });
    // TAB/LF/CR precisam sair como referência numérica: crus, a normalização
    // de valor de atributo do XML os transforma em espaço na leitura.
    if (['tab', 'lf', 'cr'].includes(nome)) {
      const ref = { tab: '&#9;', lf: '&#10;', cr: '&#13;' }[nome];
      ok(xml.includes(ref), `${nome} deveria virar ${ref} dentro do atributo`);
      ok(!/password="[^"]*[\t\n\r]/.test(xml), `${nome} saiu cru no atributo`);
    } else {
      ok(!xml.includes(`password="${valor}"`), `${nome} saiu sem escape`);
    }
  }
  // U+FFFE/U+FFFF não são caracteres XML válidos: um só inutiliza o arquivo
  // INTEIRO, não apenas o campo.
  const xml = buildXml({ hosts: [{ name: 'H￿', host: 'h￾', port: 22, username: 'u' }] });
  ok(!/[￾￿]/.test(xml), 'noncharacters Unicode não podem chegar ao arquivo');
}

// ---------- 6. segredos só saem quando pedidos ----------

{
  const dados = { hosts: [HOST_REF], settings: { apiKey: 'sk-ant-SEGREDO' } };
  const limpo = buildXml(dados);
  ok(!limpo.includes('S3nh4!'), 'senha não sai do export padrão');
  ok(!limpo.includes('sk-ant-SEGREDO'), 'chave da API não sai do export padrão');
  ok(limpo.includes('hasPassword="true"'), 'mas o export registra que existia senha');
  ok(limpo.includes('includesSecrets="false"'), 'e se declara sem segredos');

  const comTudo = buildXml(dados, { includeSecrets: true });
  ok(comTudo.includes('S3nh4!'), 'com includeSecrets a senha sai');
  ok(comTudo.includes('sk-ant-SEGREDO'), 'com includeSecrets a chave sai');
  ok(comTudo.includes('includesSecrets="true"'), 'e o arquivo se declara sensível');
}

// ---------- 7. favoritos carregam a referência completa do host ----------

{
  const xml = buildXml({
    hosts: [{ id: 'h1', name: 'Firewall', host: '10.0.0.1', port: 22, username: 'admin' }],
    favorites: [{ label: 'vpn', command: 'reiniciar vpn', hostId: 'h1' },
      { label: 'geral', command: 'uptime' },
      { label: 'orfao', command: 'ls', hostId: 'sumiu' }],
  });
  // `<favorites>` também contém '<favorite': casa pela tag de fechamento.
  const favs = xml.split('\n').filter((l) => l.includes('</favorite>'));
  igual(favs.length, 2, 'favorito de host inexistente não vai para o arquivo');
  const preso = favs.find((l) => l.includes('vpn'));
  for (const a of ['host', 'hostAddr', 'hostPort', 'hostUser']) {
    ok(preso.includes(`${a}="`), `favorito preso a host precisa levar ${a}`);
  }
  ok(!favs.find((l) => l.includes('geral')).includes('hostAddr='),
    'favorito global não inventa referência de host');
}

console.log(`\n${n} verificações passaram`);
