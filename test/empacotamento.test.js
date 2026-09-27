'use strict';

// O que vai DENTRO dos instaladores — a parte do empacotamento que dá para
// travar sem rodar o electron-builder (que só roda no CI).
//
// Motivo (26/set/2026): no Ubuntu o app aparecia com uma ENGRENAGEM genérica no
// lugar do logo. O .deb publicado (v1.76.1) trazia UM único ícone,
// hicolor/1024x1024/apps/vincii-canvas.png — tamanho que o tema hicolor não
// declara, então a busca de ícones do GNOME não acha nada e cai no genérico.
//
// A causa está no resolvedor do próprio electron-builder (app-builder-lib,
// util/iconConverter.js): para o formato "set" (Linux), quando a origem
// resolvida é um ARQUIVO .png, ele devolve esse arquivo e pronto —
// "source is already a .png — return as-is with its dimensions". Só quando a
// origem é um DIRETÓRIO ele junta um conjunto de tamanhos (collectIconsFromDir,
// nomes NxN.png). Daí build/icons/.
//
// O segundo pedaço é a associação janela ↔ .desktop: o Electron 41 usa
// `pkg.desktopName || defaultDesktopName(app.name)` como app_id/WM_CLASS, e o
// electron-builder grava StartupWMClass a partir de metadata.desktopName —
// sem ele, gravava "Vincii Canvas", que não casa com o "vincii-canvas" do
// Electron.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

const raiz = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));

// ---------- 1. o conjunto de ícones do Linux ----------

// Os tamanhos que o tema hicolor declara e que o GNOME usa de fato (dash,
// alt-tab, janela, notificação). 1024 fica junto por não atrapalhar, mas NÃO
// substitui os outros — era exatamente o que estava acontecendo.
const TAMANHOS_MINIMOS = [16, 24, 32, 48, 64, 128, 256, 512];

{
  const dir = path.join(raiz, 'build', 'icons');
  ok(fs.existsSync(dir), 'build/icons precisa existir — é o que faz o electron-builder gerar um CONJUNTO de tamanhos');
  const presentes = fs.readdirSync(dir)
    .map((f) => /^(\d+)x(\d+)\.png$/.exec(f))
    .filter(Boolean)
    .map((m) => ({ nome: m[0], w: Number(m[1]), h: Number(m[2]) }));
  for (const t of TAMANHOS_MINIMOS) {
    ok(presentes.some((p) => p.w === t && p.h === t), `falta build/icons/${t}x${t}.png`);
  }
  for (const p of presentes) {
    // O nome é o que o electron-builder lê (regex ^(\d+)(?:x\d+)?\.png$): se o
    // arquivo mentir o tamanho, o ícone vai parar na pasta errada do hicolor.
    const buf = fs.readFileSync(path.join(dir, p.nome));
    igual([buf.readUInt32BE(16), buf.readUInt32BE(20)], [p.w, p.h],
      `${p.nome} precisa ter mesmo ${p.w}x${p.h} px (o nome vira a pasta do hicolor)`);
    ok(buf.length > 200, `${p.nome} não pode estar vazio`);
  }
  igual(pkg.build.linux.icon, 'build/icons', 'linux.icon aponta para o diretório (arquivo .png único vira UM tamanho só)');
}

// ---------- 2. o mac e o Windows continuam saindo do mesmo logo ----------

{
  const grande = fs.readFileSync(path.join(raiz, 'build', 'icons', '1024x1024.png'));
  const original = fs.readFileSync(path.join(raiz, 'build', 'icon.png'));
  ok(grande.equals(original),
    'o 1024 do conjunto é o MESMO arquivo de build/icon.png — é dele que saem o .icns e o .ico, e trocar a origem mudaria os instaladores de mac/Windows');
}

// ---------- 3. associação janela ↔ .desktop (o ícone na barra do GNOME) ----------

// Cópia fiel do que o Electron 41 faz (lib/browser/init: defaultDesktopName).
function nomeDesktopDoElectron(nome) {
  const t = nome && nome.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return t ? `${t}.desktop` : 'electron.desktop';
}

