'use strict';

// Que campos de um host o backup leva — e, para os que não leva, por quê.
//
// Existe porque o pior defeito do backup foi um campo órfão: quando RDP e VNC
// entraram, ninguém lembrou do parser de importação, e a restauração passou a
// devolver todo host RDP como SSH e a descartar todo host VNC. `rdpDomain`
// nasceu órfão do mesmo jeito — o usuário digitava o domínio, o backup não o
// levava, e o logon com Active Directory falhava depois de restaurar, com o
// cadastro parecendo completo na tela.
//
// A lista abaixo é conferida por test/backup.test.js, que DERIVA os campos do
// `return` de parseHostBody (server.js) e confronta com o host de referência do
// teste. Acrescentar um campo de host sem classificá-lo aqui quebra a suíte.
//
// Isto nem sempre foi verdade: por um tempo o comentário afirmava a garantia
// enquanto o teste só comparava duas listas escritas à mão — um campo novo
// passava verde e sumia do XML em silêncio. Comentário que promete guarda
// inexistente é pior que nenhum.

// Atributos do <host>. A ordem é a mesma da saída, para facilitar a leitura.
const HOST_ATRIBUTOS = [
  'name', 'host', 'port', 'username', 'protocol', 'ftps', 'rdpDomain', 'url',
  'group', 'subgroup', 'icon', 'color',
];

// Atributos que só fazem sentido num protocolo — o export os omite nos demais,
// para o arquivo não carregar campo morto.
const HOST_ATRIBUTOS_CONDICIONAIS = { ftps: 'ftp', rdpDomain: 'rdp', url: 'web' };

// Vão como elementos filhos (<auth/>, <agenda/> e <vars>), não como atributos.
// São objetos: `agenda` tem início e fim, `auth` tem tipo e credencial. Um
// atributo só não os representa, e achatá-los em `agendaInicio`/`agendaFim`
// espalharia o mesmo campo por várias colunas do arquivo.
const HOST_FILHOS = ['auth', 'agenda', 'segredo', 'vars'];

// `segredo` é a REFERÊNCIA a um item de cofre externo (apelido do cofre + id do
// item). Vai no arquivo porque não é segredo nenhum, e sem ela a restauração
// devolve um host que não sabe onde buscar a credencial — parecendo completo na
// tela e falhando na conexão. A CHAVE de API do cofre é outra coisa e mora fora
// do data.json (lib/cofresegredos.js), justamente para não ter como escorrer
// para cá.

// Fora do arquivo de propósito. O motivo fica junto: sem ele, o próximo a ler
// isto vai "consertar" a ausência e reabrir um buraco de segurança.
const HOST_EXCLUIDOS = {
  id: 'gerado por instalação; o casamento é por nome+endereço, não por id',
  fingerprint: 'prova de identidade do servidor, aprendida na primeira conexão (TOFU). '
    + 'Aceitá-la de um arquivo deixaria um XML de terceiro apontar um host seu para '
    + 'outro servidor já "aprovado", e a senha salva iria para ele sem alarme.',
  rdpLegadoOk: 'consentimento de segurança dado pelo usuário NESTA máquina, não '
    + 'configuração. Restaurando, o app pergunta de novo — um clique.',
  rdpLegado: 'resíduo inerte: nenhuma linha do projeto lê ou escreve este campo.',
  webCert: 'impressão digital do certificado da página web, fixada na primeira '
    + 'visita nesta máquina (TOFU). Mesma família do fingerprint do SSH: aceitá-la '
    + 'de um arquivo deixaria um XML de terceiro pré-aprovar um certificado.',
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HOST_ATRIBUTOS, HOST_ATRIBUTOS_CONDICIONAIS, HOST_FILHOS, HOST_EXCLUIDOS };
}
