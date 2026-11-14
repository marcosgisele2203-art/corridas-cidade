// Testes do mapa de fundo (lib/mapa-fundo.js). Rodar com: npm test
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const mapaFundo = require('../lib/mapa-fundo');

test('com CARTO_KEY usa o CARTO Voyager e cita CARTO e OpenStreetMap', () => {
  const c = mapaFundo.configuracao(' chave-teste ');
  assert.strictEqual(c.url, 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=chave-teste');
  assert.match(c.atribuicao, /CARTO/);
  assert.match(c.atribuicao, /OpenStreetMap/);
});

test('sem CARTO_KEY continua o OpenStreetMap padrão', () => {
  for (const vazio of [undefined, '', '   ']) {
    assert.strictEqual(mapaFundo.configuracao(vazio).url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  }
});

test('o script cria a camada com referrerPolicy origin e a atribuição', () => {
  const chamadas = [];
  const mapa = {};
  const L = { tileLayer: (url, op) => { chamadas.push({ url, op }); return { addTo: (m) => { chamadas.push({ addTo: m }); return 'camada'; } }; } };
  const janela = { L };
  janela.window = janela;
  vm.runInNewContext(mapaFundo.script('abc'), janela);
  assert.strictEqual(janela.mapaFundo(mapa), 'camada');
  assert.match(chamadas[0].url, /voyager.*key=abc/);
  assert.strictEqual(chamadas[0].op.referrerPolicy, 'origin');
  assert.strictEqual(chamadas[0].op.maxZoom, 19);
  assert.match(chamadas[0].op.attribution, /CARTO/);
  assert.strictEqual(chamadas[1].addTo, mapa);
});
