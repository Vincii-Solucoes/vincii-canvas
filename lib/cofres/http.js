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

// `cfg` é o que o usuário configurou: { baseUrl, chave, certificadoFixado, ... }.
// `aoFixar` é chamado quando um certificado autoassinado é aceito pela primeira
// vez, para o chamador gravar o pino.
function pedir(cfg, metodo, caminho, corpo, traduzirErro, aoFixar) {
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
    // Certificado autoassinado é o caso normal em cofre interno. Em vez de
    // recusar (inútil) ou aceitar qualquer um (entregaria a chave a um
    // impostor), fixa na primeira conexão e confere nas seguintes.
    if (ehHttps) opcoes.rejectUnauthorized = false;

    const req = mod.request(alvo, opcoes, (res) => {
      if (ehHttps) {
        const atual = impressaoDigital(res.socket.getPeerCertificate && res.socket.getPeerCertificate());
        const autorizado = res.socket.authorized;
        if (!autorizado) {
          // Só entra no regime de fixação quando a cadeia NÃO é confiável. Um
          // certificado que encadeia numa CA pública passa pela validação
          // normal e nunca é fixado — daí a interface dizer "autoassinado
          // fixado", e não "certificado verificado".
          if (cfg.certificadoFixado) {
            if (atual !== cfg.certificadoFixado) {
              req.destroy();
              return reject(new ErroDeCofre('certificado_mudou',
                'O certificado do cofre mudou desde a primeira conexão. Ou trocaram o '
                + 'servidor, ou alguém está no meio do caminho. Confira e use '
                + '"esquecer certificado" nas configurações se a troca foi você.'));
            }
          } else if (atual && typeof aoFixar === 'function') {
            aoFixar(atual);
          }
        }
      }

      let dados = '';
      let demais = false;
      res.on('data', (d) => {
        if (demais) return;
        dados += d;
        if (dados.length > MAX_CORPO) { demais = true; req.destroy(); }
      });
      res.on('end', () => {
        if (demais) {
          return reject(new ErroDeCofre('resposta_invalida', 'O cofre respondeu grande demais.'));
        }
        let json = null;
        try { json = dados ? JSON.parse(dados) : {}; } catch { json = null; }
        if (res.statusCode >= 400) {
          return reject(traduzirErro(res.statusCode, json, res.headers));
        }
        if (json === null) {
          return reject(new ErroDeCofre('resposta_invalida', 'O cofre não respondeu JSON.'));
        }
        resolve(json);
      });
    });

    req.setTimeout(TEMPO_LIMITE_MS, () => {
      req.destroy();
      reject(new ErroDeCofre('indisponivel', `O cofre não respondeu em ${TEMPO_LIMITE_MS / 1000}s.`));
    });
    req.on('error', (e) => {
      if (e instanceof ErroDeCofre) return reject(e);
      reject(new ErroDeCofre('indisponivel', `Não deu para falar com o cofre: ${e.message}`));
    });
    if (corpo) req.write(JSON.stringify(corpo));
    req.end();
  });
}

module.exports = { pedir, ErroDeCofre, impressaoDigital, TEMPO_LIMITE_MS };
