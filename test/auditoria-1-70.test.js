'use strict';

// Guardas das correções da auditoria da v1.70.0.
//
// Cada bloco aqui existe porque um comportamento errado passou despercebido por
// meses e só apareceu numa varredura. O teste não repete o conserto: ele fixa a
// PROPRIEDADE que o conserto criou, para ela não voltar a se perder numa
// refatoração futura.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

const raiz = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8');

// ---------- 1. acentuação não pode ser partida na fronteira do pacote ----------

// Um caractere acentuado ocupa 2 bytes em UTF-8. Quando eles caem em pacotes
// TCP diferentes, `buf.toString('utf8')` por pacote produz dois losangos pretos
// no lugar da letra — e a saída de um servidor em português fica ilegível.
{
  const { StringDecoder } = require('string_decoder');
  const texto = 'configuração não é ação — çãõ';
  const bytes = Buffer.from(texto, 'utf8');

  // Como era: cada pedaço decodificado por si.
  let cru = '';
  for (let i = 0; i < bytes.length; i += 3) cru += bytes.slice(i, i + 3).toString('utf8');
  ok(cru.includes('\uFFFD'), 'o cenário do defeito precisa mesmo quebrar sem o decodificador');

  // Como ficou: o decodificador guarda o byte incompleto para o pacote seguinte.
  const dec = new StringDecoder('utf8');
  let bom = '';
  for (let i = 0; i < bytes.length; i += 3) bom += dec.write(bytes.slice(i, i + 3));
  bom += dec.end();
  igual(bom, texto, 'decodificando em fluxo, o texto sai inteiro');

  // E os três caminhos de terminal usam o decodificador, não o toString por pacote.
  for (const arq of ['lib/terminal.js', 'lib/localterm.js']) {
    const fonte = ler(arq);
    ok(fonte.includes("require('string_decoder')"), `${arq} importa o StringDecoder`);
    ok(!/\bon\('data',\s*\(\w+\)\s*=>\s*send\(\{\s*t:\s*'o',\s*d:\s*\w+\.toString\('utf8'\)/.test(fonte),
      `${arq} não decodifica pacote a pacote`);
  }
}

// ---------- 2. streams do shell local precisam de ouvinte de 'error' ----------

// EPIPE chega ASSÍNCRONO: o try/catch em volta do write não pega, e stream sem
// ouvinte de 'error' derruba o processo — que aqui é o main do Electron, com
// todas as abas, sessões SSH e o agente dentro.
{
  const fonte = ler('lib/localterm.js');
  ok(/child\.stdin\.on\('error'/.test(fonte), 'o stdin do shell local tem ouvinte de error');
  ok(/child\.stdio\[3\]\.on\('error'/.test(fonte), 'o cano de redimensionamento tem ouvinte de error');
  ok(/function usuarioLocal\(\)/.test(fonte) && /catch \{ return \{ username:/.test(fonte),
    'os.userInfo() é chamado com proteção (usuário sem entrada no passwd)');
}

// ---------- 3. laços de sondagem não podem se sobrepor ----------

// `rodada()` é assíncrona e pode demorar mais que o intervalo. Sem guarda, o
// setInterval abria uma rodada por cima da outra e os processos de ping se
// multiplicavam até a máquina engasgar.
for (const arq of ['lib/mtr.js', 'lib/monitor.js', 'lib/tcpping.js']) {
  const fonte = ler(arq);
  ok(/let emCurso = false;/.test(fonte), `${arq} declara a guarda de reentrância`);
  ok(/if \(emCurso\) return;/.test(fonte), `${arq} pula o tique quando a rodada anterior não terminou`);
  ok(/\.finally\(\(\) => \{ emCurso = false; \}\)/.test(fonte), `${arq} libera a guarda ao fim da rodada`);
}

// ---------- 4. o histórico de um lote não pode apagar o histórico ----------

// lib/vars.js expande até 6000 comandos por host; o histórico guarda 5000
// entradas no total. Um único lote grande jogava fora semanas de comandos.
{
  const fonte = ler('server.js');
  ok(/HIST_LOTE_MAX/.test(fonte), 'a rota de execução tem um teto de histórico por lote');
  const teto = Number((/const HIST_LOTE_MAX = (\d+);/.exec(fonte) || [])[1]);
  const historia = ler('lib/history.js');
  const maxEntradas = Number((/MAX_ENTRIES = (\d+)/.exec(historia) || [])[1]);
  ok(teto > 0 && maxEntradas > 0, 'os dois tetos são legíveis no fonte');
  ok(teto < maxEntradas,
    `o teto por lote (${teto}) precisa ser MENOR que o do histórico (${maxEntradas}), senão um lote só o esvazia`);
  const vars = ler('lib/vars.js');
  const porHost = Number((/MAX_TOTAL_COMMANDS = (\d+)/.exec(vars) || [])[1]);
  ok(porHost > maxEntradas,
    'este teste só faz sentido porque um host sozinho pode expandir mais comandos do que o histórico guarda');
}

// ---------- 5. a chave do cofre não entra pelo backup ----------

// A regra do projeto é que o segredo do cofre nunca vai ao disco. O cadastro
// pela tela respeitava; a importação de XML não, e isso reabria o caminho em
// silêncio — inclusive regravando a chave em todo export seguinte.
{
  const fonte = ler('server.js');
  const i = fonte.indexOf("app.post('/api/import'");
  ok(i > 0, 'achei a rota de importação');
  const rota = fonte.slice(i, i + 20000);
  const j = rota.indexOf('for (const c of asArray(body.cofres))');
  ok(j > 0, 'achei o laço de cofres da importação');
  const bloco = rota.slice(j, j + 2200);
  ok(/camposSecretos\(tipo\)/.test(bloco),
    'o import consulta quais campos são secretos antes de copiar a configuração');
  ok(/secretas\.has\(chave\)/.test(bloco) && /continue;/.test(bloco),
    'o import PULA o campo secreto em vez de gravá-lo no data.json');

  // E o helper que ele usa precisa mesmo apontar a chave dos adaptadores.
  const cofres = require('../lib/cofres');
  for (const a of cofres.ADAPTADORES) {
    const secretos = cofres.camposSecretos(a.tipo);
    const declarados = a.config.filter((c) => c.segredo).map((c) => c.chave);
    igual(secretos, declarados, `camposSecretos("${a.tipo}") bate com o adaptador`);
  }
}

// ---------- 6. chaves ilegíveis não podem ser sobrescritas ----------

// `ler()` devolve {} quando o arquivo existe mas não pôde ser aberto (Keychain
// recusou, app reassinado, rodando fora do Electron) — e o `gravar()` seguinte
// regravava o arquivo a partir desse {}, destruindo as chaves dos outros cofres.
{
  const fonte = ler('lib/cofresegredos.js');
  ok(/let ilegivel = false;/.test(fonte), 'existe a marca de arquivo ilegível');
  ok(/if \(ilegivel && fs\.existsSync\(ARQUIVO\)\) \{[\s\S]{0,200}throw new Error/.test(fonte),
    'gravar() recusa escrever por cima do que não conseguiu ler');
  const servidor = ler('server.js');
  ok(/catch \(e\) \{ return fail\(res, 409, e\.message\); \}/.test(servidor),
    'a recusa vira mensagem na tela, e não "Erro 500"');
}

// ---------- 7. queda de certificado confiável para autoassinado é troca ----------

// Um cofre com certificado de CA pública nunca ganhava pino. No dia em que um
// autoassinado aparecesse no lugar dele, o TOFU fixaria o impostor e mandaria
// o token na primeira aparição.
{
  const fonte = ler('lib/cofres/http.js');
  ok(/const CADEIA_CONFIAVEL = 'cadeia-confiavel';/.test(fonte), 'existe a sentinela de cadeia confiável');
  ok(/if \(!cfg\.certificadoFixado && typeof aoFixar === 'function'\) aoFixar\(CADEIA_CONFIAVEL\);/.test(fonte),
    'a cadeia confiável também é registrada como pino');
  ok(/cfg\.certificadoFixado === CADEIA_CONFIAVEL/.test(fonte),
    'a mensagem distingue "caiu de confiável para autoassinado" de "trocou de certificado"');
  ok(!/^sha256\//.test('cadeia-confiavel'), 'a sentinela não colide com uma impressão real');
}

// ---------- 8. o recolhimento de pins não roda com listagem incompleta ----------

// Um 502 só na listagem de segredos fazia o recolhimento concluir "ninguém mais
// existe" e apagar TODOS os pins TOFU dos hosts espelhados.
{
  const fonte = ler('lib/dadosdecofre.js');
  ok(/e\.segredosIncompletos = false;/.test(fonte), 'a marca é zerada antes de cada tentativa');
  ok(/e\.segredosIncompletos = true;/.test(fonte), 'a marca é ligada quando a listagem falha');
  ok(/e\.segredosTruncados \|\| e\.segredosIncompletos\) return;/.test(fonte),
    'o recolhimento desiste quando a listagem veio incompleta');
}

// ---------- 9. round-trip do backup: nada pode morrer no caminho ----------

// Um campo que o import LÊ mas o export nunca ESCREVE some a cada restauração.
// Já aconteceu três vezes neste projeto; estas são as duas últimas.
{
  const exportador = ler('lib/exportxml.js');
  const parser = ler('public/app.js');
  const servidor = ler('server.js');

  ok(/espelharSistemas: c\.espelharSistemas === false \? 'false' : 'true'/.test(exportador),
    'o export grava espelharSistemas do cofre');
  ok(/espelharSistemas: c\.getAttribute\('espelharSistemas'\) !== 'false'/.test(parser),
    'o parser do navegador lê espelharSistemas');
  ok(/const espelharSistemas = c\.espelharSistemas !== false;/.test(servidor),
    'o import aplica espelharSistemas');

  ok(/abrirLocalSozinho: ui\.abrirLocalSozinho === true/.test(exportador),
    'o export grava a preferência de abrir o terminal local sozinho');
  ok(/'sidebarCollapsed', 'abrirLocalSozinho'/.test(parser),
    'o parser lê a mesma preferência');
}

// ---------- 10. restauração confere o formato, não só "é JSON" ----------

// Um array, uma string ou o arquivo de outro programa passavam pelo JSON.parse:
// o app reabria vazio, sem diagnóstico, com o backup bom já sobrescrito.
{
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-restaura-'));
  const antes = process.env.SSHC_DATA_DIR;
  process.env.SSHC_DATA_DIR = dir;
  delete require.cache[require.resolve('../lib/store')];
  const store = require('../lib/store');
  // O aviso de "saves travados" é o comportamento certo, mas o rodar.js lê a
  // ÚLTIMA linha da saída para contar as verificações — e stderr entra depois
  // de stdout. Silenciado só aqui.
  const avisoOriginal = console.warn;
  console.warn = () => {};

  const bom = path.join(dir, 'bom.json');
  fs.writeFileSync(bom, JSON.stringify({ hosts: [{ id: 'a', name: 'srv' }], playbooks: [] }));
  const ruins = {
    'um array': '[]',
    'uma string': '"oi"',
    'objeto sem hosts': '{"playbooks":[]}',
    'hosts que não é lista': '{"hosts":{}}',
  };
  for (const [rotulo, conteudo] of Object.entries(ruins)) {
    const f = path.join(dir, 'ruim.json');
    fs.writeFileSync(f, conteudo);
    let lancou = false;
    try { store.restaurarDeArquivo(f); } catch { lancou = true; }
    ok(lancou, `restaurar recusa ${rotulo}`);
  }
  ok(!fs.existsSync(store.arquivo()), 'nenhuma tentativa recusada chegou a escrever o data.json');
  store.restaurarDeArquivo(bom);
  ok(fs.existsSync(store.arquivo()), 'um backup de verdade continua restaurando');

  console.warn = avisoOriginal;
  if (antes === undefined) delete process.env.SSHC_DATA_DIR; else process.env.SSHC_DATA_DIR = antes;
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 11. a suíte de testes não pode pendurar em silêncio ----------

// Foi assim que o teste de escopo global deixou de rodar por meses: um arquivo
// anterior travava, `spawnSync` esperava para sempre, e o terminal ficava mudo.
{
  const fonte = ler('test/rodar.js');
  ok(/timeout: \d+/.test(fonte), 'cada teste roda com prazo');
  ok(/killSignal: 'SIGKILL'/.test(fonte), 'o teste travado é morto de verdade');
  ok(/ETIMEDOUT/.test(fonte), 'o travamento é NOMEADO na saída, em vez de virar erro genérico');
}

// ---------- 12. o app não navega para fora de si mesmo ----------
{
  const fonte = ler('desktop/main.js');
  ok(/win\.webContents\.on\('will-navigate'/.test(fonte),
    'a janela principal recusa navegar para fora do app');
  ok(/if \(\/\^https\?:\\\/\\\/\/i\.test\(url\)\) shell\.openExternal\(url\);/.test(fonte),
    'só http/https saem para o navegador do sistema');
  ok(/Menu\.setApplicationMenu/.test(fonte), 'o app define o próprio menu');
  ok(!/role: 'reload'|role: 'forceReload'/.test(fonte),
    'o menu não tem recarregar — dentro do RDP, Win+R chegava como Cmd+R e derrubava tudo');
  ok(/require\('\.\.\/lib\/agent'\)\.matarLocais\(\)/.test(fonte),
    'fechar o app mata os comandos locais do agente');
  ok(/require\('\.\.\/lib\/history'\)\.flush\(\)/.test(fonte),
    'fechar o app grava o histórico pendente');
}

console.log(`\n${n} verificações passaram`);
