'use strict';

// Transporte compartilhado pelos adaptadores de cofre.
//
// Fica separado porque três coisas aqui não podem ficar a critério de cada
// adaptador, sob pena de o produto seguinte trazer a sua própria versão delas:
//
//   1. a chave vai em CABEÇALHO, nunca em query string;
//   2. o certificado é fixado na primeira conexão (TOFU) e conferido depois —
//      o mesmo modelo que o app já usa para gerência de equipamento;
//   3. resposta gigante é cortada, e a leitura tem prazo.
//
// O que este módulo NÃO faz: retentativa, recuo, decisão sobre o que fazer com
// o erro. Isso é do núcleo (lib/credenciais.js), num lugar só.

const https = require('https');
const http = require('http');
const tls = require('tls');
const crypto = require('crypto');

const TEMPO_LIMITE_MS = Number(process.env.VC_COFRE_TIMEOUT_MS || 15000);
// Um cofre não devolve megabytes. O teto existe para uma resposta descontrolada
// (ou um servidor que não é o cofre) não consumir memória do app.
const MAX_CORPO = 2 * 1024 * 1024;

class ErroDeCofre extends Error {
  // `transitorio` é do ADAPTADOR, não do núcleo.
  //
  // O núcleo tinha uma lista fixa de códigos que valia a pena insistir, e
  // `indisponivel` estava nela. Só que num produto real (Homem Vitruviano) o
  // 503 significa "o cofre está sem chave de cifra, ou o segredo não decifra" —
  // e a própria documentação manda NÃO reintentar, porque não melhora e o
  // certo é avisar quem administra o ERP. Insistir ali é gastar o limite de
  // requisições contra uma parede.
  //
  // Quem sabe se o erro passa é quem conhece o produto. Por isso o adaptador
  // decide, e o núcleo obedece; sem valor definido, vale o palpite por código.
  constructor(codigo, mensagem, esperaSegundos = null, transitorio = undefined) {
    super(mensagem);
    this.name = 'ErroDeCofre';
    this.codigo = codigo;
    this.esperaSegundos = esperaSegundos;
    this.transitorio = transitorio;
  }
}

function impressaoDigital(cert) {
  if (!cert || !cert.raw) return null;
  return 'sha256/' + crypto.createHash('sha256').update(cert.raw).digest('base64');
}

