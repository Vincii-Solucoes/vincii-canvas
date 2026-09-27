'use strict';

// Gera TODOS os ícones do app a partir de build/icone/icone.html.
//   npm run icones
//
// Só precisa do Electron (já é dependência de desenvolvimento): o Chromium
// desenha o SVG e faz a redução dos tamanhos em canvas. Nada de sharp nem de
// ferramenta do sistema — roda igual no mac, no Windows e no Linux.
//
// O mesmo desenho do Vincii Anunciação (telha escura + V + selo redondo), com
// a tela de pintura no cavalete no lugar do telefone. Os PNGs ficam versionados
// no repositório; isto aqui só roda quando o desenho mudar.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const raiz = path.join(__dirname, '..', '..');
const fonte = path.join(__dirname, 'icone.html');

// Os tamanhos do conjunto do Linux (o tema hicolor declara de 16 a 512; o 1024
// fica porque é dele que saem o .icns do mac e o .ico do Windows).
const TAMANHOS_LINUX = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

// UMA janela só para tudo: neste Electron, destruir uma janela offscreen e
// criar outra faz a próxima navegação falhar com ERR_FAILED (e depois o
// processo morre com SIGTRAP). Então a janela é reaproveitada.
let janela = null;
async function abrir(lado) {
  if (!janela) {
    janela = new BrowserWindow({
      width: lado, height: lado, show: false, frame: false, transparent: true,
      backgroundColor: '#00000000', useContentSize: true,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
  } else {
    janela.setContentSize(lado, lado);
  }
  return janela;
}

async function desenhar(hash, ladoCss, ladoEsperado) {
  const win = await abrir(ladoCss);
  await win.loadFile(fonte, hash ? { hash } : undefined);
  await new Promise((r) => setTimeout(r, 700));
  const img = await win.webContents.capturePage();
  const t = img.getSize();
  if (t.width !== ladoEsperado || t.height !== ladoEsperado) {
    throw new Error(`esperava ${ladoEsperado}x${ladoEsperado} e veio ${t.width}x${t.height}`);
  }
  return img.toPNG();
}

// Redução em canvas, com a suavização boa do Chromium — reduzir um mestre
// grande dá resultado melhor do que desenhar o SVG direto em 16px.
async function reduzir(pngMestre, tamanhos) {
  const win = await abrir(64);
  // arquivo, e não `data:` — o Chromium recusa data: como navegação principal
  await win.loadFile(path.join(__dirname, 'reduzir.html'));
  const b64 = pngMestre.toString('base64');
  const saidas = await win.webContents.executeJavaScript(`
    (async () => {
      const img = new Image();
      img.src = 'data:image/png;base64,${b64}';
      await img.decode();
      const out = {};
      for (const t of ${JSON.stringify(tamanhos)}) {
        const c = document.createElement('canvas');
        c.width = t; c.height = t;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, t, t);
        out[t] = c.toDataURL('image/png').split(',')[1];
      }
      return out;
    })()
  `, true);
  const r = {};
  for (const t of tamanhos) r[t] = Buffer.from(saidas[t], 'base64');
  return r;
}

function gravar(rel, buf) {
  const destino = path.join(raiz, rel);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, buf);
  console.log(`  ${rel} (${buf.length} bytes)`);
}

app.disableHardwareAcceleration();
// Fator de escala fixo: sem isto, o tamanho do PNG dependeria da tela de quem
// roda (HiDPI ou não) e o mestre sairia com metade do tamanho noutra máquina.
app.commandLine.appendSwitch('force-device-scale-factor', '2');

app.whenReady().then(async () => {
  const mestre = await desenhar(null, 512, 1024);
  const reduzidos = await reduzir(mestre, TAMANHOS_LINUX.filter((t) => t !== 1024));

  console.log('ícone do app (telha com margem e sombra):');
  gravar('build/icon.png', mestre);          // origem do .icns e do .ico
  gravar('build/icons/1024x1024.png', mestre); // maior do conjunto = mesma origem
  for (const t of TAMANHOS_LINUX) {
    if (t === 1024) continue;
    gravar(`build/icons/${t}x${t}.png`, reduzidos[t]);
  }
  gravar('public/app-icon.png', reduzidos[512]);

  // Variante sem margem: o favicon e a miniatura da aba, onde a margem só rouba pixel.
  const cheio = await desenhar('cheio', 128, 256);
  console.log('variante sem margem (favicon):');
  gravar('public/brand.png', cheio);

  if (janela) janela.destroy();
  app.quit();
}).catch((e) => { console.error(e); process.exit(1); });
