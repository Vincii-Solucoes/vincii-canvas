'use strict';

// Relatório do monitor em PDF — a parte PURA: a validação dos dados que a tela
// manda e o HTML que vira o PDF. O printToPDF em si é do Electron e só roda no
// app instalado (lá a prova é baixar o arquivo e ver %PDF no começo).

const assert = require('assert');
const rel = require('../lib/relatoriopdf');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- validação dos dados ----------

{
  igual(rel.normalizarDados(null), null, 'sem corpo → inválido');
  igual(rel.normalizarDados({}), null, 'sem ip → inválido');
  igual(rel.normalizarDados({ ip: 'a b' }), null, 'ip com espaço → inválido');
  igual(rel.normalizarDados({ ip: '<img>' }), null, 'ip com HTML → inválido');

  const d = rel.normalizarDados({
    ip: '10.0.0.1', inicio: 1000, fim: 61000, total: 60, perdidos: 3,
    media: 2.5, min: 0.8, max: 12.1,
    quedas: [{ inicio: 5000, fim: 9000 }, { inicio: 50000, fim: null }, { lixo: true }],
  });
  igual(d.ip, '10.0.0.1', 'ip válido passa');
  igual(d.total, 60, 'contadores passam');
  igual(d.quedas.length, 2, 'queda sem início é descartada');
  igual(d.quedas[1].fim, null, 'queda em aberto preserva fim=null');

  const capado = rel.normalizarDados({ ip: 'x', quedas: Array.from({ length: 500 }, (_, i) => ({ inicio: i + 1 })) });
  igual(capado.quedas.length, 200, 'quedas capadas em 200 (o PDF não vira um livro)');
}

// ---------- o HTML do PDF ----------

{
  const d = rel.normalizarDados({
    ip: '192.168.0.1', inicio: Date.parse('2026-08-22T10:00:00'), fim: Date.parse('2026-08-22T10:30:00'),
    total: 1800, perdidos: 18, media: 3.14159, min: 0.5, max: 40,
    quedas: [{ inicio: Date.parse('2026-08-22T10:10:00'), fim: Date.parse('2026-08-22T10:11:30') }],
  });
  const html = rel.htmlRelatorioMonitor(d);
  ok(html.includes('192.168.0.1'), 'o host aparece');
  ok(html.includes('1800'), 'enviados aparecem');
  ok(html.includes('1%'), 'a perda em % aparece (18/1800)');
  ok(html.includes('3.1 ms'), 'a média sai formatada com 1 casa');
  ok(html.includes('00:30:00'), 'a duração do período aparece');
  ok(html.includes('00:01:30'), 'a duração da queda aparece');
  ok(html.includes('Vincii Canvas'), 'a marca aparece');

  const semQueda = rel.htmlRelatorioMonitor(rel.normalizarDados({ ip: 'x', total: 10, perdidos: 0 }));
  ok(semQueda.includes('Nenhuma queda'), 'sem quedas, o texto tranquiliza');

  // queda em aberto ao encerrar
  const aberta = rel.htmlRelatorioMonitor(rel.normalizarDados({ ip: 'x', fim: 2000, quedas: [{ inicio: 1000, fim: null }] }));
  ok(aberta.includes('em queda ao encerrar'), 'queda aberta é dita como tal');
}

// ---------- escape: nada de HTML injetável ----------

{
  igual(rel._escapa('<script>"a"&\'b\''), '&lt;script&gt;&quot;a&quot;&amp;&#39;b&#39;', 'escapa cobre os 5');
  // o ip já é validado, mas o escape protege QUALQUER campo por construção
  ok(!rel.htmlRelatorioMonitor(rel.normalizarDados({ ip: 'host-ok' })).includes('<script'), 'html final sem script');
}

// ---------- gerador injetado ----------

(async () => {
  igual(rel.disponivel(), false, 'sem Electron, indisponível (rota devolve 501)');
  let recebido = null;
  rel.definirGerador(async (html) => { recebido = html; return Buffer.from('%PDF-fake'); });
  igual(rel.disponivel(), true, 'com gerador, disponível');
  const buf = await rel.gerarPdf('<html>x</html>');
  igual(String(buf), '%PDF-fake', 'o gerador recebe o html e devolve o buffer');
  igual(recebido, '<html>x</html>', 'o html chega intacto ao gerador');
  rel.definirGerador(null);
  igual(rel.disponivel(), false, 'remover o gerador volta a indisponível');

  console.log(`\n${n} verificações passaram`);
})().catch((e) => { console.error(e); process.exit(1); });
