'use strict';

// Capturas de saída do terminal: a "evidência" que o histórico de comandos não
// tem. O analista tira uma foto da tela ANTES da janela de manutenção e outra
// DEPOIS, com rótulo, e compara. Moram no data.json (entram no backup
// automático) — por isso os tetos: o store serializa o arquivo inteiro a cada
// gravação, e capturas sem limite virariam um data.json de dezenas de MB.

const MAX = { rotulo: 120, texto: 100 * 1024, capturas: 200 };

function normalizar(entrada) {
  const e = entrada || {};
  const rotulo = String(e.rotulo == null ? '' : e.rotulo).trim();
  if (!rotulo) return { erro: 'Dê um rótulo à captura (ex.: "BGP antes da janela").' };
  if (rotulo.length > MAX.rotulo) return { erro: 'Rótulo longo demais.' };
  let texto = String(e.texto == null ? '' : e.texto).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!texto.trim()) return { erro: 'Não há saída para capturar — o terminal está vazio.' };
  let truncada = false;
  if (texto.length > MAX.texto) { texto = texto.slice(0, MAX.texto); truncada = true; }
  const hostId = e.hostId == null ? null : String(e.hostId).slice(0, 80);
  const hostName = String(e.hostName == null ? '' : e.hostName).trim().slice(0, 120);
  return { rotulo, texto, hostId, hostName, truncada };
}

module.exports = { normalizar, MAX };
