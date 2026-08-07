'use strict';

// Terminal LOCAL: abre um shell na PRÓPRIA máquina e faz a ponte com o xterm do
// navegador (mesmo protocolo do terminal SSH, mas sem SSH). O servidor escuta só
// em 127.0.0.1, então isto só é acessível de quem já está usando o app na máquina.
//
// mac/Linux: PTY real via módulo `pty` do Python (echo, edição de linha, TUIs) —
//   sem dependência nativa nova.
// Windows: sem PTY nativo aqui; abre o shell (PowerShell/cmd) por pipes — funciona
//   para comandos, mas sem TUI completa (para isso seria preciso node-pty/ConPTY).

const os = require('os');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const termsessions = require('./termsessions');

function clamp(n, lo, hi, dflt) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, v));
}

function pickShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || '/bin/zsh';
}

// PTY real via Python (mac/Linux). fd 3 recebe "cols rows\n" para redimensionar.
function spawnUnixPty(shell, cols, rows) {
  const py = [
    'import os,pty,fcntl,termios,struct,select,sys',
    'sh=sys.argv[1]',
    'base=os.path.basename(sh)',
    'args=[sh,"-l"] if base in ("bash","zsh","sh","fish","-bash","-zsh") else [sh]',
    'pid,fd=pty.fork()',
    'if pid==0: os.execvp(sh,args)',
    'def setwin(c,r):',
    ' try: fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack("HHHH",r,c,0,0))',
    ' except OSError: pass',
    `setwin(${cols},${rows})`,
    'buf=b""',
    // O laço é de uma thread só. Com `os.write(fd,d)` bloqueante, colar um bloco
    // grande travava TUDO: o buffer do PTY enchia, o eco do shell enchia o
    // buffer de saída, e nenhum dos dois lados drenava porque a thread estava
    // parada dentro do write. Medido: 1500 B ok, 2048 B → a aba nunca mais
    // respondia, marcada "conectado", só resolvia fechando.
    //
    // Conserto: fd em modo não bloqueante e uma FILA de saída. O que não couber
    // agora fica pendente, `fd` entra no conjunto de escrita do select, e a
    // leitura continua rodando entre uma fatia e outra.
    'fl=fcntl.fcntl(fd,fcntl.F_GETFL)',
    'fcntl.fcntl(fd,fcntl.F_SETFL,fl|os.O_NONBLOCK)',
    'pend=b""',
    'watch=[0,3,fd]',
    'try:',
    ' while True:',
    '  r,w,_=select.select(watch,[fd] if pend else [],[])',
    '  if pend and fd in w:',
    '   try: n=os.write(fd,pend)',
    '   except BlockingIOError: n=0',
    '   pend=pend[n:]',
    '  if 0 in r:',
    '   d=os.read(0,65536)',
    '   if not d: break',
    '   pend+=d',
    '   try: n=os.write(fd,pend)',
    '   except BlockingIOError: n=0',
    '   pend=pend[n:]',
    '  if 3 in r:',
    '   c=os.read(3,4096)',
    '   if not c:',
    '    watch=[0,fd]',
    '   else:',
    '    buf+=c',
    '    while b"\\n" in buf:',
    '     ln,buf=buf.split(b"\\n",1)',
    '     p=ln.split()',
    '     if len(p)==2:',
    '      try: setwin(int(p[0]),int(p[1]))',
    '      except ValueError: pass',
    '  if fd in r:',
    '   try: d=os.read(fd,65536)',
    '   except BlockingIOError: d=b"x"',
    '   except OSError: break',
    '   if not d: break',
    '   if d!=b"x": os.write(1,d)',
    'except OSError: pass',
  ].join('\n');
  const py3 = process.env.PYTHON || 'python3';
  // TERM garante que programas de tela (vim, less, clear, top…) funcionem
  const env = { ...process.env, TERM: process.env.TERM || 'xterm-256color', COLORTERM: 'truecolor' };
  const child = spawn(py3, ['-c', py, shell], { env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  return { child, resize: (c, r) => { try { child.stdio[3].write(`${c} ${r}\n`); } catch {} } };
}

// Fallback Windows (sem PTY): abre o shell por pipes.
function spawnWindows(shell) {
  const child = spawn(shell, [], { env: process.env });
  return { child, resize: () => {} };
}

// noServer: roteamento de upgrade centralizado no server.js
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws, req) => {
    const enviarDireto = (o) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); };
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { ws.close(); return; }

    // Reatar a uma sessão local já existente: o shell continua rodando, só a
    // janela que o exibe muda.
    const idSessao = url.searchParams.get('sessao');
    if (idSessao) {
      const existente = termsessions.pegar(idSessao);
      if (!existente || existente.encerrada) {
        enviarDireto({ t: 'e', d: '\r\nEsta sessão não existe mais (foi encerrada ou expirou).\r\n' });
        enviarDireto({ t: 'x' });
        try { ws.close(); } catch {}
        return;
      }
      existente.atacar(ws);
      return;
    }

    const cols = clamp(url.searchParams.get('cols'), 2, 500, 80);
    const rows = clamp(url.searchParams.get('rows'), 2, 300, 24);
    const shell = pickShell();
    // O shell passa a pertencer à SESSÃO: fechar a janela deixa a sessão órfã
    // (viva) em vez de matar o processo.
    const sessao = termsessions.criar({ rotulo: 'Meu computador', hostId: null });
    const send = (o) => sessao.enviar(o);
    sessao.definirCanal({
      escrever: () => {}, redimensionar: () => {}, encerrar: () => {},
    });
    sessao.atacar(ws);
    send({ t: 'e', d: `Terminal local — ${os.userInfo().username}@${os.hostname()} (${shell})\r\n` });

    let bridge;
    try {
      bridge = process.platform === 'win32' ? spawnWindows(shell) : spawnUnixPty(shell, cols, rows);
    } catch (e) {
      send({ t: 'e', d: 'Não foi possível abrir o shell local: ' + (e && e.message) + '\r\n' });
      sessao.encerrar('o shell local não abriu');
      return;
    }
    const child = bridge.child;
    const cleanup = () => sessao.encerrar('o shell local terminou');
    sessao.definirCanal({
      escrever: (d) => { try { child.stdin.write(d); } catch {} },
      redimensionar: (c2, r2) => bridge.resize(clamp(c2, 2, 500, cols), clamp(r2, 2, 300, rows)),
      encerrar: () => { try { child.kill(); } catch {} },
    });

    send({ t: 'ready' });
    child.stdout.on('data', (d) => send({ t: 'o', d: d.toString('utf8') }));
    if (child.stderr) child.stderr.on('data', (d) => send({ t: 'o', d: d.toString('utf8') }));
    child.on('error', (e) => {
      send({ t: 'e', d: 'Erro no shell local: ' + (e && e.message) + '\r\n' });
      send({ t: 'x' });
      cleanup();
    });
    child.on('close', cleanup);
    // Entrada, redimensionamento e fechamento do socket são tratados pela
    // sessão (lib/termsessions.js) — fechar a janela não mata o shell.
});

module.exports = { wss };
