'use strict';

// Servidor SSH local APENAS para testar o SSH Commander sem tocar em servidores reais.
// Escuta somente em 127.0.0.1 e executa os comandos NA SUA MÁQUINA via /bin/sh.
// Usuário: demo | Senha: segredo123 | Porta: 2222

const fs = require('fs');
const path = require('path');

// pasta servida pelo subsistema SFTP (para testar a aba Arquivos)
const os = require('os');
const SFTP_ROOT = path.join(os.tmpdir(), 'vincii-sftp-teste');
try { fs.mkdirSync(SFTP_ROOT, { recursive: true }); } catch {}
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

      // Subsistema SFTP: serve uma pasta temporária, para testar a aba Arquivos
      // sem precisar de um servidor externo.
      session.on('sftp', (acceptSftp) => {
        const sftp = acceptSftp();
        const raiz = SFTP_ROOT;
        const abrir = new Map();
        let seq = 0;
        const S = require('ssh2').utils.sftp.STATUS_CODE;
        const OPEN_MODE = require('ssh2').utils.sftp.OPEN_MODE;
        const real = (p) => {
          const limpo = path.normalize(String(p || '.')).replace(/^(\.\.[/\\])+/, '');
          const abs = path.resolve(raiz, limpo.replace(/^\//, ''));
          return abs.startsWith(raiz) ? abs : raiz; // não sai da pasta servida
        };
        const attrs = (st) => ({ mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: st.atimeMs / 1000, mtime: st.mtimeMs / 1000 });

        sftp.on('REALPATH', (id, p) => {
          const abs = real(p);
          const rel = '/' + path.relative(raiz, abs).replace(/\\/g, '/');
          sftp.name(id, [{ filename: rel === '/' ? '/' : rel, longname: rel, attrs: {} }]);
        });
        sftp.on('STAT', (id, p) => statResp(id, p, false));
        sftp.on('LSTAT', (id, p) => statResp(id, p, true));
        function statResp(id, p, l) {
          try { sftp.attrs(id, attrs(l ? fs.lstatSync(real(p)) : fs.statSync(real(p)))); }
          catch { sftp.status(id, S.NO_SUCH_FILE); }
        }
        sftp.on('OPENDIR', (id, p) => {
          try {
            const abs = real(p);
            if (!fs.statSync(abs).isDirectory()) return sftp.status(id, S.FAILURE);
            const h = Buffer.alloc(4); h.writeUInt32BE(++seq);
            abrir.set(seq, { tipo: 'dir', abs, lido: false });
            sftp.handle(id, h);
          } catch { sftp.status(id, S.NO_SUCH_FILE); }
        });
        sftp.on('READDIR', (id, h) => {
          const k = h.readUInt32BE(0); const e = abrir.get(k);
          if (!e || e.tipo !== 'dir') return sftp.status(id, S.FAILURE);
          if (e.lido) return sftp.status(id, S.EOF);
          e.lido = true;
          const nomes = fs.readdirSync(e.abs);
          sftp.name(id, nomes.map((n) => {
            const st = fs.lstatSync(path.join(e.abs, n));
            return { filename: n, longname: (st.isDirectory() ? 'd' : '-') + 'rw-r--r-- 1 u g ' + st.size + ' ' + n, attrs: attrs(st) };
          }));
        });
        sftp.on('OPEN', (id, p, flags) => {
          try {
            const abs = real(p);
            const leitura = !!(flags & OPEN_MODE.READ);
            const fd = fs.openSync(abs, leitura ? 'r' : 'w');
            const h = Buffer.alloc(4); h.writeUInt32BE(++seq);
            abrir.set(seq, { tipo: 'file', fd, abs });
            sftp.handle(id, h);
          } catch { sftp.status(id, S.NO_SUCH_FILE); }
        });
        sftp.on('READ', (id, h, offset, len) => {
          const e = abrir.get(h.readUInt32BE(0));
          if (!e || e.tipo !== 'file') return sftp.status(id, S.FAILURE);
          const buf = Buffer.alloc(len);
          const n = fs.readSync(e.fd, buf, 0, len, offset);
          if (n <= 0) return sftp.status(id, S.EOF);
          sftp.data(id, buf.slice(0, n));
        });
        sftp.on('WRITE', (id, h, offset, data) => {
          const e = abrir.get(h.readUInt32BE(0));
          if (!e || e.tipo !== 'file') return sftp.status(id, S.FAILURE);
          fs.writeSync(e.fd, data, 0, data.length, offset);
          sftp.status(id, S.OK);
        });
        sftp.on('CLOSE', (id, h) => {
          const k = h.readUInt32BE(0); const e = abrir.get(k);
          if (e && e.tipo === 'file') { try { fs.closeSync(e.fd); } catch {} }
          abrir.delete(k);
          sftp.status(id, S.OK);
        });
        const simples = (ev, fn) => sftp.on(ev, (id, ...a) => { try { fn(...a); sftp.status(id, S.OK); } catch { sftp.status(id, S.FAILURE); } });
        simples('MKDIR', (p) => fs.mkdirSync(real(p)));
        simples('RMDIR', (p) => fs.rmdirSync(real(p)));
        simples('REMOVE', (p) => fs.unlinkSync(real(p)));
        simples('RENAME', (de, para) => fs.renameSync(real(de), real(para)));
        simples('SETSTAT', (p, at) => { if (at && at.mode != null) fs.chmodSync(real(p), at.mode & 0o777); });
        console.log('[sshd-local] sessão SFTP aberta em ' + raiz);
      });
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
