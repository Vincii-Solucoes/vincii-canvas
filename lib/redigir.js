'use strict';

// Tira da saída tudo que é segredo, antes de o texto sair desta máquina.
//
// Existe separado porque havia DOIS caminhos mandando texto do terminal para a
// API da Anthropic, e só um redigia:
//
//   - lib/agent.js  (agente autônomo)   -> redigia
//   - lib/ai.js     (assistente do lado) -> NÃO redigia
//
// O assistente recebe `terminalContext`: um retrato da tela da sessão, mandado
// pelo navegador a cada pergunta. Se a senha aparece na tela — e com Telnet ela
// aparece, porque o equipamento pede login em texto; e com `echo $PASS`,
// `env`, um script de deploy ou um erro de conexão, também — ela ia inteira,
// em texto claro, para a API. Inclusive a senha que veio do cofre e que o resto
// do app trata como "nunca toca o disco".
//
// Uma função, os dois caminhos. Um terceiro caminho que apareça amanhã chama
// esta, ou não chama nada — e nesse caso o erro é visível aqui, e não escondido
// numa cópia que ficou para trás.

const store = require('./store');

// Curto demais casaria com texto comum e encheria a saída de marcadores.
const MINIMO = 6;
const MARCA = '[…segredo guardado no app, removido…]';

// `segredosVivos` vem de lib/credenciais.js. O require fica preguiçoso porque
// credenciais.js não depende deste módulo, mas agent.js depende dos dois — e um
// ciclo aqui quebraria o carregamento com um erro que não diz nada.
function vivos() {
  try { return require('./credenciais').segredosVivos(); } catch { return []; }
}

// Tudo que o app conhece: o que está gravado no data.json MAIS o que está
// resolvido em memória agora (credencial vinda de cofre, que não está gravada
// em lugar nenhum).
function segredosConhecidos() {
  const out = [];
  try {
    const d = store.get();
    if (d.settings && d.settings.apiKey) out.push(d.settings.apiKey);
    for (const h of d.hosts || []) {
      if (h.auth && h.auth.password) out.push(h.auth.password);
      if (h.auth && h.auth.passphrase) out.push(h.auth.passphrase);
    }
  } catch { /* store indisponível: segue com o que houver em memória */ }
  out.push(...vivos());
  return [...new Set(out)].filter((x) => typeof x === 'string' && x.length >= MINIMO);
}

function redigir(texto) {
  if (typeof texto !== 'string' || !texto) return texto;
  let s = texto;
  // Do mais longo para o mais curto: se uma senha for pedaço de outra, apagar a
  // curta primeiro deixaria o resto da longa visível na tela.
  for (const seg of segredosConhecidos().sort((a, b) => b.length - a.length)) {
    s = s.split(seg).join(MARCA);
  }
  return s;
}

module.exports = { redigir, segredosConhecidos, MARCA, MINIMO };