// `cfg` é o que o usuário configurou: { baseUrl, chave, certificadoFixado, ... }
// MAIS `aoFixar`, a função que grava o pino do certificado.
//
// `aoFixar` VIAJA DENTRO DO cfg, e não como parâmetro posicional. Era um sexto
// argumento, e nenhum dos oito pontos de chamada passava — os adaptadores
// chamavam `pedir(cfg, 'GET', rota, null, traduzirErro)` e paravam ali. O efeito
// era o pior possível: `rejectUnauthorized = false` continuava valendo (para
// aceitar autoassinado), mas o pino NUNCA era gravado, então `certificadoFixado`
// nunca existia e a conferência nunca rodava. Ou seja: QUALQUER certificado era
// aceito, sempre, e o token `hvk_` ia junto para quem o apresentasse.
//
// No cfg, todo adaptador ganha a proteção sem precisar lembrar dela — inclusive
// o próximo, escrito por alguém que nunca leu este comentário.
function pedir(cfg, metodo, caminho, corpo, traduzirErro) {
  const aoFixar = cfg && cfg.aoFixar;
  return new Promise((resolve, reject) => {
    let base;
    try { base = new URL(String(cfg.baseUrl || '').replace(/\/+$/, '') + '/'); }
    catch { return reject(new ErroDeCofre('config_invalida', 'Endereço do cofre inválido.')); }

    if (base.protocol !== 'https:' && base.hostname !== '127.0.0.1' && base.hostname !== 'localhost') {
      // http só passa em loopback, que é o caso do cofre de mentira usado nos
      // testes. Para qualquer endereço de rede, mandar a chave em texto claro
      // seria entregar o cofre inteiro a quem estiver no caminho.
      return reject(new ErroDeCofre('config_invalida',
        'O endereço do cofre precisa ser https:// (só 127.0.0.1 aceita http, para teste).'));
    }

    const alvo = new URL(caminho.replace(/^\//, ''), base);
    const ehHttps = alvo.protocol === 'https:';
    const mod = ehHttps ? https : http;

    const opcoes = {
      method: metodo,
      headers: {
        // A chave NUNCA na URL: ali ela entra em log de servidor, histórico de
        // proxy e mensagem de erro.
        Authorization: `Bearer ${cfg.chave || ''}`,
        Accept: 'application/json',
        'User-Agent': 'VinciiCanvas (cofre v1)',
      },
    };
    if (corpo) {
      opcoes.headers['Content-Type'] = 'application/json';
    }
    // Monta e dispara o request. No https, `enviar` só é chamado DEPOIS de o
    // pino ter sido conferido no handshake (abaixo) — então o token nunca sai
    // por um socket não verificado.
    const enviar = () => {
    const req = mod.request(alvo, opcoes, (res) => {
      // UTF-8 declarado, e não a conversão implícita de cada pedaço.
      //
      // `dados += chunk` converte Buffer por Buffer. Um caractere multibyte
      // (qualquer acento — "Produção", "Independência") que caia na fronteira
      // entre dois chunks do socket é convertido pela metade nos dois lados e
      // volta como lixo. Com setEncoding, o decodificador guarda o byte
      // incompleto e o completa no pedaço seguinte.
      res.setEncoding('utf8');
      let dados = '';
      let demais = false;
      res.on('data', (d) => {
        if (demais) return;
        dados += d;
        if (dados.length > MAX_CORPO) {
          demais = true;
          // REJEITA AQUI, e não no 'end'.
          //
          // `req.destroy()` impede o 'end' de acontecer, então esperar por ele
          // deixava a promessa sem nunca se resolver: uma resposta gigante (ou
          // um servidor que não é o cofre, despejando bytes) pendurava a chamada
          // — e com ela a conexão do host que estava esperando a credencial.
          // Descoberto porque o teste deste arquivo travou em vez de falhar.
          reject(new ErroDeCofre('resposta_invalida', 'O cofre respondeu grande demais.'));
          req.destroy();
        }
      });
      res.on('end', () => {
        if (demais) return; // já rejeitado acima
        let json = null;
        try { json = dados ? JSON.parse(dados) : {}; } catch { json = null; }
        if (res.statusCode >= 400) {
          return reject(traduzirErro(res.statusCode, json, res.headers));
        }
        // REDIRECIONAMENTO NÃO É SUCESSO.
        //
        // `pedir` não segue 3xx de propósito: seguir cegamente mandaria o token
        // para onde o Location apontar, e um Location é coisa que se injeta. Só
        // que o código tratava 3xx como resposta boa, e o corpo de um 302 é
        // vazio — então virava `{}`, o ping devolvia zero cliente, e a mesa de
        // trabalho sumia da tela SEM ERRO NENHUM.
        //
        // É o que um proxy faz quando manda para uma página de login, ou quando
        // o app atrás dele está subindo. Transitório: costuma passar sozinho.
        if (res.statusCode >= 300) {
          const destino = String(res.headers.location || '').slice(0, 120);
          return reject(new ErroDeCofre('indisponivel',
            `O cofre respondeu um redirecionamento (${res.statusCode})`
            + `${destino ? ` para ${destino}` : ''}, e não a resposta esperada. `
            + 'Isso costuma ser o proxy mandando para uma página de login, ou o '
            + 'servidor subindo.', null, true));
        }
        if (json === null) {
          return reject(new ErroDeCofre('resposta_invalida', 'O cofre não respondeu JSON.'));
        }
        resolve(json);
      });
    });

    req.setTimeout(TEMPO_LIMITE_MS, () => {
      req.destroy();
      // Transitório de forma EXPLÍCITA: sem o terceiro argumento, a decisão
      // caía no palpite por código do núcleo, e um dia alguém muda esse palpite
      // sem saber que o timeout dependia dele.
      reject(new ErroDeCofre('indisponivel',
        `O cofre não respondeu em ${TEMPO_LIMITE_MS / 1000}s.`, null, true));
    });
    req.on('error', (e) => {
      if (e instanceof ErroDeCofre) return reject(e);
      reject(new ErroDeCofre('indisponivel',
        `Não deu para falar com o cofre: ${e.message}`, null, true));
    });
    if (corpo) req.write(JSON.stringify(corpo));
    req.end();
    };

    // http em loopback (teste): não há o que fixar, envia direto.
    if (!ehHttps) { enviar(); return; }

    // HTTPS: o certificado autoassinado é o caso normal em cofre interno. O
    // PINO é conferido no HANDSHAKE — antes de qualquer byte de aplicação (o
    // token `hvk_`) sair. Antes, a conferência morava no callback da resposta,
    // depois de req.end() já ter mandado o header Authorization: um MITM que
    // apresentasse outro certificado recebia o token e SÓ ENTÃO era rejeitado.
    // Agora só um socket já verificado recebe o request; num impostor o socket
    // é destruído sem nunca ter transmitido o token.
    opcoes.rejectUnauthorized = false;
    let conferido = false;
    const socket = tls.connect({
      host: alvo.hostname,
      port: Number(alvo.port) || 443,
      // SNI só para nome de host — IP no servername é proibido pela RFC 6066.
      servername: require('net').isIP(alvo.hostname) ? undefined : alvo.hostname,
      rejectUnauthorized: false, // autoassinado é esperado; o pino é quem decide
    }, () => {
      const atual = impressaoDigital(socket.getPeerCertificate());
      if (socket.authorized) {
        // Cadeia confiável (CA pública): validação normal, não se fixa.
      } else if (cfg.certificadoFixado) {
        if (atual !== cfg.certificadoFixado) {
          socket.destroy();
          return reject(new ErroDeCofre('certificado_mudou',
            'O certificado do cofre mudou desde a primeira conexão. Ou trocaram o '
            + 'servidor, ou alguém está no meio do caminho. Confira e use '
            + '"esquecer certificado" nas configurações se a troca foi você.'));
        }
      } else if (atual && typeof aoFixar === 'function') {
        aoFixar(atual); // TOFU: fixa na primeira conexão
      }
      conferido = true;
      socket.setTimeout(0); // o prazo de resposta agora é do req
      opcoes.createConnection = () => socket; // o request vai SÓ por este socket
      opcoes.agent = false;
      enviar();
    });
    socket.setTimeout(TEMPO_LIMITE_MS, () => {
      socket.destroy();
      if (!conferido) reject(new ErroDeCofre('indisponivel',
        `O cofre não respondeu em ${TEMPO_LIMITE_MS / 1000}s.`, null, true));
    });
    socket.on('error', (e) => {
      if (conferido) return; // depois do handoff, quem trata é o req
      if (e instanceof ErroDeCofre) return reject(e);
      reject(new ErroDeCofre('indisponivel',
        `Não deu para falar com o cofre: ${e.message}`, null, true));
    });
  });
}

module.exports = { pedir, ErroDeCofre, impressaoDigital, TEMPO_LIMITE_MS };
