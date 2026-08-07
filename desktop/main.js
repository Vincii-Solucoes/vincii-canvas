'use strict';

// Processo principal do Electron: sobe o mesmo servidor do modo web numa porta
// aleatória de 127.0.0.1 e abre a interface numa janela nativa.

const path = require('path');
const fs = require('fs');
const { app: electronApp, BrowserWindow, shell, dialog } = require('electron');

// Marca que estamos no app desktop — o servidor usa em /api/update-check para
// decidir: Mac/web mostram a faixa de aviso; Windows/Linux fazem auto-update.
process.env.SSHC_DESKTOP = '1';

// Ícone de runtime (dock no macOS, barra de tarefas no Windows/Linux). Fica em
// public/ porque essa pasta é embarcada no app empacotado — diferente de build/,
// que só é usada em tempo de empacotamento para gerar o .icns/.ico do bundle.
const APP_NAME = 'Vincii Canvas';
const iconPath = path.join(__dirname, '..', 'public', 'app-icon.png');

// Identidade do app: nome mostrado no dock/menu (macOS) e no passar o mouse, e
// AppUserModelId para o Windows agrupar/rotular corretamente na barra de tarefas.
// Definido cedo, antes de whenReady, para valer no menu e no dock desde o início.
electronApp.setName(APP_NAME);
electronApp.setAppUserModelId('br.com.vincii.canvas');

