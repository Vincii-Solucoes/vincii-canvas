'use strict';

// Testes da URL de host do tipo "web".
//
// A URL vira o `src` de um <webview>, que carrega a página DENTRO do app. Um
// esquema como `javascript:` ou `file:` ali não seria "um link ruim": seria
// execução no contexto do app, com acesso ao que o app alcança. Por isso a
// lista de esquemas é de PERMISSÃO, e estes testes cobrem os dois lados —
// recusar o que é perigoso sem recusar o que o usuário digita todo dia.

const assert = require('assert');
const { normalizarUrl, partesDaUrl } = require('../public/weburl');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- só http e https entram ----------
for (const mau of [
  'javascript:alert(1)', 'JavaScript:alert(1)', 'file:///etc/passwd',
  'data:text/html,<script>x</script>', 'ftp://x.io', 'mailto:a@b',
  'vbscript:msgbox', 'blob:https://x.io/abc', 'about:blank', 'chrome://settings',
  'ws://x.io', 'view-source:https://x.io',
]) {
  igual(normalizarUrl(mau), null, `esquema perigoso aceito: ${mau}`);
}

// ---------- o que o usuário realmente digita ----------
igual(normalizarUrl('192.168.1.1'), 'https://192.168.1.1/', 'IP puro vira https');
igual(normalizarUrl('roteador:8443/admin'), 'https://roteador:8443/admin',
  'nome:porta é porta, não esquema — era isto que fazia o texto mais natural ser recusado');
igual(normalizarUrl('http://painel.interno/'), 'http://painel.interno/', 'http explícito é respeitado');
igual(normalizarUrl('  https://x.io/a  '), 'https://x.io/a', 'espaços em volta são aparados');
ok(normalizarUrl('10.0.0.5:8080').startsWith('https://10.0.0.5:8080'), 'IP com porta');

// ---------- entradas degeneradas não passam ----------
for (const vazio of ['', '   ', null, undefined, 'https://', '://x', 0, {}]) {
  igual(normalizarUrl(vazio), null, `entrada degenerada aceita: ${JSON.stringify(vazio)}`);
}

// ---------- partes derivadas ----------
igual(partesDaUrl('roteador:8443/admin'),
  { url: 'https://roteador:8443/admin', host: 'roteador', port: 8443 },
  'endereço e porta saem da URL');
igual(partesDaUrl('https://x.io/a').port, 443, 'https sem porta é 443');
igual(partesDaUrl('http://x.io/a').port, 80, 'http sem porta é 80');
igual(partesDaUrl('javascript:x'), null, 'partes de URL recusada é null');

// ---------- usuário e senha embutidos na URL ----------

// http://admin:senha@10.0.0.9 FUNCIONA (o webview autentica sozinho por Basic
// auth), e era esse o incentivo para gravar assim. Só que a senha ia parar no
// rótulo do host na tela, na barra de endereço da aba, no data.json — e no
// backup SEM segredos, porque o export emite `url` sem olhar includeSecrets.
// Uma senha entrando por outro campo contornava todo o modelo de segredos.
{
  const semSegredo = (u) => {
    const r = normalizarUrl(u);
    ok(r !== null, `deveria aceitar a URL: ${u}`);
    ok(!/admin|S3nh4|senha/i.test(r), `usuário ou senha sobreviveu em: ${r}`);
    return r;
  };
  igual(semSegredo('http://admin:S3nh4@10.0.0.9/'), 'http://10.0.0.9/',
    'usuário e senha somem da URL');
  igual(semSegredo('https://admin@roteador.local/cgi'), 'https://roteador.local/cgi',
    'só usuário também sai');
  // O userinfo também servia para disfarçar o destino: isto se lê pelo começo
  // como a LAN, mas o host real é evil.example.
  igual(normalizarUrl('https://192.168.1.1@evil.example/'), 'https://evil.example/',
    'o endereço real aparece, sem o disfarce do userinfo');
  igual(normalizarUrl('https://x.io/a?b=1#c'), 'https://x.io/a?b=1#c',
    'URL sem userinfo passa intacta');
}

console.log(`\n${n} verificações passaram`);
