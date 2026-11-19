// Mapa de fundo das páginas (passageiro, motorista, painel e link de acompanhamento).
// Com CARTO_KEY usa o CARTO Voyager, mais limpo e feito para celular; sem a chave, continua o OpenStreetMap padrão.
// A chave do CARTO vai no endereço das imagens do mapa, então ela é visível no navegador:
// proteja-a no painel do CARTO restringindo aos domínios do site.

function configuracao(chave) {
  chave = String(chave || '').trim();
  if (chave) {
    return {
      url: 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=' + encodeURIComponent(chave),
      atribuicao: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    };
  }
  return {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    atribuicao: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  };
}

// Script servido em /mapa-fundo.js. As páginas chamam mapaFundo(mapa) no lugar do L.tileLayer.
// referrerPolicy 'origin': o CARTO confere o domínio do site, mas nunca recebe o caminho da página
// (o link de acompanhamento tem um código secreto no endereço).
// Chave do Google Maps para o navegador (GOOGLE_MAPS_KEY_SITE): fica visível no site, então deve ser uma chave
// separada da do servidor e travada no Google Cloud para o domínio do site. Formato inválido vira '' (sem Google).
function chaveGoogle(chave) {
  chave = String(chave || '').trim();
  return /^[A-Za-z0-9_-]{20,80}$/.test(chave) ? chave : '';
}

function script(chave, google) {
  return `window.MAPA_FUNDO = ${JSON.stringify(configuracao(chave))};
window.MAPA_GOOGLE = ${JSON.stringify(chaveGoogle(google))};
window.mapaFundo = function (mapa) {
  var c = window.MAPA_FUNDO;
  return L.tileLayer(c.url, { maxZoom: 19, attribution: c.atribuicao, referrerPolicy: 'origin' }).addTo(mapa);
};
`;
}

module.exports = { chaveGoogle, configuracao, script };
