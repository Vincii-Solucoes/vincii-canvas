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
      },
    });
    // links externos abrem no navegador do sistema, não dentro do app
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
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
