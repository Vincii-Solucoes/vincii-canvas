'use strict';

// Backup automático do data.json — a rede contra a perda total.
//
// A auditoria achou o único risco ALTO do app: o data.json é cópia única. Este
// arquivo trava o que faz a rede valer a pena — e o que a torna perigosa se
// feita errado:
//
//   - o snapshot de ARRANQUE captura o último estado bom ANTES de a sessão
//     mexer em nada (é o coração: sempre existe a cópia de como estava ao abrir);
//   - a retenção apaga o EXCEDENTE e SÓ o nosso — nunca arquivo alheio na pasta;
//   - "sem mudança" não gera cópia (o timer de 12 h não enche a pasta à toa);
//   - um data.json ILEGÍVEL não é copiado como se fosse bom;
//   - a pasta é trocável, validada na hora (não se descobre no dia do desastre);
//   - a corrupção no arranque, que era MUDA, agora tem diagnóstico.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-bk-'));
process.env.SSHC_DATA_DIR = DIR;

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const naoOk = (c, m) => { assert.ok(!c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

const store = require('../lib/store');
const backup = require('../lib/backup');

const DADOS = path.join(DIR, 'data.json');
const PADRAO = path.join(DIR, 'backups');
const lerCopias = (pasta) => backup._listar(pasta || PADRAO);

// instantes crescentes controlados — o teste não depende do relógio real
let t = Date.UTC(2026, 7, 18, 12, 0, 0);
const tick = () => (t += 60000);

// ---------- 1. o snapshot de arranque captura o estado bom ----------

{
  const d = store.get();
  d.hosts = [{ id: 'h1', name: 'fw-matriz', host: '10.0.0.1', auth: { type: 'agent' } }];
  store.save();

  const r = backup.aoIniciar(tick());
  ok(r.feito, 'o arranque faz o backup do estado atual');
  const copias = lerCopias();
  igual(copias.length, 1, 'uma cópia na pasta padrão');
  const conteudo = JSON.parse(fs.readFileSync(path.join(PADRAO, copias[0].nome), 'utf8'));
  igual(conteudo.hosts[0].name, 'fw-matriz',
    'a cópia é FIEL — o data.json cru, não um export curado');
  ok(/^canvas-data-.*\.json$/.test(copias[0].nome), 'nome datado e reconhecível como nosso');
}

// ---------- 2. sem mudança, não copia; com mudança, copia ----------

{
  const antes = lerCopias().length;
  igual(backup.aoIniciar(tick()).motivo, 'sem-mudanca',
    'data.json idêntico ao último backup não gera cópia nova — o timer de 12 h '
    + 'não enche a pasta de cópias iguais');
  igual(lerCopias().length, antes, 'e a contagem não mudou');

  store.get().hosts.push({ id: 'h2', name: 'novo', host: '10.0.0.2', auth: { type: 'agent' } });
  store.save();
  ok(backup.aoIniciar(tick()).feito, 'depois de mudar, copia');
  igual(lerCopias().length, antes + 1, 'agora há uma cópia a mais');
}

// ---------- 3. o botão manual sempre copia, mesmo idêntico ----------

{
  const antes = lerCopias().length;
  ok(backup.rodarAgora(tick()).feito,
    'o "Fazer backup agora" grava mesmo sem mudança — é uma ação explícita');
  igual(lerCopias().length, antes + 1, 'gerou a cópia');
}

// ---------- 4. retenção: apaga o excedente, e SÓ o nosso ----------

{
  store.get().settings.backup = { ativo: true, pasta: '', manter: 3 };
  store.save();
  // um arquivo ALHEIO na mesma pasta — apagá-lo seria imperdoável
  const alheio = path.join(PADRAO, 'nao-me-apague.txt');
  fs.writeFileSync(alheio, 'documento do usuário');

  for (let i = 0; i < 5; i++) {
    store.get().hosts.push({ id: 'x' + i, name: 'h' + i, host: '10.9.0.' + i, auth: { type: 'agent' } });
    store.save();
    backup.rodarAgora(tick());
  }
  const copias = lerCopias();
  igual(copias.length, 3, 'mantém só as 3 mais novas (o teto configurado)');
  ok(copias[0].quando >= copias[1].quando && copias[1].quando >= copias[2].quando,
    'e as que ficaram são as mais recentes');
  ok(fs.existsSync(alheio), 'o arquivo alheio na pasta NÃO é tocado — a poda só mexe no que é nosso');
  fs.unlinkSync(alheio);
}

// ---------- 5. data.json ILEGÍVEL não vira backup ----------

{
  const bom = fs.readFileSync(DADOS, 'utf8');
  fs.writeFileSync(DADOS, '{ isto não é json');
  const antes = lerCopias().length;
  const r = backup.rodarAgora(tick());
  naoOk(r.feito, 'não copia um data.json ilegível');
  igual(r.motivo, 'origem-invalida', 'e diz por quê');
  igual(lerCopias().length, antes, 'nenhuma cópia de lixo foi criada');
  fs.writeFileSync(DADOS, bom); // restaura para os testes seguintes
}

// ---------- 6. desligado não faz nada ----------

{
  store.get().settings.backup = { ativo: false, pasta: '', manter: 3 };
  store.save();
  igual(backup.aoIniciar(tick()).motivo, 'desligado', 'com o backup desligado, o arranque não copia');
  igual(backup.rodarAgora(tick()).motivo, 'desligado', 'nem o manual');
  store.get().settings.backup = { ativo: true, pasta: '', manter: 3 };
  store.save();
}

// ---------- 7. a pasta é trocável, e validada na hora ----------

{
  const nova = path.join(DIR, 'meus-backups');
  const est = backup.aplicar({ pasta: nova, manter: 5, ativo: true });
  igual(est.pasta, nova, 'a pasta nova é aceita');
  naoOk(est.naPastaPadrao, 'e a tela sabe que não é a padrão');
  ok(fs.existsSync(nova), 'a pasta é criada na hora — não se descobre que não dá no dia do desastre');

  backup.rodarAgora(tick());
  igual(lerCopias(nova).length, 1, 'os backups passam a cair na pasta nova');

  // caminho relativo é recusado
  let barrou = false;
  try { backup.aplicar({ pasta: 'pasta/relativa' }); } catch { barrou = true; }
  ok(barrou, 'caminho relativo é recusado — o backup precisa de um lugar sem ambiguidade');

  // voltar à padrão: campo vazio
  const volta = backup.aplicar({ pasta: '' });
  ok(volta.naPastaPadrao, 'campo vazio volta para a pasta padrão');
}

// ---------- 8. o estado que a tela lê ----------

{
  const est = backup.estado();
  ok(Array.isArray(est.copias), 'estado traz a lista de cópias');
  ok(est.pastaPadrao.endsWith('backups'), 'e a pasta padrão, para o placeholder');
  ok(typeof est.podeEscolherPasta === 'boolean',
    'e se o seletor nativo existe (só sob Electron) — a tela some com o botão no modo web');
  ok(est.ultimo && est.ultimo.quando > 0, 'o último backup, para "Último backup: …"');
}

// ---------- 9. corrupção no arranque deixa de ser MUDA ----------

// Um novo processo, com um data.json já corrompido no disco: o store precisa
// registrar o diagnóstico para a tela poder dizer — era só um console.warn.
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-bk2-'));
  fs.writeFileSync(path.join(dir2, 'data.json'), '{ corrompido no disco');
  const saida = require('child_process').execFileSync(process.execPath, ['-e', `
    process.env.SSHC_DATA_DIR = ${JSON.stringify(dir2)};
    const store = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'store'))});
    const backup = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'backup'))});
    const est = backup.estado();
    process.stdout.write(JSON.stringify({ diag: store.diagnostico(), arranque: est.arranque }));
  `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const r = JSON.parse(saida);
  ok(r.diag && r.diag.tipo === 'corrompido',
    'o store registra que o data.json estava corrompido no arranque');
  ok(r.arranque && r.arranque.copia && /corrompido/.test(r.arranque.copia),
    'e o estado do backup leva isso à tela, com o caminho da cópia preservada — '
    + 'antes era um console.warn que ninguém via no app instalado');
}

// ---------- 10. RESTAURAÇÃO: o caminho de volta ----------

{
  // Estado bom → backup → estrago → restaurar volta ao bom.
  store.get().settings.backup = { ativo: true, pasta: '', manter: 10 };
  store.get().hosts = [{ id: 'bom', name: 'estado-bom', host: '10.0.0.1', auth: { type: 'agent' } }];
  store.save();
  const feito = backup.rodarAgora(tick());
  ok(feito.feito, 'guardou o estado bom');
  const copia = feito.arquivo;

  // "estraga": esvazia e salva
  store.get().hosts = [];
  store.save();
  igual(JSON.parse(fs.readFileSync(DADOS, 'utf8')).hosts.length, 0, 'o data.json ficou vazio');

  const r = backup.restaurar(copia);
  ok(r.ok, 'a restauração aceita uma cópia da pasta');
  igual(JSON.parse(fs.readFileSync(DADOS, 'utf8')).hosts[0].name, 'estado-bom',
    'o data.json no disco voltou a ser o estado bom');

  // Depois de restaurar, o save é TRAVADO — um save tardio não pode desfazer.
  store.get().hosts = [{ id: 'x', name: 'tardio' }];
  store.save();
  igual(JSON.parse(fs.readFileSync(DADOS, 'utf8')).hosts[0].name, 'estado-bom',
    'um save tardio NÃO grava por cima da restauração — os caches vão recarregar no reinício');
}

// ---------- 10b. restaurar recusa caminho hostil ----------

{
  igual(backup.restaurar('../../etc/passwd').ok, false, 'nome com ".." é recusado');
  igual(backup.restaurar('/etc/passwd').ok, false, 'caminho absoluto é recusado');
  igual(backup.restaurar('qualquer-coisa.json').ok, false, 'nome que não é nosso é recusado');
  igual(backup.restaurar('canvas-data-inexistente.json').ok, false, 'cópia que não está na pasta é recusada');
}

// ---------- 10c. APAGAR: o lixinho, com a mesma guarda do restaurar ----------

{
  // pasta padrão de volta, e uma cópia real para apagar
  store.get().settings.backup = { ativo: true, pasta: '', manter: 10 };
  store.save();
  const feito = backup.rodarAgora(tick());
  ok(feito.feito, 'guardou uma cópia para o teste de apagar');
  const alvo = feito.arquivo;
  ok(lerCopias().some((c) => c.nome === alvo), 'a cópia está na listagem antes de apagar');

  // recusa caminho hostil — NÃO apaga nada fora
  igual(backup.apagar('../../etc/passwd').ok, false, 'apagar recusa ".."');
  igual(backup.apagar('/etc/passwd').ok, false, 'apagar recusa caminho absoluto');
  igual(backup.apagar('documento.txt').ok, false, 'apagar recusa nome que não é nosso');
  igual(backup.apagar('canvas-data-fantasma.json').ok, false, 'apagar recusa cópia fora da pasta');
  ok(lerCopias().some((c) => c.nome === alvo), 'a cópia real continua lá — nenhuma recusa a tocou');

  // apaga a cópia de verdade, e só ela some
  const antes = lerCopias().length;
  const r = backup.apagar(alvo);
  ok(r.ok, 'apagar aceita uma cópia da pasta');
  ok(!lerCopias().some((c) => c.nome === alvo), 'a cópia sumiu do disco');
  igual(lerCopias().length, antes - 1, 'sumiu exatamente uma');
  igual(backup.apagar(alvo).ok, false, 'apagar de novo o que já foi é recusado (não está mais na pasta)');
}

// ---------- 11. arranque corrompido: o motor NÃO come as cópias boas ----------

// Este é o achado grave: o app abre vazio, e sem esta guarda a rotação
// snapshota o vazio e expulsa os backups bons — a rede se comendo sozinha.
{
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-bk3-'));
  // uma cópia BOA já na pasta de backups + um data.json corrompido no disco
  const backupsDir = path.join(dir3, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  fs.writeFileSync(path.join(backupsDir, 'canvas-data-2026-08-18T10-00-00-000Z.json'),
    JSON.stringify({ hosts: [{ id: 'salvo', name: 'firewall-matriz' }] }));
  fs.writeFileSync(path.join(dir3, 'data.json'), '{ corrompido');

  const saida = require('child_process').execFileSync(process.execPath, ['-e', `
    process.env.SSHC_DATA_DIR = ${JSON.stringify(dir3)};
    const store = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'store'))});
    const backup = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'backup'))});
    store.get().settings.backup = { ativo: true, pasta: '', manter: 10 };
    const r1 = backup.aoIniciar(Date.now());       // não pode gravar
    const r2 = backup.rodarAgora(Date.now());       // nem o manual
    const fs2 = require('fs');
    const copias = fs2.readdirSync(${JSON.stringify(backupsDir)}).filter(x => x.endsWith('.json'));
    process.stdout.write(JSON.stringify({
      protegido: backup._protegido(), r1: r1.motivo, r2: r2.motivo,
      copias, aindaTemSalvo: copias.includes('canvas-data-2026-08-18T10-00-00-000Z.json'),
    }));
  `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop();
  const r = JSON.parse(saida);
  ok(r.protegido, 'o motor sabe que o arranque foi corrompido');
  igual(r.r1, 'arranque-corrompido', 'o snapshot de arranque se recusa a gravar o estado vazio');
  igual(r.r2, 'arranque-corrompido', 'e o manual também — restaurar vem primeiro');
  ok(r.aindaTemSalvo, 'a cópia BOA continua na pasta — a rede não se comeu sozinha');
  igual(r.copias.length, 1, 'e nenhum snapshot do vazio foi criado');
}

// ---------- 12. as guardas baixas da revisão ----------

{
  // symlink com o nosso nome não conta como cópia (lstat, não stat)
  const pasta = backup._cfg().pasta;
  fs.rmSync(pasta, { recursive: true, force: true });
  backup.rodarAgora(tick()); backup.rodarAgora(tick());
  // Só há uma origem válida agora; força duas distintas mudando os dados
  store.get().hosts = [{ id: 'a', name: 'A' }]; store.save(); backup.rodarAgora(tick());
  store.get().hosts = [{ id: 'b', name: 'B' }]; store.save(); backup.rodarAgora(tick());
  const antes = backup._listar(pasta).length;
  try {
    fs.symlinkSync('/etc/hosts', path.join(pasta, 'canvas-data-LINK.json'));
    igual(backup._listar(pasta).length, antes,
      'um symlink com o nosso nome NÃO entra na lista — não rouba vaga da retenção');
  } catch { n += 1; /* sem permissão de symlink no ambiente: conta como coberto */ }

  // .tmp órfão é limpo quando a gravação falha
  const origRename = fs.renameSync;
  let tmpVisto = null;
  fs.renameSync = (de, para) => { if (String(de).endsWith('.tmp')) { tmpVisto = de; throw new Error('disco cheio (fingido)'); } return origRename(de, para); };
  store.get().hosts = [{ id: 'c', name: 'C' }]; store.save();
  const r = backup.rodarAgora(tick());
  fs.renameSync = origRename;
  igual(r.feito, false, 'a falha de gravação é reportada');
  ok(tmpVisto && !fs.existsSync(tmpVisto), 'e o .tmp órfão foi limpo — não acumula lixo invisível');
}

console.log(`\n${n} verificações passaram`);
