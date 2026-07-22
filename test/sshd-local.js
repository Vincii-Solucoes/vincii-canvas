'use strict';

// Servidor SSH local APENAS para testar o SSH Commander sem tocar em servidores reais.
// Escuta somente em 127.0.0.1 e executa os comandos NA SUA MÁQUINA via /bin/sh.
// Usuário: demo | Senha: segredo123 | Porta: 2222

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Server } = require('ssh2');

const KEY = path.join(__dirname, '.host_key');
const USER = 'demo';
const PASS = 'segredo123';
const PORT = 2222;

if (!fs.existsSync(KEY)) {
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', KEY, '-N', '', '-q']);
}

const server = new Server({ hostKeys: [fs.readFileSync(KEY)] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASS) return ctx.accept();
    ctx.reject(['password']);
  });

  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      let ptyInfo = null;
      let shellChild = null;
      session.on('pty', (a, reject, info) => {
        ptyInfo = info;
        if (a) a();
      });
      // Redimensionamento: encaminha o novo tamanho ao PTY do Python (fd 3)
      session.on('window-change', (a, reject, info) => {
        if (shellChild && shellChild.stdio[3]) {
          try { shellChild.stdio[3].write(`${info.cols} ${info.rows}\n`); } catch {}
        }
        if (a) a();
      });
      session.on('exec', (accept, reject, info) => {
        console.log(`[sshd-local] exec: ${info.command}`);
        const stream = accept();
        const child = spawn('/bin/sh', ['-c', info.command]);
        child.stdout.pipe(stream, { end: false });
        child.stderr.pipe(stream.stderr, { end: false });
        child.on('close', (code) => {
          stream.exit(code == null ? 1 : code);
          stream.end();
        });
      });
      // Shell interativo: aloca um PTY real via módulo pty do Python (dá echo e
      // edição de linha como um servidor SSH de verdade). Só para testes locais.
      session.on('shell', (accept) => {
        console.log('[sshd-local] shell interativo');
        const stream = accept();
        const cols = (ptyInfo && ptyInfo.cols) || 80;
        const rows = (ptyInfo && ptyInfo.rows) || 24;
        // fd 3 recebe comandos de resize do processo pai ("cols rows\n") e
        // aplica TIOCSWINSZ no PTY, para o shell refluir quando o xterm mudar
        // de tamanho — igual a um servidor SSH real.
        const py = [
          'import os,pty,fcntl,termios,struct,select',
          'pid,fd=pty.fork()',
          'if pid==0: os.execvp("/bin/bash",["/bin/bash","-i"])',
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
          '   d=os.read(0,4096)',
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
          '   d=os.read(fd,4096)',
          '   if not d: break',
          '   os.write(1,d)',
          'except OSError: pass',
        ].join('\n');
        const env = { ...process.env, TERM: (ptyInfo && ptyInfo.term) || 'xterm-256color' };
        const child = spawn('python3', ['-c', py], { env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
        shellChild = child;
        child.stdout.pipe(stream, { end: false });
        child.stderr.pipe(stream.stderr, { end: false });
        stream.on('data', (d) => { try { child.stdin.write(d); } catch {} });
        stream.on('close', () => { try { child.kill(); } catch {} });
        child.on('error', (e) => { try { stream.write('erro ao abrir shell: ' + e.message + '\r\n'); stream.end(); } catch {} });
        child.on('close', (code) => {
          try { stream.exit(code == null ? 0 : code); } catch {}
          try { stream.end(); } catch {}
        });
      });
    });
  });

  client.on('error', () => {});
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[sshd-local] escutando em 127.0.0.1:${PORT} — usuário: ${USER} | senha: ${PASS}`);
});