{
  ok(typeof pkg.desktopName === 'string' && pkg.desktopName.endsWith('.desktop'),
    'desktopName precisa estar no package.json — é dele que saem o app_id do Electron e o StartupWMClass');
  igual(pkg.desktopName, nomeDesktopDoElectron(pkg.productName),
    'o desktopName declarado tem de ser o MESMO que o Electron calcularia sozinho — senão a janela deixa de casar com o atalho');
  igual(pkg.build.linux.syncDesktopName, true,
    'syncDesktopName liga o nome do arquivo .desktop ao desktopName');
  // O electron-builder grava StartupWMClass = desktopName sem ".desktop".
  igual(pkg.desktopName.replace(/\.desktop$/, ''), 'vincii-canvas',
    'StartupWMClass resultante casa com o app_id do Electron');
  igual(pkg.name, 'vincii-canvas',
    'o executável no Linux vem do name — e o .desktop procura o ícone por esse nome (Icon=vincii-canvas)');
}

// ---------- 4. o ícone é o desenho novo, e vem todo da mesma fonte ----------
//
// v1.77.0: o ícone passou a seguir a identidade do Vincii Anunciação (telha
// escura + o V + selo redondo com o símbolo do produto). A fonte é
// build/icone/icone.html e `npm run icones` regenera tudo — se alguém trocar
// um PNG na mão, isto aqui avisa que ele saiu do desenho.

{
  const fonte = path.join(raiz, 'build', 'icone', 'icone.html');
  ok(fs.existsSync(fonte), 'a fonte do ícone (build/icone/icone.html) precisa estar versionada');
  const html = fs.readFileSync(fonte, 'utf8');
  ok(html.includes('marca-v@2x.png'), 'o desenho usa o V recortado do logotipo, não um V redesenhado');
  ok(fs.existsSync(path.join(raiz, 'build', 'icone', 'marca-v@2x.png')), 'e esse recorte está junto');
  ok(html.includes("location.hash === '#cheio'"), 'a mesma fonte gera a variante sem margem (favicon)');
  ok(fs.existsSync(path.join(raiz, 'build', 'icone', 'gerar.js')), 'o gerador está versionado');
  igual(JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8')).scripts.icones,
    'electron build/icone/gerar.js', 'e tem atalho: npm run icones');

  // O ícone de tempo de execução e o favicon saem do mesmo desenho.
  const app512 = fs.readFileSync(path.join(raiz, 'public', 'app-icon.png'));
  igual([app512.readUInt32BE(16), app512.readUInt32BE(20)], [512, 512], 'public/app-icon.png é 512x512');
  const brand = fs.readFileSync(path.join(raiz, 'public', 'brand.png'));
  igual([brand.readUInt32BE(16), brand.readUInt32BE(20)], [256, 256], 'public/brand.png é 256x256');
  const index = fs.readFileSync(path.join(raiz, 'public', 'index.html'), 'utf8');
  ok(index.includes('<link rel="icon" href="/brand.png">'), 'o favicon aponta para o ícone do app');
}

// ---------- 5. o tema padrão é o ESCURO (v1.77.1) ----------
//
// A interface nascia clara. Quem nunca escolheu tema passa a abrir no escuro,
// e quem escolheu claro continua no claro. São dois lugares: o script do topo
// do index.html (que marca data-theme antes do CSS carregar, para não piscar
// branco) e o `:root` nu do style.css (a rede de segurança se esse script não
// rodar).

{
  const index = fs.readFileSync(path.join(raiz, 'public', 'index.html'), 'utf8');
  ok(/dataset\.theme\s*=\s*_p\.theme\s*\|\|\s*localStorage\.getItem\('vc-theme'\)\s*\|\|\s*'dark'/.test(index),
    'sem preferência salva, o app abre no escuro');
  ok(/catch \(e\) \{ document\.documentElement\.dataset\.theme = 'dark'; \}/.test(index),
    'e no escuro também quando a leitura das preferências falha');

  const css = fs.readFileSync(path.join(raiz, 'public', 'style.css'), 'utf8');
  const iRootNu = css.indexOf(':root, :root[data-theme="dark"]');
  const iClaro = css.indexOf(':root[data-theme="light"]');
  ok(iRootNu > 0, 'o bloco escuro responde pelo `:root` nu — é o padrão do CSS');
  ok(iClaro > 0 && iClaro < iRootNu,
    'o bloco claro vem antes, mas com seletor mais específico: quem escolheu claro continua claro');
  ok(!/:root,\s*:root\[data-theme="light"\]/.test(css),
    'o claro não pode mais responder pelo `:root` nu');
}

console.log(`\n${n} verificações passaram`);
