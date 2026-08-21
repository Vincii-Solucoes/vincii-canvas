'use strict';

// A ponte entre o renderer e o seletor de portas seriais do Electron.
//
// O Web Serial vive no renderer, mas QUEM ESCOLHE a porta é o processo main: o
// Chromium dispara `select-serial-port` e espera um callback com a porta. Sem
// handler, `navigator.serial.requestPort()` fica pendurado para sempre. E o
// renderer fala com o main só pela API HTTP (não há IPC direto neste app), então
// este módulo — que roda no main, junto do servidor Express — faz a mediação.
//
// Dois modos, comandados pelo renderer antes de cada `requestPort()`:
//   - "enumerar": o próximo evento captura a LISTA de portas (para o dropdown) e
//     cancela a escolha (callback('')). É como a tela descobre o que existe;
//   - "abrir": o próximo evento seleciona a porta com o id escolhido.
//
// Fora do Electron (`npm start` num navegador comum) nada disto é registrado:
// `disponivel()` devolve false e a tela cai no seletor nativo do próprio Chrome.

let ligado = false;

// O evento `select-serial-port` em curso: a lista e o callback do Chromium, mais
// o resolvedor de quem estiver esperando a lista pelo /api/serial/ports.
let modo = null;            // 'enumerar' | 'abrir' | null
let portIdDesejado = '';    // no modo 'abrir'
let esperandoLista = [];    // resolvers de /api/serial/ports pendentes
let ultimaLista = [];       // última lista vista, para responder sem novo evento

// Chamado pelo main assim que os handlers do Electron são registrados.
function marcarLigado() { ligado = true; }
function disponivel() { return ligado; }

// O renderer arma o modo ANTES de chamar requestPort().
function definirModo(novoModo, portId) {
  modo = novoModo === 'abrir' ? 'abrir' : novoModo === 'enumerar' ? 'enumerar' : null;
  portIdDesejado = modo === 'abrir' ? String(portId || '') : '';
}

// O handler do Electron chama isto no `select-serial-port`. Não conhece Electron:
// recebe a lista (array simples) e o callback, e decide pelo modo armado.
function aoSelecionar(portList, callback) {
  const lista = Array.isArray(portList) ? portList : [];
  ultimaLista = lista;
  if (modo === 'abrir') {
    // Só seleciona um id que ESTÁ na lista — senão cancela, em vez de mandar um
    // id inventado ao Chromium.
    const achou = lista.find((p) => p && p.portId === portIdDesejado);
    modo = null;
    try { callback(achou ? portIdDesejado : ''); } catch { /* já foi */ }
    return;
  }
  // enumerar (ou modo nulo, por segurança): entrega a lista à tela e cancela.
  modo = null;
  resolverEsperas(lista);
  try { callback(''); } catch { /* já foi */ }
}

function resolverEsperas(lista) {
  const fila = esperandoLista;
  esperandoLista = [];
  for (const r of fila) { try { r(lista); } catch { /* ignora */ } }
}

// /api/serial/ports: espera o próximo select-serial-port trazer a lista. Tem
// teto de tempo para não pendurar a requisição se o evento nunca vier (sem
// dispositivo, ou o Chromium não disparou) — nesse caso devolve o que tiver.
function pendentes(timeoutMs = 4000) {
  return new Promise((resolve) => {
    let feito = false;
    const done = (lista) => { if (feito) return; feito = true; clearTimeout(t); resolve(lista); };
    esperandoLista.push(done);
    const t = setTimeout(() => {
      esperandoLista = esperandoLista.filter((r) => r !== done);
      done(ultimaLista);
    }, timeoutMs);
  });
}

module.exports = {
  marcarLigado, disponivel, definirModo, aoSelecionar, pendentes,
  // teste
  _reset() { ligado = false; modo = null; portIdDesejado = ''; esperandoLista = []; ultimaLista = []; },
};
