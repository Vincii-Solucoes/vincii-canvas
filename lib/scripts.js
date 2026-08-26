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

module.exports = { normalizar, MAX };
