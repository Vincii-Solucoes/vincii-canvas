'use strict';

// Processo principal do Electron: sobe o mesmo servidor do modo web numa porta
// aleatória de 127.0.0.1 e abre a interface numa janela nativa.

const path = require('path');
const fs = require('fs');
const { app: electronApp, BrowserWindow, shell, dialog, session } = require('electron');

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
  const segredosDeCofre = require('../lib/cofresegredos');

  // A chave de API de um cofre não é uma senha a mais: ela abre TODAS as senhas
  // que aquele cofre guarda. Aqui, e só aqui, existe armazenamento protegido do
  // sistema — Keychain no macOS, DPAPI no Windows, libsecret no Linux. Fora do
  // Electron (`npm start`) esse recurso não existe, o arquivo fica em texto
  // claro com permissão 600, e a tela DIZ isso em vez de deixar supor.
  //
  // NADA aqui pergunta ao sistema agora. `usarCofreDoSistema` só GUARDA estas
  // funções; a pergunta (`isEncryptionAvailable`, que no macOS abre o Keychain)
  // acontece na primeira leitura ou gravação de chave de cofre — não no
  // arranque. Perguntar no arranque fazia o macOS pedir a senha de login TODA
  // VEZ que o app abria, sem cofre nenhum configurado e sem nada a proteger.
  try {
    const { safeStorage } = require('electron');
    segredosDeCofre.usarCofreDoSistema({
      disponivel: () => {
        try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
      },
      cifrar: (txt) => safeStorage.encryptString(txt),
      decifrar: (buf) => safeStorage.decryptString(buf),
    });
    // A preferência do usuário é aplicada antes de qualquer leitura.
    segredosDeCofre.definirPreferencia((store.get().settings || {}).cofreChavesNoSistema !== false);
  } catch (e) {
    console.error('[cofres] armazenamento protegido indisponível:', e && e.message);
  }
  const quickhosts = require('../lib/quickhosts');

  let win = null;

  // O seletor de pasta do backup: só existe sob Electron (dialog nativo). O
  // motor de backup guarda esta função e a chama quando o usuário clica em
  // "Escolher pasta…"; em `npm start` ela nunca é registrada e a tela sabe que
  // precisa do caminho digitado. Mesmo padrão do safeStorage do cofre.
  try {
    const backup = require('../lib/backup');
    backup.definirSeletor(async (inicial) => {
      const r = await dialog.showOpenDialog(win || undefined, {
        title: 'Pasta do backup automático',
        defaultPath: inicial,
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Usar esta pasta',
      });
      return (r.canceled || !r.filePaths || !r.filePaths[0]) ? null : r.filePaths[0];
    });
    // Restaurar um backup exige reiniciar o app, para tudo recarregar do
    // data.json restaurado (store em memória, caches do servidor e do cofre).
    backup.definirRelaunch(() => { electronApp.relaunch(); electronApp.exit(0); });
  } catch (e) {
    console.error('[backup] seletor/relaunch indisponível:', e && e.message);
  }

  // Travas de TODO conteúdo web do app, registradas ANTES de existir janela
  // alguma.
  //
  // Isto ficava DENTRO de createWindow, depois do `new BrowserWindow` — e
  // 'web-contents-created' só avisa de conteúdos criados DEPOIS do listener.
  // O efeito era o oposto exato do que o comentário prometia: a trava valia em
  // toda janela MENOS na principal, justamente a que fica aberta o tempo todo.
  //
  // O `setWindowOpenHandler` também não vale só para <webview>: uma janela
  // solta é um webContents comum e ficava sem handler nenhum.
  function protegerConteudos() {
    electronApp.on('web-contents-created', (_e, contents) => {
      // Quem decide as preferências do <webview> é o processo principal, não o
      // atributo escrito na tag.
      contents.on('will-attach-webview', (event, webPreferences, params) => {
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

      // Nenhuma página — remota num <webview>, ou a própria interface numa
      // janela solta — abre janela nativa do app. Link externo vai para o
      // navegador do sistema. A janela solta em si nasce pelo handler da
      // janela principal, mais abaixo, que é o único ponto que a autoriza.
      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
      });

      // Permissão não se decide em webPreferences, e sim na sessão — que nunca
      // recebia handler. Sem handler, o padrão do Electron é CONCEDER: medido,
      // a página remota abria microfone e câmera ao vivo, sem prompt nenhum, e
      // disparava notificação do sistema assinada com o nome do app.
      const ses = contents.session;
      if (ses && !ses.__vcPermissoesNegadas) {
        ses.__vcPermissoesNegadas = true;
        // 'serial' é a ÚNICA permissão liberada, e SÓ para a janela principal
        // (a UI do app). Um <webview> — que carrega painel de roteador, página
        // remota — nunca ganha acesso à porta serial: `getType()` distingue a
        // janela ('window') do webview ('webview'). Todo o resto segue negado.
        const ehAppPrincipal = (wc) => {
          try { return wc && typeof wc.getType === 'function' && wc.getType() !== 'webview'; }
          catch { return false; }
        };
        ses.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'serial' && ehAppPrincipal(wc)));
        ses.setPermissionCheckHandler((wc, perm) => perm === 'serial' && ehAppPrincipal(wc));
        // Depois da permissão, o Chromium consulta isto para o dispositivo em si.
        // Só serial, e só vindo da origem do próprio app (localhost) — reforço
        // sobre a checagem de webContents acima.
        ses.setDevicePermissionHandler((det) => {
          const daApp = det && typeof det.origin === 'string'
            && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(det.origin);
          return det && det.deviceType === 'serial' && daApp;
        });
        // O seletor de porta: o Chromium dispara aqui e espera o callback. A
        // ponte (lib/serialbridge) decide qual porta, comandada pela tela.
        try {
          const serialbridge = require('../lib/serialbridge');
          ses.on('select-serial-port', (_event, portList, wc, callback) => {
            if (!ehAppPrincipal(wc)) { callback(''); return; }
            serialbridge.aoSelecionar(portList, callback);
          });
          serialbridge.marcarLigado();
        } catch (e) {
          console.error('[serial] ponte indisponível:', e && e.message);
        }
      }
    });
  }

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

    // Janela nova pedida pela INTERFACE do app. Duas situações diferentes:
    //
    //   mesma origem  → é o botão "soltar aba": abre uma janela nativa própria,
    //                   com as mesmas garantias da principal
    //   outra origem  → link externo, vai para o navegador do sistema, como
    //                   sempre foi
    // Comparação por ORIGEM PARSEADA, não por prefixo de texto.
    //
    // `url.startsWith('http://127.0.0.1:62462')` aceitava
    // `http://127.0.0.1:62462@evil.example/` — em que o "127.0.0.1:62462" é
    // USERINFO e o host real é evil.example — e também
    // `http://127.0.0.1:624620/`, outra porta. Nos dois casos o app abriria a
    // página de terceiro como JANELA NATIVA, com webviewTag ligado.
    const ehDoApp = (bruto) => {
      let u;
      try { u = new URL(bruto); } catch { return false; }
      return u.protocol === 'http:' && u.hostname === '127.0.0.1'
        && u.port === String(port) && !u.username && !u.password;
    };
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (ehDoApp(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 1100,
            height: 720,
            minWidth: 600,
            minHeight: 400,
            title: APP_NAME,
            icon: iconPath,
            backgroundColor: '#080b0e',
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              webviewTag: true,
              // A janela solta bate ponto no servidor a cada 5 s para dizer
              // "estou com este host". O Chromium estrangula temporizador de
              // janela em segundo plano, e uma janela solta passa a vida em
              // segundo plano — o prazo de 20 s do registro vencia com a janela
              // VIVA, e a janela principal abria uma segunda conexão ao mesmo
              // servidor, já travada pela agenda e impossível de fechar.
              backgroundThrottling: false,
            },
          },
        };
      }
      shell.openExternal(url);
      return { action: 'deny' };
    });
    // Certificado de gerência de equipamento é quase sempre autoassinado. Em vez
    // de recusar (inútil) ou aceitar qualquer um (perigoso), faz o mesmo que o
    // SSH já faz com o fingerprint: aceita na PRIMEIRA visita, guarda, e a
    // partir daí recusa se mudar — porque aí ou trocaram o equipamento, ou
    // alguém está no meio do caminho.
    //
    // Alcance real, para o comentário não prometer demais: isto só roda quando
    // o Chromium REJEITA o certificado. Um certificado que encadeia numa CA
    // confiável nunca chega aqui e nunca é fixado — daí a etiqueta na interface
    // dizer "certificado autoassinado fixado", e não "certificado verificado".
    electronApp.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
      let alvo;
      try { alvo = new URL(url); } catch { return callback(false); }
      const impressao = String((certificate && certificate.fingerprint) || '');
      if (!impressao) return callback(false);

      const dados = store.get();
      const hosts = Array.isArray(dados.hosts) ? dados.hosts : [];
      // Casa pelo host+porta da URL: o pino pertence ao endereço, não ao rótulo.
      const porta = Number(alvo.port) || (alvo.protocol === 'https:' ? 443 : 80);
      // QUAL host? Casar só por endereço escolhia o PRIMEIRO registro com
      // aquele host:porta — que pode não ser o que abriu a aba. Com dois
      // cadastros para o mesmo equipamento, o pino consultado era o do outro
      // registro: aceitava certificado novo em silêncio, gravava no lugar
      // errado, e "esquecer certificado" no host certo não resolvia nada.
      //
      // Cada aba web roda numa partição própria (persist:web-<hostId>), e
      // session.fromPartition devolve SEMPRE o mesmo objeto para a mesma
      // string. Comparar a sessão do webContents com a partição de cada
      // candidato identifica o host exato que abriu a página.
      const daSessao = (h) => {
        try {
          const nome = String(h.id).startsWith('qc_') ? 'web-' + h.id : 'persist:web-' + h.id;
          return webContents && webContents.session === session.fromPartition(nome);
        } catch { return false; }
      };
      const candidatos = hosts.filter((h) => h.protocol === 'web');
      const avulsos = quickhosts.listar ? quickhosts.listar('web') : [];
      const host = candidatos.find(daSessao) || avulsos.find(daSessao)
        // Recuo para arquivos antigos/casos sem partição reconhecível: só aceita
        // quando NÃO houver ambiguidade de endereço.
        || (() => {
          const mesmos = candidatos.filter((h) => String(h.host) === alvo.hostname
            && Number(h.port || 443) === porta);
          if (mesmos.length === 1) return mesmos[0];
          if (mesmos.length > 1) {
            console.error(`[desktop] certificado recusado: ${mesmos.length} hosts web`
              + ` no mesmo endereço ${alvo.host} e não deu para saber qual abriu a aba`);
            return null;
          }
          return quickhosts.acharPorEndereco('web', alvo.hostname, porta);
        })();
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

  electronApp.whenReady().then(protegerConteudos).then(createWindow).then(setupAutoUpdate).catch((err) => {
    console.error('[desktop] falha ao iniciar:', err);
    electronApp.quit();
  });

  electronApp.on('activate', () => {
    // Recria a PRINCIPAL, e não "qualquer janela".
    //
    // Com uma aba solta numa janela própria, fechar a principal deixava o app
    // vivo e sem caminho de volta: a contagem nunca chegava a zero. E é a janela
    // principal quem cuida da agenda dos hosts (a solta não abre nada por conta
    // própria) — sem ela, a agenda simplesmente parava, e as sessões travadas
    // ficavam órfãs sem ninguém para reatá-las.
    if (!win || win.isDestroyed()) createWindow();
    else win.show();
  });

  electronApp.on('window-all-closed', () => electronApp.quit());
}
