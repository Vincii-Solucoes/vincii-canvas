'use strict';

// Testes do adaptador do Homem Vitruviano.
//
// O que este arquivo existe para travar são as quatro diferenças entre este
// produto e o contrato aberto — todas com falha silenciosa:
//
//   1. DOIS ENVELOPES DE ERRO. Ler só `{erro:{codigo}}` faz todo erro de
//      validação do ERP (`{error:{code}}`, em inglês) cair no palpite genérico e
//      virar "indisponivel". Aí o núcleo insiste três vezes contra um parâmetro
//      que ele mesmo mandou errado, e a mensagem que chega ao usuário é
//      "o cofre está fora do ar" — que é mentira.
//   2. `indisponivel` (503) NÃO É TRANSITÓRIO aqui: significa "cofre sem chave
//      de cifra". A lista fixa do núcleo diz que é; quem manda é o adaptador.
//   3. PAGINAÇÃO. `proximoCursor` vem sempre, com null só na última página.
//      Parar na primeira esconde segredos sem nenhum sinal de erro.
//   4. A JANELA vem do ERP como dado de rede não confiável e vai direto para a
//      regra que decide se a tela do host fica travada aberta.

const assert = require('assert');
const adaptador = require('../lib/cofres/vitruviano');
const fake = require('./vitruviano-local');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const naoOk = (c, m) => { assert.ok(!c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// Erro esperado: devolve o ErroDeCofre em vez de deixar o teste passar por
// engano quando a chamada NÃO falha.
async function falha(fn, mensagem) {
  try {
    await fn();
  } catch (e) {
    n += 1;
    return e;
  }
  assert.fail(`${mensagem} — mas a chamada foi bem-sucedida`);
}

async function comServidor(modos, corpo) {
  const s = fake.criar(modos);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const cfg = { baseUrl: `http://127.0.0.1:${s.address().port}/api/cofre/v1`, chave: fake.TOKEN };
  try { return await corpo(cfg, s); }
  finally { await new Promise((r) => s.close(r)); }
}

(async () => {

  // ---------- ping: clientes e janelas ----------

  await comServidor({}, async (cfg) => {
    const r = await adaptador.ping(cfg);
    igual(r.produto, 'Homem Vitruviano', 'o ping identifica o produto');
    igual(r.permissoes, ['ler'], 'e as permissões da chave');
    igual(r.rotuloDaChave, 'Canvas — laboratório', 'e o rótulo, para a tela dizer qual token é');
    igual(r.cofres.length, fake.CLIENTES.length, 'todos os clientes atendidos vêm');
    igual(r.cofres[0].nome, 'Velonic', 'com nome para a tela');
    ok(r.cofres[0].janela && r.cofres[0].janela.turnos.length === 1,
      'a janela de atendimento vem junto do cliente, normalizada');
    igual(r.cofres[1].janela.excecoes.length, 2,
      'inclusive as exceções (feriado e véspera reduzida)');
    // As DUAS escritas de 24 h: a que a produção manda (fecha o círculo) e a do
    // exemplo do documento. Enquanto o fake só tinha a segunda, uma mudança que
    // quebrou a primeira passou por toda a suíte sem acusar nada.
    igual(r.cofres[0].janela.turnos[0].fim, '00:00',
      'a janela 24 h da Velonic fecha o círculo, como a produção manda');
    igual(r.cofres[2].janela.turnos[0].fim, '23:59',
      'e o terceiro cliente usa a escrita do documento — as duas ficam exercitadas');

    // `semJanela` (16/08): a ausência de janela GANHOU NOME — e são dois nomes,
    // porque os consertos são diferentes (cadastrar turnos x ligar o
    // encaminhamento). A trava do cofre vale nos dois.
    const santa = r.cofres.find((c) => c.nome === 'Santa Clara Resort');
    igual(santa.semJanela, 'sem_turnos',
      'cliente sem turno cadastrado diz sem_turnos — a credencial nunca abre');
    igual(santa.janela, null, 'e segue sem janela, claro');
    igual(r.cofres.find((c) => c.nome === 'Rede Fibra').semJanela, 'encaminhamento_desativado',
      'encaminhamento desligado diz encaminhamento_desativado — abre por clique, no horário');
    igual(r.cofres[0].semJanela, '',
      'cliente COM janela não carrega estado de ausência');
  });

  // Cliente sem janela é caso previsto — e é diferente de janela vazia.
  await comServidor({ semJanela: true }, async (cfg) => {
    const r = await adaptador.ping(cfg);
    igual(r.cofres[0].janela, null,
      'cliente sem horário declarado devolve null, não uma janela que nunca abre — '
      + 'a diferença decide entre "não trava a tela" e "trava para sempre fechada"');
  });

  // Estado de ausência INVENTADO não passa: a tela escolhe frase por estado, e
  // um estado desconhecido viraria texto sem sentido no cartão do host.
  await comServidor({}, async (cfg) => {
    const original = fake.CLIENTES.find((c) => c.nome === 'Santa Clara Resort');
    const antes = original.semJanela;
    original.semJanela = 'ferias-coletivas';
    try {
      const r = await adaptador.ping(cfg);
      igual(r.cofres.find((c) => c.nome === 'Santa Clara Resort').semJanela, '',
        'valor fora dos dois estados do contrato é descartado, como protocolo estranho');
    } finally { original.semJanela = antes; }
  });

  // ---------- funcionario_inativo (16/08): a conta inteira, não um cliente ----------

  await comServidor({ funcionarioInativo: true }, async (cfg) => {
    // O ping continua identificando a chave — é pelas rotas de DADOS que o
    // desligamento fala.
    const r = await adaptador.ping(cfg);
    ok(r.cofres.length > 0, 'o ping responde mesmo para a conta desligada');

    for (const [nome, chamada] of [
      ['secrets sem filtro', () => adaptador.listar(cfg, { limite: 50 })],
      ['sistemas', () => adaptador.sistemas(cfg, {})],
      ['leitura de segredo', () => adaptador.ler(cfg, fake.SEGREDOS[0].id)],
    ]) {
      try {
        await chamada();
        assert.fail(`${nome} deveria ter recusado a conta desligada`);
      } catch (e) {
        igual(e.codigo, 'funcionario_inativo',
          `${nome} devolve o código próprio — antes a listagem sem filtro vinha `
          + '200 [] muda e a tela sugeria "peça acesso" para uma conta desativada');
        n += 1;
        ok(!e.transitorio, 'e é definitivo: insistir não recontrata ninguém');
      }
    }
  });

  // ---------- a janela do ERP alimenta a regra de horário ----------

  await comServidor({}, async (cfg) => {
    const { estaEmAtendimento } = require('../public/janela');
    const r = await adaptador.ping(cfg);
    const velonic = r.cofres.find((c) => c.nome === 'Velonic');
    const maylink = r.cofres.find((c) => c.nome === 'Maylink');

    // 2026-08-10 é uma segunda. 15:00Z = 12:00 em Brasília.
    ok(estaEmAtendimento(velonic.janela, new Date('2026-08-10T15:00:00Z')),
      'cliente 24h está em atendimento ao meio-dia de segunda');
    ok(estaEmAtendimento(velonic.janela, new Date('2026-08-16T06:00:00Z')),
      'e também às 03:00 de domingo');

    ok(estaEmAtendimento(maylink.janela, new Date('2026-08-10T15:00:00Z')),
      'cliente comercial está em atendimento ao meio-dia de segunda');
    naoOk(estaEmAtendimento(maylink.janela, new Date('2026-08-10T02:00:00Z')),
      'mas não às 23:00 de domingo');
    naoOk(estaEmAtendimento(maylink.janela, new Date('2026-09-07T15:00:00Z')),
      'e o feriado declarado pelo ERP fecha o dia inteiro');
    ok(estaEmAtendimento(maylink.janela, new Date('2026-12-24T13:00:00Z')),
      'na véspera reduzida, 10:00 ainda atende');
    naoOk(estaEmAtendimento(maylink.janela, new Date('2026-12-24T17:00:00Z')),
      'e às 14:00 já não atende — a exceção substitui o turno normal');
  });

  // ---------- listagem: a paginação vai até o fim ----------

  await comServidor({}, async (cfg, s) => {
    // O fake devolve no máximo 2 por página; o total vem DELE, não de um número
    // decorado aqui — o fake cresce junto com o contrato, e um teste que fixa
    // "são 4" quebra a cada segredo novo sem apontar defeito nenhum.
    const r = await adaptador.listar(cfg, { limite: 50 });
    igual(r.itens.length, fake.SEGREDOS.length,
      'seguiu o proximoCursor até o fim — parar na primeira página esconderia '
      + 'metade dos segredos sem nenhum erro na tela');
    igual(r.proximoCursor, null, 'e diz que acabou');
    ok(s.diario.pedidos.length >= 2, 'o que exigiu mais de uma requisição');
    igual(r.itens[0].caminho, 'Produção', 'a pasta vem junto, para agrupar na tela');
    igual(r.itens[1].caminho, '',
      'caminho null da API vira string vazia — sem isso a tela imprime "null"');
    igual(r.itens[0].porta, 22, 'a porta sugerida vem como número');
    igual(r.itens[2].tipo, 'chave-ssh', 'e o tipo do segredo é preservado');
  });

  // Um `limite` menor precisa ser respeitado, senão o "carregar mais" da tela
  // baixa o cofre inteiro de uma vez.
  await comServidor({}, async (cfg) => {
    const r = await adaptador.listar(cfg, { limite: 2 });
    igual(r.itens.length, 2, 'o limite pedido é o teto real de itens devolvidos');
    ok(r.proximoCursor, 'e sobra cursor para continuar');
  });

  // O filtro por cliente é o que faz a mesa de trabalho de um cliente só.
  await comServidor({}, async (cfg) => {
    const r = await adaptador.listar(cfg, { cofre: fake.MAYLINK });
    igual(r.itens.length, fake.SEGREDOS.filter((s) => s.cliente === fake.MAYLINK).length,
      'filtrando por cliente vêm só os segredos dele');
    ok(r.itens.every((i) => i.nome !== 'root@web-01'), 'e nenhum do outro cliente');
  });

  // ---------- leitura: o valor do segredo ----------

  await comServidor({}, async (cfg, s) => {
    const senha = await adaptador.ler(cfg, fake.SEGREDOS[0].id);
    igual(senha.tipo, 'senha', 'segredo de senha vem com tipo senha');
    igual(senha.senha, 'senha-do-web-01', 'e com o valor');
    igual(senha.usuario, 'root', 'e o usuário sugerido pelo cofre');
    ok(senha.janela, 'a janela do cliente vem junto da leitura');
    igual(s.diario.lidos, [fake.SEGREDOS[0].id],
      'uma leitura por chamada — o valor não é buscado especulativamente');

    const chave = await adaptador.ler(cfg, fake.SEGREDOS[2].id);
    igual(chave.tipo, 'chave-ssh', 'segredo de chave vem com tipo chave-ssh');
    ok(chave.chavePrivada.includes('BEGIN OPENSSH PRIVATE KEY'), 'com a chave privada');
    igual(chave.passphrase, 'frase-secreta', 'e a passphrase quando existe');
    igual(chave.senha, undefined, 'e sem campo de senha');
  });

  // ---------- erros do CONTRATO (envelope `erro`, em português) ----------

  await comServidor({ expira: true }, async (cfg) => {
    const e = await falha(() => adaptador.ping(cfg), 'token vencido deveria falhar');
    igual(e.codigo, 'chave_expirada', 'token vencido tem código próprio, não "chave inválida"');
    igual(e.transitorio, false,
      'e NÃO é transitório: insistir com token morto é o que faz cofre bloquear a chave');
  });

  await comServidor({ inativo: true }, async (cfg) => {
    const e = await falha(() => adaptador.ping(cfg), 'cliente inativo deveria falhar');
    igual(e.codigo, 'cliente_inativo', 'contrato encerrado tem código próprio');
    igual(e.transitorio, false, 'e não melhora com retentativa');
  });

  await comServidor({ limite: true }, async (cfg) => {
    const e = await falha(() => adaptador.ping(cfg), '429 deveria falhar');
    igual(e.codigo, 'limite_de_taxa', '429 vira limite_de_taxa');
    igual(e.transitorio, true, 'que é o ÚNICO caso em que vale insistir');
    igual(e.esperaSegundos, 2, 'respeitando o Retry-After que o cofre mandou');
  });

  // O caso que fez o núcleo mudar: aqui 503 quer dizer "cofre sem chave de
  // cifra", e a documentação manda avisar o admin, não reintentar.
  await comServidor({ indisponivel: true }, async (cfg) => {
    const e = await falha(() => adaptador.ping(cfg), '503 deveria falhar');
    igual(e.codigo, 'indisponivel', '503 vira indisponivel');
    igual(e.transitorio, false,
      'mas NÃO transitório neste produto — a lista fixa do núcleo diz que 503 é '
      + 'para insistir, e aqui insistir gasta o limite de requisições contra uma parede');
  });

  await comServidor({}, async (cfg) => {
    const e = await falha(() => adaptador.ler(cfg, 'nao-existe'), 'id inexistente deveria falhar');
    igual(e.codigo, 'nao_encontrado', 'segredo apagado tem código próprio');
    igual(e.transitorio, false, 'e não volta a existir por insistência');
  });

  // ---------- erros do ERP (envelope `error`, em inglês) ----------
  //
  // Esta é a metade que um adaptador escrito só contra o contrato do cofre
  // perderia inteira.

  await comServidor({ erpValidation: true }, async (cfg) => {
    const e = await falha(() => adaptador.listar(cfg), 'validação do ERP deveria falhar');
    igual(e.codigo, 'requisicao_invalida',
      'erro em INGLÊS do ERP (error/validation_error) é lido — se só o envelope '
      + 'do cofre fosse lido, isto viraria "indisponivel" e o app insistiria');
    ok(e.message.includes('parâmetro'), 'e a mensagem diz de quem é a culpa: do Canvas');
    ok(e.message.includes('limite') && e.message.includes('must be between 1 and 200'),
      'sem jogar fora o detalhe que o ERP mandou — que no 422 mora em `details`, '
      + 'e não em `message`');
    igual(e.transitorio, false, 'parâmetro errado não conserta sozinho');
  });

  await comServidor({ erp500: true }, async (cfg) => {
    const e = await falha(() => adaptador.ping(cfg), 'internal_error deveria falhar');
    igual(e.codigo, 'indisponivel', 'internal_error do ERP vira indisponivel');
    igual(e.transitorio, false, 'e também não é para insistir');
  });

  // Os dois envelopes, lado a lado, no tradutor.
  {
    const t = adaptador._traduzirErro;

    // Rota errada: o ERP responde http_error, em inglês, antes de o cofre existir.
    const rota = t(404, { error: { code: 'http_error', message: 'Not Found' } }, {});
    igual(rota.codigo, 'requisicao_invalida',
      'http_error é erro DO CANVAS (chamou rota errada), e não "segredo não encontrado" — '
      + 'confundir os dois manda o usuário procurar um segredo que existe');
    ok(rota.message.includes('rota'), 'e a mensagem diz o que houve');

    // Mesmo status 404, envelope do cofre: aí sim é segredo inexistente.
    const segredo = t(404, { erro: { codigo: 'nao_encontrado', mensagem: 'Segredo apagado.' } }, {});
    igual(segredo.codigo, 'nao_encontrado', 'com o envelope do cofre, 404 é segredo apagado');
    igual(segredo.message, 'Segredo apagado.', 'e a mensagem do cofre chega inteira ao usuário');

    // Código que nenhum dos dois envelopes conhece: deduz pelo status, mas não
    // inventa que vale insistir.
    const novo = t(403, { erro: { codigo: 'codigo_do_futuro', mensagem: 'sei lá' } }, {});
    igual(novo.codigo, 'sem_permissao', 'código desconhecido cai para o significado do status');
    igual(novo.transitorio, false,
      'e nasce NÃO transitório: na dúvida, não insistir é o lado seguro — '
      + 'insistir com chave suspeita é o que faz cofre bloquear a chave');

    const semCorpo = t(429, null, { 'retry-after': '30' });
    igual(semCorpo.codigo, 'limite_de_taxa', 'resposta sem corpo ainda se traduz pelo status');
    igual(semCorpo.esperaSegundos, 30, 'e o Retry-After é obedecido mesmo sem corpo');

    const lixo = t(500, { erro: 'isto não é objeto', error: 42 }, {});
    igual(lixo.codigo, 'indisponivel', 'envelope malformado não derruba a tradução');
  }

  // ---------- token errado ----------

  await comServidor({}, async (cfg) => {
    const e = await falha(() => adaptador.ping({ ...cfg, chave: 'hvk_errado' }),
      'token errado deveria falhar');
    igual(e.codigo, 'chave_invalida', 'token desconhecido vira chave_invalida');
    igual(e.transitorio, false, 'e não é para insistir');
  });

  // ---------- a mesa de trabalho ----------

  await comServidor({}, async (cfg) => {
    const r = await adaptador.sistemas(cfg, { cofre: fake.VELONIC });
    igual(r.itens.length, 2, 'dois sistemas para a Velonic');
    igual(r.itens[0].nome, 'OPA', 'com nome');
    igual(r.itens[0].url, 'https://opa.velonic.com.br/atendente/', 'e URL para abrir');
    igual(r.itens[0].clienteNome, 'Velonic', 'sabendo de qual cliente é');
    igual(r.itens[1].campos, [{ nome: 'IP', valor: '10.0.0.5' }],
      'os campos livres do admin vêm junto');

    const todos = await adaptador.sistemas(cfg, {});
    igual(todos.itens.length, 3, 'sem filtro, vêm os sistemas de todos os clientes');
    const semUrl = todos.itens.find((s) => s.nome === 'Rede interna');
    igual(semUrl.url, '', 'sistema sem URL é previsto pela especificação e não quebra');
    igual(semUrl.campos, [], 'nem sistema sem campos');
  });

  // A URL vira `src` de webview dentro do app: o que não for http/https some.
  {
    const http2 = require('../lib/cofres/http');
    const original = http2.pedir;
    // Substitui o transporte para devolver uma resposta hostil sem precisar de
    // um servidor que minta — é a resposta que importa, não quem a mandou.
    require.cache[require.resolve('../lib/cofres/http')].exports.pedir = async () => ({
      itens: [
        { cofre: 'c', cofreNome: 'C', nome: 'javascript', url: 'javascript:alert(1)' },
        { cofre: 'c', cofreNome: 'C', nome: 'arquivo', url: 'file:///etc/passwd' },
        { cofre: 'c', cofreNome: 'C', nome: 'dados', url: 'data:text/html,<script>x</script>' },
        { cofre: 'c', cofreNome: 'C', nome: '   ', url: 'https://ok.example' },
        { cofre: 'c', cofreNome: 'C', nome: 'bom', url: 'https://ok.example' },
      ],
    });
    // O adaptador guarda a referência ao módulo, então recarrega para pegar o
    // transporte trocado.
    delete require.cache[require.resolve('../lib/cofres/vitruviano')];
    const adap2 = require('../lib/cofres/vitruviano');
    const r = await adap2.sistemas({ baseUrl: 'https://x', chave: 'k' }, {});
    igual(r.itens.length, 4, 'sistema sem nome é descartado — não daria para clicar mesmo');
    igual(r.itens.map((s) => s.url), ['', '', '', 'https://ok.example'],
      'javascript:, file: e data: viram string vazia — essa URL vira src de <webview> '
      + 'dentro do app, com acesso que uma aba de navegador não tem');
    require.cache[require.resolve('../lib/cofres/http')].exports.pedir = original;
    delete require.cache[require.resolve('../lib/cofres/vitruviano')];
  }

  // ---------- resposta malformada não vira credencial vazia ----------

  {
    const http2 = require('../lib/cofres/http');
    const original = http2.pedir;
    const responder = (corpo) => {
      require.cache[require.resolve('../lib/cofres/http')].exports.pedir = async () => corpo;
      delete require.cache[require.resolve('../lib/cofres/vitruviano')];
      return require('../lib/cofres/vitruviano');
    };

    let a = responder({ id: 'x', tipo: 'senha' });
    let e = await falha(() => a.ler({ baseUrl: 'https://x', chave: 'k' }, 'x'),
      'segredo de senha sem senha deveria falhar');
    igual(e.codigo, 'resposta_invalida',
      'senha ausente é ERRO, e não senha vazia — conectar com senha vazia é o '
      + 'tipo de falha que só aparece no log do servidor invadido');

    a = responder({ id: 'x', tipo: 'chave-ssh' });
    e = await falha(() => a.ler({ baseUrl: 'https://x', chave: 'k' }, 'x'),
      'segredo de chave sem chave deveria falhar');
    igual(e.codigo, 'resposta_invalida', 'idem para chave SSH sem chave privada');

    // Tipo desconhecido cai para senha — e aí a senha precisa existir.
    // Tipo desconhecido NÃO vira "senha": o contrato promete que tipo novo
    // chega numa das duas formas existentes, então o nome fica (é rótulo) e a
    // FORMA é decidida pelo campo que veio. A regra antiga — coagir para
    // "senha" — fazia um "certificado" (forma PEM) cair no ramo do valor único
    // e estourar com "o cofre não mandou a senha".
    a = responder({ id: 'x', tipo: 'certificado-quantico', senha: 'abc123' });
    const s = await a.ler({ baseUrl: 'https://x', chave: 'k' }, 'x');
    igual(s.tipo, 'certificado-quantico',
      'o tipo desconhecido fica, aparado — é o rótulo da tela');
    igual(s.senha, 'abc123', 'e a forma veio do CAMPO: valor único');

    a = responder({ id: 'x', tipo: 'certificado-quantico',
      chavePrivada: '-----BEGIN X-----\nabc\n-----END X-----\n' });
    const sPem = await a.ler({ baseUrl: 'https://x', chave: 'k' }, 'x');
    ok(sPem.chavePrivada.includes('BEGIN'),
      'o MESMO tipo desconhecido em forma PEM também funciona — é o payload que manda');

    // Campo a mais na resposta não entra no app.
    a = responder({ id: 'x', tipo: 'senha', senha: 'abc123', __proto__mal: 1, admin: true });
    const s2 = await a.ler({ baseUrl: 'https://x', chave: 'k' }, 'x');
    igual(Object.keys(s2).sort(),
      ['dominio', 'expiraEm', 'janela', 'protocolo', 'semJanela', 'senha', 'tipo', 'usuario'],
      'a credencial é montada campo a campo: o que a API mandar a mais fica de fora');

    // "constructor" é propriedade HERDADA de todo objeto: um acesso direto a
    // PROTOCOLOS[p] a aceitaria como protocolo válido e o selo da tela viraria
    // "segredo de CONSTRUCTOR". Achado da revisão, demonstrado por execução.
    a = responder({ id: 'x', tipo: 'senha', senha: 'abc', protocolo: 'constructor' });
    igual((await a.ler({ baseUrl: 'https://x', chave: 'k' }, 'x')).protocolo, '',
      'protocolo herdado do protótipo é descartado como qualquer valor estranho');
    a = responder({ id: 'x', tipo: 'senha', senha: 'abc', protocolo: 'gopher' });
    igual((await a.ler({ baseUrl: 'https://x', chave: 'k' }, 'x')).protocolo, '',
      'protocolo fora dos seis é descartado');

    require.cache[require.resolve('../lib/cofres/http')].exports.pedir = original;
    delete require.cache[require.resolve('../lib/cofres/vitruviano')];
  }

  // ---------- listagem hostil ----------

  {
    const http2 = require('../lib/cofres/http');
    const original = http2.pedir;
    let voltas = 0;
    // Cursor que nunca acaba: sem trava, o adaptador giraria para sempre contra
    // o limite de 120 requisições por minuto.
    require.cache[require.resolve('../lib/cofres/http')].exports.pedir = async () => {
      voltas += 1;
      return { itens: [{ id: `s${voltas}`, nome: 'x' }], proximoCursor: 'sempre-tem-mais' };
    };
    delete require.cache[require.resolve('../lib/cofres/vitruviano')];
    const a = require('../lib/cofres/vitruviano');
    const r = await a.listar({ baseUrl: 'https://x', chave: 'k' }, { limite: 200 });
    ok(voltas <= 20, `a paginação para sozinha (${voltas} voltas), mesmo com cursor infinito`);
    ok(r.itens.length > 0, 'devolvendo o que conseguiu ler');

    // Itens sem id são descartados: um item sem id não dá para ler depois.
    require.cache[require.resolve('../lib/cofres/http')].exports.pedir = async () => ({
      itens: [null, 'texto', { nome: 'sem id' }, { id: 'bom', nome: 'ok' }],
      proximoCursor: null,
    });
    delete require.cache[require.resolve('../lib/cofres/vitruviano')];
    const a2 = require('../lib/cofres/vitruviano');
    const r2 = await a2.listar({ baseUrl: 'https://x', chave: 'k' }, {});
    igual(r2.itens.map((i) => i.id), ['bom'],
      'item sem id, nulo ou que nem objeto é, some da lista em vez de virar linha que não abre');

    require.cache[require.resolve('../lib/cofres/http')].exports.pedir = original;
    delete require.cache[require.resolve('../lib/cofres/vitruviano')];
  }

  // ---------- o parâmetro é cortado ANTES de sair ----------
  //
  // A API RECUSA `limite=500` com 422 em vez de cortar em 200. Se o adaptador
  // repassar o que a tela pediu, uma busca longa demais vira erro em vez de
  // resultado.

  await comServidor({}, async (cfg, s) => {
    await adaptador.listar(cfg, { limite: 9999 });
    const url = s.diario.pedidos.find((u) => u.includes('/secrets?'));
    ok(url.includes('limite=200'),
      'limite absurdo é cortado em 200 antes de sair — a API recusaria com 422');

    s.diario.pedidos.length = 0;
    await adaptador.listar(cfg, { busca: 'a'.repeat(500) });
    const url2 = s.diario.pedidos.find((u) => u.includes('/secrets?'));
    const busca = new URL(url2, 'http://x').searchParams.get('busca');
    igual(busca.length, 128, 'busca longa demais é cortada em 128, e não recusada pelo cofre');
  });

  // ---------- a chave vai em cabeçalho, e não na URL ----------

  await comServidor({}, async (cfg, s) => {
    await adaptador.ping(cfg);
    await adaptador.listar(cfg, { busca: 'root' });
    ok(s.diario.pedidos.every((u) => !u.includes(fake.TOKEN)),
      'o token não aparece em nenhuma URL — ali ele entraria em log de servidor, '
      + 'histórico de proxy e mensagem de erro');
  });

  // ---------- o contrato de 11/08: o cliente vem no próprio segredo ----------

  await comServidor({}, async (cfg) => {
    const r = await adaptador.listar(cfg, { limite: 50 });
    const web = r.itens.find((i) => i.nome === 'root@web-01');
    igual(web.cliente, fake.VELONIC,
      'cada segredo diz de qual CLIENTE é — era o pedido de maior efeito da nossa '
      + 'lista, e é o que liga o segredo ao horário sem depender de filtro');
    igual(web.clienteNome, 'Velonic', 'com o nome, para a lista não mostrar um UUID');

    const roteador = r.itens.find((i) => i.nome === 'admin@roteador');
    igual(roteador.cliente, fake.MAYLINK, 'o id do cliente nunca vem null');
    igual(roteador.clienteNome, '',
      'cofreNome null vira string vazia — o contrato avisa que é anulável, e '
      + '"null" impresso na tela é o que acontece com quem não lê o aviso');
  });

  // ERP anterior a 11/08 não manda o campo: o app não pode quebrar por isso.
  await comServidor({ semCliente: true }, async (cfg) => {
    const r = await adaptador.listar(cfg, { limite: 50 });
    igual(r.itens[0].cliente, '',
      'sem o campo, o cliente fica vazio em vez de undefined — e a tela cai no filtro');
    ok(r.itens.length > 0, 'e a listagem continua funcionando');
  });

  // ---------- sistemas: id estável, com reserva ----------

  await comServidor({}, async (cfg) => {
    const r = await adaptador.sistemas(cfg, {});
    const opa = r.itens.find((s) => s.nome === 'OPA');
    igual(opa.id, '8f21c000-0000-4000-8000-000000000001',
      'sistema com id usa o id — é a chave que sobrevive a renomear');
    ok(opa.idEstavel, 'e o app sabe que aquele id é confiável');

    const antigo = r.itens.find((s) => s.nome === 'Rede interna');
    igual(antigo.id, `${fake.MAYLINK}::Rede interna`,
      'sistema antigo (sem id) cai para cliente + nome, em vez de ficar sem chave');
    naoOk(antigo.idEstavel,
      'marcado como NÃO estável: nome não é único por cliente, então essa chave '
      + 'quebra se o admin renomear ou criar um segundo com o mesmo nome');
  });

  // ---------- 422 tem `details`, e NÃO tem `message` ----------

  await comServidor({ erpValidation: true }, async (cfg) => {
    const e = await falha(() => adaptador.listar(cfg), '422 deveria falhar');
    igual(e.codigo, 'requisicao_invalida', '422 continua sendo erro do Canvas');
    ok(e.message.includes('limite'),
      'a mensagem sai de `details` — lendo só `message`, que o 422 NÃO tem, ela '
      + 'virava "erro 422" e escondia justamente o parâmetro que precisa mudar');
    ok(e.message.includes('between 1 and 200'), 'com o texto do validador inteiro');
  });

  {
    const t = adaptador._traduzirErro;
    const so = t(422, { error: { code: 'validation_error',
      details: [{ loc: ['query', 'busca'], msg: 'no máximo 128 caracteres' }] } }, {});
    ok(so.message.includes('busca') && so.message.includes('128'),
      'details no formato do validador vira "campo: motivo"');

    const varios = t(422, { error: { code: 'validation_error', details: [
      { loc: ['query', 'limite'], msg: 'fora da faixa' },
      { loc: ['query', 'cofre'], msg: 'não é UUID' }] } }, {});
    ok(varios.message.includes('limite') && varios.message.includes('cofre'),
      'e dois problemas de uma vez aparecem os dois');

    const vazio = t(422, { error: { code: 'validation_error' } }, {});
    ok(vazio.message.includes('422'), '422 sem details nenhum ainda diz alguma coisa');
  }

  // ---------- conflict: envelope do ERP, texto em PORTUGUÊS ----------

  await comServidor({ conflito: true }, async (cfg) => {
    const e = await falha(() => adaptador.ping(cfg), 'conflict deveria falhar');
    igual(e.codigo, 'conflito', 'conflict tem código próprio');
    igual(e.transitorio, false, 'e não é para insistir');
    ok(e.message.includes('conflito de estado'),
      'reconhecido pelo CÓDIGO, e não pelo status: a mensagem ganha a explicação '
      + 'do que aconteceu. Só o palpite por status devolveria o texto cru, sem '
      + 'dizer que a leitura pegou o cadastro no meio de uma mudança');
    ok(e.message.includes('cadastro mudou'),
      'a mensagem do ERP chega inteira, mesmo saindo no envelope em inglês: o '
      + 'IDIOMA não indica o envelope, só o código indica');
  });

  // ---------- cursor inválido degrada para a página 1, sem erro ----------

  {
    const http2 = require('../lib/cofres/http');
    const original = http2.pedir;
    // Cofre que "esquece" o cursor e devolve sempre a primeira página, com um
    // cursor novo a cada vez. É o comportamento documentado (cursor inválido
    // degrada com 200) levado ao pior caso.
    let volta = 0;
    require.cache[require.resolve('../lib/cofres/http')].exports.pedir = async () => {
      volta += 1;
      return { itens: [{ id: 'a', nome: 'A' }, { id: 'b', nome: 'B' }],
        proximoCursor: `cursor-${volta}` };
    };
    delete require.cache[require.resolve('../lib/cofres/vitruviano')];
    const a = require('../lib/cofres/vitruviano');
    const r = await a.listar({ baseUrl: 'https://x', chave: 'k' }, { limite: 200 });
    igual(r.itens.map((i) => i.id), ['a', 'b'],
      'a mesma página voltando não duplica os segredos na lista — cursor inválido '
      + 'não dá erro, degrada para a página 1, e sem esta guarda o analista veria '
      + 'o mesmo segredo repetido sem nada indicando o problema');
    ok(volta <= 2, `e a varredura para assim que nada novo aparece (${volta} requisições)`);

    // Cursor repetido pelo cofre: encerra em vez de girar.
    let voltas2 = 0;
    require.cache[require.resolve('../lib/cofres/http')].exports.pedir = async () => {
      voltas2 += 1;
      return { itens: [{ id: `s${voltas2}`, nome: 'x' }], proximoCursor: 'sempre-o-mesmo' };
    };
    delete require.cache[require.resolve('../lib/cofres/vitruviano')];
    const a2 = require('../lib/cofres/vitruviano');
    await a2.listar({ baseUrl: 'https://x', chave: 'k' }, { limite: 200 });
    ok(voltas2 <= 2, `cursor que nunca muda encerra a varredura (${voltas2} requisições)`);

    require.cache[require.resolve('../lib/cofres/http')].exports.pedir = original;
    delete require.cache[require.resolve('../lib/cofres/vitruviano')];
  }

  // ---------- 14/ago: tipos novos, protocolo e domínio, de ponta a ponta ----------

  // Não basta o adaptador entender: o resolver de credenciais é quem decide
  // "isto autentica como chave ou como senha", e a rota do RDP é quem entrega o
  // domínio. Este bloco atravessa as três camadas contra o fake em forma de
  // produção.
  {
    const fs2 = require('fs');
    const os2 = require('os');
    const path2 = require('path');
    process.env.SSHC_DATA_DIR = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'vc-hv14-'));
    const store = require('../lib/store');
    const segredosDeCofre = require('../lib/cofresegredos');
    const credenciais = require('../lib/credenciais');

    const servidor = fake.criar({});
    await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
    const porta = servidor.address().port;

    const d = store.get();
    d.cofres = [{ apelido: 'erp', tipo: 'vitruviano', nome: 'HV',
      config: { baseUrl: `http://127.0.0.1:${porta}/api/cofre/v1` } }];
    const hostDe = (id, extra = {}) => ({ id: `h-${id.slice(-1)}`, name: id, host: '10.0.0.99',
      port: 22, username: '', auth: { type: 'cofre' }, segredo: { cofre: 'erp', id }, ...extra });
    d.hosts = [
      hostDe('9a1f0000-0000-4000-8000-000000000007'), // nota
      hostDe('9a1f0000-0000-4000-8000-000000000008'), // certificado (PEM)
      hostDe('9a1f0000-0000-4000-8000-000000000009', { protocol: 'rdp', port: 3389 }), // AD
    ];
    store.save();
    segredosDeCofre.definir('erp', { chave: fake.TOKEN });

    // A listagem carrega os campos novos.
    const cfg = { baseUrl: `http://127.0.0.1:${porta}/api/cofre/v1`, chave: fake.TOKEN };
    const lista = (await adaptador.listar(cfg, { limite: 50 })).itens;
    const ad = lista.find((s) => s.nome === 'administrador@ad-server');
    igual(ad.protocolo, 'rdp', 'a listagem traz o protocolo (14/ago)');
    igual(ad.dominio, 'VELONIC', 'e o domínio do Active Directory');
    igual(lista.find((s) => s.nome === 'licença do mikrotik').tipo, 'nota',
      'o tipo novo chega CRU na listagem — é o rótulo da tela');
    const roteador = lista.find((s) => s.nome === 'admin@roteador');
    igual(roteador.protocolo, 'telnet', 'o protocolo do equipamento legado vem junto');

    // O certificado (forma PEM) autentica como CHAVE — era o que estourava
    // com "o cofre não mandou a senha" quando a forma seguia o nome do tipo.
    {
      const c = await credenciais.resolver(store.get().hosts[1]);
      igual(c.type, 'key', 'certificado resolve como chave');
      ok(c.privateKey.includes('BEGIN'), 'com o PEM inteiro em memória');
      igual(c.passphrase, 'senha-do-pem', 'e a passphrase que veio junto');
      ok(credenciais.segredosVivos().length > 0, 'tudo registrado na redação enquanto vive');
      c.dispose();
    }

    // A nota (valor único) resolve como senha — o texto é o valor.
    {
      const c = await credenciais.resolver(store.get().hosts[0]);
      igual(c.type, 'password', 'nota resolve como senha');
      ok(c.password.includes('ABCD-1234'), 'com o texto da nota como valor');
      c.dispose();
    }

    // O domínio atravessa o resolver…
    {
      const c = await credenciais.resolver(store.get().hosts[2]);
      igual(c.dominio, 'VELONIC',
        'o domínio do cofre chega ao resolver — o RDP com Active Directory '
        + 'recebe usuário, senha e domínio da mesma fonte');
      igual(c.usuario, 'administrador', 'junto do usuário do segredo');
      c.dispose();
    }

    // …e a rota do RDP o usa quando o host não define (guarda de fonte, como
    // as do backup: a regra "host digitado manda, cofre cobre" tem que estar
    // na linha que monta a resposta).
    {
      const src = fs2.readFileSync(path2.join(__dirname, '..', 'server.js'), 'utf8');
      const i = src.indexOf("app.post('/api/desktop/credencial'");
      ok(i > 0, 'achei a rota de credencial da área de trabalho');
      ok(/domain: host\.rdpDomain \|\| cred\.dominio \|\| ''/.test(src.slice(i, i + 2200)),
        'o domínio digitado no host manda; o do cofre cobre quando vazio');
    }

    // O `semJanela` atravessa o cache até o host (16/08): é o que o cartão na
    // aba Hosts usa para explicar POR QUE o host do cliente não abre sozinho.
    {
      const dados = require('../lib/dadosdecofre');
      await dados.renovarAgora('erp');
      const semTurnos = dados.janelaDoHost({ segredo: { cofre: 'erp', id: 'x', cliente: fake.SANTACLARA } });
      igual(semTurnos && semTurnos.semJanela, 'sem_turnos',
        'cliente sem turnos chega ao host com o estado nomeado — era ausência muda');
      igual(semTurnos.janela, null, 'sem inventar janela');
      igual(semTurnos.cliente, 'Santa Clara Resort', 'e com o nome, para a frase da tela');
      const desativado = dados.janelaDoHost({ segredo: { cofre: 'erp', id: 'x', cliente: fake.REDEFIBRA } });
      igual(desativado && desativado.semJanela, 'encaminhamento_desativado', 'o outro estado idem');
      const comJanela = dados.janelaDoHost({ segredo: { cofre: 'erp', id: 'x', cliente: fake.VELONIC } });
      igual(comJanela && comJanela.semJanela, '', 'cliente com janela não carrega estado de ausência');
      ok(comJanela.janela, 'ele carrega a janela mesmo');
    }

    // As guardas de TELA que a revisão provou faltarem — de fonte, como as do
    // backup, porque app.js não roda em Node:
    {
      const app = fs2.readFileSync(path2.join(__dirname, '..', 'public', 'app.js'), 'utf8');
      ok(app.includes("r.value !== 'password' && r.value !== 'cofre'"),
        'o rádio COFRE aparece em RDP/VNC/Telnet/FTP — escondido junto com '
        + 'agente/chave, o domínio do cofre no RDP era inconfigurável pela tela: '
        + 'o fluxo inteiro só existia para host gravado por fora');
      ok(app.includes('hasOwnProperty.call(ROTULOS_DE_TIPO'),
        'o rótulo do tipo usa hasOwnProperty — um tipo "constructor" exibia '
        + '"function Object() { [native code] }" como selo');
      ok(app.includes("marcado.value !== 'cofre') return;"),
        'a re-busca só age com o rádio cofre marcado — sem a guarda, digitar o '
        + 'endereço num host de agente gastava o limite do ERP com lista invisível');
      ok(app.includes('rebuscaDoSeletorDeSegredo = () =>'),
        'a re-busca aponta para o desenho ATUAL do seletor — o listener direto '
        + 'prendia o closure do primeiro cofre e consultava o apelido errado');
      ok(app.includes('s.host && s.host === enderecoDoHost'),
        'segredo sem host não casa com formulário de host vazio — casava, e '
        + 'notas e certificados subiam ao topo sem selo que explicasse');
      ok(app.includes('sem turnos no ERP') && app.includes('horário não encaminhado'),
        'o cartão do host tem as DUAS frases do semJanela — os consertos são '
        + 'diferentes (cadastrar turnos x ligar o encaminhamento), a frase também');
    }

    await new Promise((r) => servidor.close(r));
  }

  console.log(`ok — ${n} verificações do adaptador do Homem Vitruviano`);
})().catch((e) => { console.error(e); process.exit(1); });
