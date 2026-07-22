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
    'watch=[0,3,fd]',
    'try:',
    ' while True:',
    '  r,_,_=select.select(watch,[],[])',
    '  if 0 in r:',
    '   d=os.read(0,65536)',
    '   if not d: break',
    '   os.write(fd,d)',
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
    '   d=os.read(fd,65536)',
    '   if not d: break',
    '   os.write(1,d)',
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
    const send = (o) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); };
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { ws.close(); return; }
    const cols = clamp(url.searchParams.get('cols'), 2, 500, 80);
    const rows = clamp(url.searchParams.get('rows'), 2, 300, 24);
    const shell = pickShell();
    send({ t: 'e', d: `Terminal local — ${os.userInfo().username}@${os.hostname()} (${shell})\r\n` });

    let bridge;
    try {
      bridge = process.platform === 'win32' ? spawnWindows(shell) : spawnUnixPty(shell, cols, rows);
    } catch (e) {
      send({ t: 'e', d: 'Não foi possível abrir o shell local: ' + (e && e.message) + '\r\n' });
      send({ t: 'x' });
      ws.close();
      return;
    }
    const child = bridge.child;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      try { child.kill(); } catch {}
      try { ws.close(); } catch {}
    };

    send({ t: 'ready' });
    child.stdout.on('data', (d) => send({ t: 'o', d: d.toString('utf8') }));
    if (child.stderr) child.stderr.on('data', (d) => send({ t: 'o', d: d.toString('utf8') }));
    child.on('error', (e) => {
      send({ t: 'e', d: 'Erro no shell local: ' + (e && e.message) + '\r\n' });
      send({ t: 'x' });
      cleanup();
    });
    child.on('close', () => { send({ t: 'x' }); cleanup(); });

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === 'i' && typeof m.d === 'string') {
        try { child.stdin.write(m.d); } catch {}
      } else if (m.t === 'r') {
        bridge.resize(clamp(m.cols, 2, 500, cols), clamp(m.rows, 2, 300, rows));
      }
    });
    ws.on('close', cleanup);
    ws.on('error', cleanup);
});

module.exports = { wss };