// Uma instância só — duas instâncias gravariam no mesmo data.json ao mesmo tempo
if (!electronApp.requestSingleInstanceLock()) {
  electronApp.quit();
} else {
  // Painel "Sobre" (menu do app no macOS) com a identidade da Vincii
  try {
    electronApp.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: require('../package.json').version,
      copyright: 'Vincii — vincii.com.br',
    });
  } catch {}
  // Dados no perfil do usuário (o pacote instalado é somente leitura)
  const dataDir = electronApp.getPath('userData');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
  process.env.SSHC_DATA_DIR = dataDir;

  // Primeira execução em desenvolvimento: aproveita o data.json do modo web
  const devData = path.join(__dirname, '..', 'data.json');
  const desktopData = path.join(dataDir, 'data.json');
  try {
    if (!fs.existsSync(desktopData) && fs.existsSync(devData)) {
      fs.copyFileSync(devData, desktopData);
      fs.chmodSync(desktopData, 0o600);
    }
  } catch {}

  // Importar só depois de definir SSHC_DATA_DIR — o store lê a env ao carregar
  const { start } = require('../server');
  const store = require('../lib/store');
  const quickhosts = require('../lib/quickhosts');

  let win = null;

  async function createWindow() {
    const server = await start(0, '127.0.0.1');
    const port = server.address().port;
    // No macOS o ícone do dock não vem da janela — precisa ser definido no app.
    if (process.platform === 'darwin' && electronApp.dock) {
      try { electronApp.dock.setIcon(iconPath); } catch {}
    }
    win = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 900,
      minHeight: 600,
      title: APP_NAME,
      icon: iconPath,
      backgroundColor: '#080b0e',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Hosts do tipo "web" (gerência de roteador, painel de serviço) abrem
        // numa aba dentro do app, e para isso a página remota precisa rodar num
        // <webview>. Um <iframe> não serve: praticamente toda gerência manda
        // X-Frame-Options e a página simplesmente não carregaria.
        //
        // O que a página remota ganha com isso é uma aba — e nada mais: o
        // will-attach-webview abaixo reescreve as preferências de CADA webview
        // antes de ele existir, então não adianta a interface pedir privilégio.
        webviewTag: true,
      },
    });

    // Trava do <webview>: vale mesmo que alguém consiga injetar HTML na
    // interface, porque quem decide aqui é o processo principal, não o atributo
    // escrito na tag.
    win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webSecurity = true;
      webPreferences.allowRunningInsecureContent = false;
      webPreferences.experimentalFeatures = false;
      // Só http/https entram. `file:` daria leitura do disco do usuário de
      // dentro da página remota; os demais esquemas não têm o que fazer aqui.
      const src = String(params.src || '');
      if (!/^https?:\/\//i.test(src)) {
        console.error(`[desktop] webview recusado (esquema não permitido): ${src.slice(0, 80)}`);
        event.preventDefault();
      }
    });
    // links externos abrem no navegador do sistema, não dentro do app
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
    // Certificado de gerência de equipamento é quase sempre autoassinado. Em vez
    // de recusar (inútil) ou aceitar qualquer um (perigoso), faz o mesmo que o
    // SSH já faz com o fingerprint: aceita na PRIMEIRA visita, guarda, e a
    // partir daí recusa se mudar — porque aí ou trocaram o equipamento, ou
    // alguém está no meio do caminho.
    electronApp.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
      let alvo;
      try { alvo = new URL(url); } catch { return callback(false); }
      const impressao = String((certificate && certificate.fingerprint) || '');
      if (!impressao) return callback(false);

      const dados = store.get();
      const hosts = Array.isArray(dados.hosts) ? dados.hosts : [];
      // Casa pelo host+porta da URL: o pino pertence ao endereço, não ao rótulo.
      const porta = Number(alvo.port) || (alvo.protocol === 'https:' ? 443 : 80);
      // Host salvo primeiro; se não houver, um avulso da conexão rápida. Um
      // avulso recebe a MESMA regra: a exposição na primeira visita é idêntica
      // à de um host salvo, e recusar só ele deixaria a conexão rápida sem saída
      // diante de qualquer equipamento com certificado autoassinado.
      const host = hosts.find((h) => h.protocol === 'web'
          && String(h.host) === alvo.hostname && Number(h.port || 443) === porta)
        || quickhosts.acharPorEndereco('web', alvo.hostname, porta);
      if (!host) {
        console.error(`[desktop] certificado recusado (host não cadastrado): ${alvo.host}`);
        return callback(false);
      }
      if (!host.webCert) {
        host.webCert = impressao;
        // Host avulso vive só em memória — nada a gravar em disco.
        if (!host.ephemeral) store.save();
        console.error(`[desktop] certificado de ${alvo.host} fixado na primeira visita`
          + `${host.ephemeral ? ' (conexão rápida, só nesta sessão)' : ''}: ${impressao}`);
        return callback(true);
      }
      if (host.webCert === impressao) return callback(true);
      console.error(`[desktop] CERTIFICADO MUDOU em ${alvo.host} — recusado.`
        + ` Fixado: ${host.webCert} / apresentado: ${impressao}`);
      callback(false);
    });

    win.on('closed', () => { win = null; });
    await win.loadURL(`http://127.0.0.1:${port}`);
    console.log(`[desktop] Vincii Canvas pronto em http://127.0.0.1:${port} — dados em ${dataDir}`);
  }

  electronApp.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // Auto-update só no Windows/Linux (e só no app empacotado). No macOS a
  // atualização silenciosa exige assinatura Apple, então lá fica no "avisar".
  function setupAutoUpdate() {
    if (!electronApp.isPackaged) return;
    if (process.platform !== 'win32' && process.platform !== 'linux') return;
    let autoUpdater;
    try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', async (info) => {
      if (!win) { try { autoUpdater.quitAndInstall(); } catch {} return; }
      try {
        const { response } = await dialog.showMessageBox(win, {
          type: 'info',
          buttons: ['Reiniciar e atualizar', 'Depois'],
          defaultId: 0,
          cancelId: 1,
          title: 'Atualização disponível',
          message: `Vincii Canvas ${info && info.version ? info.version : ''} foi baixado.`,
          detail: 'Reiniciar agora para aplicar? A atualização também será aplicada quando você fechar o app.',
        });
        if (response === 0) autoUpdater.quitAndInstall();
      } catch {}
    });
    autoUpdater.on('error', (err) => console.error('[updater] erro:', err && err.message));
    autoUpdater.checkForUpdates().catch((e) => console.error('[updater] verificação falhou:', e && e.message));
  }

  electronApp.whenReady().then(createWindow).then(setupAutoUpdate).catch((err) => {
    console.error('[desktop] falha ao iniciar:', err);
    electronApp.quit();
  });

  electronApp.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  electronApp.on('window-all-closed', () => electronApp.quit());
}
