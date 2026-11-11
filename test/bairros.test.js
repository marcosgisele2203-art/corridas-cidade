// Testes dos bairros desenhados pela central (lib/bairros.js). Rodar com: npm test
const test = require('node:test');
const assert = require('node:assert');
const { contornoValido, dentro, bairroDoPonto } = require('../lib/bairros');

// quadrado de ~1 km em volta do centro de Miranda
const CENTRO = [[-20.235, -56.385], [-20.235, -56.375], [-20.245, -56.375], [-20.245, -56.385]];
// bairro pequeno dentro do "Centro"
const VILA = [[-20.238, -56.382], [-20.238, -56.379], [-20.241, -56.379], [-20.241, -56.382]];
// triângulo ao lado
const JARDIM = [[-20.235, -56.375], [-20.235, -56.365], [-20.245, -56.370]];

const lista = [{ nome: 'Centro', contorno: CENTRO }, { nome: 'Vila Nova', contorno: VILA }, { nome: 'Jardim', contorno: JARDIM }];

test('dentro: ponto dentro e fora do contorno', () => {
  assert.strictEqual(dentro({ lat: -20.24, lng: -56.38 }, CENTRO), true);
  assert.strictEqual(dentro({ lat: -20.25, lng: -56.38 }, CENTRO), false);
  assert.strictEqual(dentro({ lat: -20.24, lng: -56.371 }, JARDIM), true);
  assert.strictEqual(dentro({ lat: -20.2445, lng: -56.366 }, JARDIM), false); // canto de fora do triângulo
});

test('bairroDoPonto escolhe o bairro certo e, se um está dentro do outro, o menor', () => {
  assert.strictEqual(bairroDoPonto({ lat: -20.236, lng: -56.384 }, lista), 'Centro');
  assert.strictEqual(bairroDoPonto({ lat: -20.2395, lng: -56.3805 }, lista), 'Vila Nova');
  assert.strictEqual(bairroDoPonto({ lat: -20.24, lng: -56.371 }, lista), 'Jardim');
});

test('bairroDoPonto devolve vazio fora de todos os bairros ou sem ponto', () => {
  assert.strictEqual(bairroDoPonto({ lat: -20.3, lng: -56.4 }, lista), '');
  assert.strictEqual(bairroDoPonto(null, lista), '');
  assert.strictEqual(bairroDoPonto({ lat: NaN, lng: 1 }, lista), '');
  assert.strictEqual(bairroDoPonto({ lat: -20.24, lng: -56.38 }, []), '');
});

test('contornoValido exige pelo menos 3 pontos com coordenadas válidas', () => {
  assert.strictEqual(contornoValido(CENTRO), true);
  assert.strictEqual(contornoValido(CENTRO.slice(0, 2)), false);
  assert.strictEqual(contornoValido([[-20, -56], [-20, 'x'], [-21, -56]]), false);
  assert.strictEqual(contornoValido([[-20, -56], [-20, -57], [-95, -56]]), false);
  assert.strictEqual(contornoValido('[[1,2]]'), false);
  assert.strictEqual(contornoValido(null), false);
});
