'use strict';

// Configuração de lint conservadora, para ESTE código como ele é.
//
// O projeto é JavaScript puro, sem tipagem: CommonJS no backend e script de
// escopo GLOBAL no navegador (os arquivos de public/ compartilham escopo, sem
// import/export). Um lint agressivo aqui produziria centenas de falsos
// positivos (no-undef em cima de globais cruzadas entre arquivos, no-empty em
// cima dos `catch {}` best-effort que o projeto usa DE PROPÓSITO).
//
// Então este config habilita só regras que pegam BUG de verdade e quase nunca
// disparam à toa: chave/argumento duplicado, atribuição em condição, código
// inalcançável, typeof inválido, reatribuir const, etc. `no-unused-vars` fica
// como AVISO (há exports e capturas intencionais). É um piso honesto, não uma
// camisa de força — dá para apertar aos poucos.

const bugRules = {
  // 'except-parens' (padrão): pega o perigoso `if (x = y)` mas permite o idioma
  // consciente `while ((m = re.exec(s)))` com parênteses extras, que o projeto usa.
  'no-cond-assign': ['error', 'except-parens'],
  'no-dupe-args': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-const-assign': 'error',
  'no-dupe-class-members': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-finally': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-setter-return': 'error',
  'getter-return': 'error',
  'no-obj-calls': 'error',
  'no-compare-neg-zero': 'error',
  'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
};

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', 'build/**'],
  },
  // Backend e utilitários: CommonJS.
  {
    files: ['server.js', 'lib/**/*.js', 'desktop/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
    rules: bugRules,
  },
  // Frontend "clássico": scripts de escopo global (sem import/export). São
  // parseados como script; as globais entre arquivos não são conferidas (não há
  // no-undef ligado), que é o certo enquanto não houver módulos.
  {
    files: ['public/**/*.js'],
    ignores: ['public/desktop.js', 'public/scancodes.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script' },
    rules: bugRules,
  },
  // Frontend ESM: os dois únicos módulos ES de public/.
  {
    files: ['public/desktop.js', 'public/scancodes.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: bugRules,
  },
];
