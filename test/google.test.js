// Testes da busca de endereço e bairro pelo Google Maps (lib/geo.js com GOOGLE_MAPS_KEY).
// A internet é simulada: nenhum teste chama o Google de verdade.
const test = require('node:test');
const assert = require('node:assert');
const geo = require('../lib/geo');

const cfg = { cidade: 'Miranda, MS', fator_rota: 1.3 };
const CENTRO = { results: [{ geometry: { location: { lat: -20.24, lng: -56.378 } }, address_components: [] }], status: 'OK' };

function simularInternet(responder) {
  const chamadas = [];
  global.fetch = async (url, opcoes = {}) => {
    chamadas.push({ url: String(url), opcoes });
    const r = await responder(String(url), opcoes);
    if (r instanceof Error) throw r;
    return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.body };
  };
  return chamadas;
}

test.beforeEach(() => { process.env.GOOGLE_MAPS_KEY = 'chave-de-teste'; });
test.afterEach(() => { delete process.env.GOOGLE_MAPS_KEY; });

test('enderecoDoPonto pega rua e bairro do Google, procurando o bairro em todos os resultados', async () => {
  const chamadas = simularInternet(() => ({ body: { status: 'OK', results: [
    { address_components: [{ long_name: 'Rua Oriel Xavier', types: ['route'] }] },
    { address_components: [{ long_name: 'Vila Maria', types: ['sublocality_level_1', 'sublocality', 'political'] }] },
  ] } }));
  assert.deepStrictEqual(await geo.enderecoDoPonto({ lat: -20.241, lng: -56.379 }), { rua: 'Rua Oriel Xavier', bairro: 'Vila Maria' });
  assert.match(chamadas[0].url, /maps\.googleapis\.com\/maps\/api\/geocode\/json\?latlng=-20\.241%2C-56\.379/);
  assert.match(chamadas[0].url, /language=pt-BR/);
});

test('enderecoDoPonto volta para o Photon quando o Google recusa (ex.: faturamento desligado)', async () => {
  simularInternet((url) => {
    if (url.includes('googleapis')) return { body: { status: 'REQUEST_DENIED', error_message: 'Billing' } };
    return { body: { features: [{ properties: { street: 'Rua do Photon', district: 'Centro' } }] } };
  });
  assert.deepStrictEqual(await geo.enderecoDoPonto({ lat: -20.242, lng: -56.38 }), { rua: 'Rua do Photon', bairro: 'Centro' });
});

test('sugerirEnderecos usa o Google, mostra o bairro e descarta lugares longe ou só a cidade', async () => {
  const chamadas = simularInternet((url) => {
    if (url.includes('geocode')) return { body: CENTRO };
    return { body: { places: [
      { displayName: { text: 'Rodoviária de Miranda' }, location: { latitude: -20.25, longitude: -56.38 }, types: ['bus_station'],
        addressComponents: [
          { longText: 'Rua Barão do Rio Branco', types: ['route'] }, { longText: '100', types: ['street_number'] },
          { longText: 'Jardim Aeroporto', types: ['sublocality_level_1', 'sublocality', 'political'] },
          { longText: 'Miranda', types: ['administrative_area_level_2', 'political'] }] },
      { displayName: { text: 'Rodoviária de Campo Grande' }, location: { latitude: -20.4, longitude: -54.6 }, types: ['bus_station'] },
      { displayName: { text: 'Miranda' }, location: { latitude: -20.24, longitude: -56.378 }, types: ['locality', 'political'] },
    ] } };
  });
  const lista = await geo.sugerirEnderecos('Rodoviária', cfg);
  assert.strictEqual(lista.length, 1);
  assert.strictEqual(lista[0].properties.name, 'Rodoviária de Miranda (Rua Barão do Rio Branco, 100)');
  assert.strictEqual(lista[0].properties.context.neighborhood.name, 'Jardim Aeroporto');
  assert.deepStrictEqual(lista[0].geometry.coordinates, [-56.38, -20.25]);
  const places = chamadas.find((c) => c.url.includes('places.googleapis.com'));
  assert.strictEqual(places.opcoes.headers['X-Goog-Api-Key'], 'chave-de-teste');
  assert.strictEqual(JSON.parse(places.opcoes.body).textQuery, 'Rodoviária, Miranda, MS');
});

test('buscarEndereco (WhatsApp) usa o Google e cai no OpenStreetMap se o Google falhar', async () => {
  simularInternet((url) => {
    if (url.includes('geocode')) return { body: CENTRO };
    if (url.includes('places.googleapis.com')) return { body: { places: [
      { displayName: { text: 'Rua Sete' }, location: { latitude: -20.243, longitude: -56.371 }, types: ['route'] }] } };
    throw new Error('não deveria chamar o OSM');
  });
  assert.deepStrictEqual(await geo.buscarEndereco('Rua Sete 45', cfg), { lat: -20.243, lng: -56.371 });

  simularInternet((url) => {
    if (url.includes('googleapis.com')) return { status: 403, body: { error: { message: 'API key not valid' } } };
    if (url.includes('nominatim')) return { body: [{ lat: '-20.245', lon: '-56.375' }] };
    return { body: { features: [] } };
  });
  assert.deepStrictEqual(await geo.buscarEndereco('Rua Oito 12', cfg), { lat: -20.245, lng: -56.375 });
});

test('sem GOOGLE_MAPS_KEY o Google nunca é chamado', async () => {
  delete process.env.GOOGLE_MAPS_KEY;
  const chamadas = simularInternet(() => ({ body: { features: [{ properties: { street: 'Rua X', district: 'Centro' } }] } }));
  await geo.enderecoDoPonto({ lat: -20.249, lng: -56.377 });
  assert.ok(chamadas.every((c) => !c.url.includes('googleapis')));
});
