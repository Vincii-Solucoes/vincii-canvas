'use strict';

// Scripts do "bloco de notas de comandos": trechos que o usuário guarda,
// organiza por grupo/subgrupo e edita (à mão ou pela IA). Diferente do playbook,
// o script NÃO roda em lote nos hosts — é biblioteca pessoal, copia-e-cola.
//
// A normalização mora aqui, pura, pelo mesmo motivo de agrupar.js: é regra de
// dados, testável em Node, e as três portas de entrada (criar, editar, e o
// rascunho da IA) precisam da MESMA validação — senão uma delas deixa passar o
// que a outra barra, que foi como o subgrupo órfão nasceu.

const MAX = { name: 120, group: 80, subgroup: 80, description: 400, body: 100000 };

// Devolve o script saneado, ou { erro } com a mensagem para a tela.
function normalizar(entrada) {
  const e = entrada || {};
  const name = String(e.name == null ? '' : e.name).trim();
  if (!name) return { erro: 'Informe um nome para o script.' };
  if (name.length > MAX.name) return { erro: 'Nome longo demais.' };
  const group = String(e.group == null ? '' : e.group).trim().slice(0, MAX.group);
  // Subgrupo só existe DENTRO de um grupo — mesma invariante dos hosts
  // (agrupar.js). Sem grupo, o subgrupo é descartado em vez de virar uma seção
  // órfã dentro de "Sem grupo".
  const subgroup = group ? String(e.subgroup == null ? '' : e.subgroup).trim().slice(0, MAX.subgroup) : '';
  const description = String(e.description == null ? '' : e.description).trim().slice(0, MAX.description);
  // \r\n -> \n: o corpo é texto multi-linha; normalizar a quebra evita diff
  // espúrio e CR solto atravessando para o terminal na hora de copiar.
  const body = String(e.body == null ? '' : e.body).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (body.length > MAX.body) return { erro: 'Script grande demais (máximo 100 000 caracteres).' };
  return { name, group, subgroup, description, body };
}

// Funde scripts importados (de backup XML) DENTRO de `destino`, mutando-o.
// O app permite dois scripts com o mesmo nome+grupo+subgrupo, então casar só
// pelo trio colapsaria homônimos num só (perda silenciosa). Regra:
//   1. casa pelo `id` (identidade estável que viaja no XML) — round-trip 1:1,
//      reimport não duplica;
//   2. sem id (arquivo antigo), casa pelo trio, mas CONSOME cada registro já
//      casado nesta rodada, para a 2ª entrada homônima não reatingir a 1ª;
//   3. cria com o id do arquivo (preserva identidade); se colidir, `gerarId()`.
// `gerarId` é injetado para o teste não depender de crypto.
function fundirImportados(destino, entradas, gerarId) {
  const usados = new Set();
  let added = 0; let updated = 0; const invalidos = [];
  for (const raw of Array.isArray(entradas) ? entradas : []) {
    const v = normalizar(raw);
    if (v.erro) { invalidos.push(String((raw && raw.name) || '')); continue; }
    const rid = raw && typeof raw.id === 'string' ? raw.id : '';
    let ex = rid ? destino.find((x) => x.id === rid) : null;
    if (!ex) {
      ex = destino.find((x) => !usados.has(x.id)
        && x.name === v.name && (x.group || '') === v.group && (x.subgroup || '') === v.subgroup);
    }
    if (ex) { Object.assign(ex, v, { updatedAt: Date.now() }); usados.add(ex.id); updated += 1; }
    else {
      const id = rid && !destino.some((x) => x.id === rid) ? rid : gerarId();
      destino.push({ id, ...v, updatedAt: Date.now() }); usados.add(id); added += 1;
    }
  }
  return { added, updated, invalidos };
}

module.exports = { normalizar, fundirImportados, MAX };
