'use strict';

// Assinatura ad-hoc no macOS (sem certificado pago). O electron-builder, sem um
// "Developer ID", não assina o app — e no Apple Silicon (arm64) um app com
// assinatura inválida aparece como "está danificado". Re-assinar ad-hoc deixa o
// binário válido: o macOS passa a tratar como "desenvolvedor não verificado"
// (o usuário libera na 1ª abertura com botão direito → Abrir) em vez de
// "danificado". Não substitui a assinatura/notarização oficial da Apple.

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename + '.app';
  const appPath = path.join(context.appOutDir, appName);
  try {
    // remove xattrs (resource fork / Finder info) que fazem o codesign falhar
    // com "resource fork ... detritus not allowed"
    execFileSync('xattr', ['-cr', appPath]);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath]);
    console.log('[afterPack] ad-hoc signed:', appPath);
  } catch (e) {
    const err = (e && e.stderr && e.stderr.toString()) || (e && e.message) || String(e);
    console.warn('[afterPack] falha ao assinar ad-hoc:\n' + err);
  }
};
