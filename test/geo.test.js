// Testes das funções de distância, preço e busca de endereço (lib/geo.js).
// Rodar com: npm test   (usa o node:test, sem bibliotecas extras; a internet é simulada)
const test = require('node:test');
const assert = require('node:assert');
const geo = require('../lib/geo');

const cfg = { cidade: 'Miranda, MS', fator_rota: 1.3 };
const A = { lat: -20.2405, lng: -56.378 };
const B = { lat: -20.255, lng: -56.392 };

// troca o fetch por respostas prontas; cada teste diz o que a "internet" responde
function simularInternet(responder) {
  const chamadas = [];
  global.fetch = async (url, opcoes) => {
    chamadas.push(String(url));
    const r = await responder(String(url), opcoes);
    if (r instanceof Error) throw r;
    return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.body };
  };
  return chamadas;
}

test('preço: taxa base + km, nunca abaixo do mínimo, arredondado de 50 em 50 centavos', () => {
  const carro = { taxa_base: 5, por_km: 2, minimo: 8 };
  assert.strictEqual(geo.preco(1, carro), 8);      // 5 + 2 = 7 → mínimo 8
  assert.strictEqual(geo.preco(2.8, carro), 11);   // 5 + 5,6 = 10,6 → 11,00
  assert.strictEqual(geo.preco(2.6, carro), 10.5); // 5 + 5,2 = 10,2 → 10,50
  assert.strictEqual(geo.preco(null, carro), null);
});

test('kmRuas usa a distância do OSRM pelas ruas', async () => {
  const chamadas = simularInternet(() => ({ body: { code: 'Ok', routes: [{ distance: 3456 }] } }));
  const km = await geo.kmRuas(A, B, cfg);
  assert.strictEqual(km, 3.5);
  assert.match(chamadas[0], /\/route\/v1\/driving\/-56\.378,-20\.2405;-56\.392,-20\.255/);
});

test('kmRuas guarda a rota e não pergunta de novo para os mesmos pontos', async () => {
  const chamadas = simularInternet(() => ({ body: { routes: [{ distance: 1000 }] } }));
  const C = { lat: -20.3, lng: -56.4 }, D = { lat: -20.31, lng: -56.41 };
  assert.strictEqual(await geo.kmRuas(C, D, cfg), 1);
  assert.strictEqual(await geo.kmRuas(C, D, cfg), 1);
  assert.strictEqual(chamadas.length, 1);
});

test('kmRuas volta para linha reta × fator quando o OSRM falha', async () => {
  simularInternet(() => new Error('sem internet'));
  const E = { lat: -20.25, lng: -56.38 }, F = { lat: -20.26, lng: -56.39 };
  assert.strictEqual(await geo.kmRuas(E, F, cfg), geo.kmRota(E, F, cfg));
  simularInternet(() => ({ status: 500, body: {} }));
  const G = { lat: -20.27, lng: -56.38 };
  assert.strictEqual(await geo.kmRuas(E, G, cfg), geo.kmRota(E, G, cfg));
});

test('kmRuas sem ponto devolve null (corrida no taxímetro)', async () => {
  assert.strictEqual(await geo.kmRuas(null, B, cfg), null);
  assert.strictEqual(await geo.kmRuas(A, { lat: NaN, lng: 1 }, cfg), null);
});

test('sugerirEnderecos só devolve lugares perto da cidade e com a palavra digitada', async () => {
  simularInternet((url) => {
    if (url.includes('nominatim')) return { body: [{ lat: '-20.24', lon: '-56.378' }] }; // centro de Miranda
    return { body: { features: [
      { geometry: { coordinates: [-56.38, -20.25] }, properties: { name: 'Rodoviária de Miranda', district: 'Centro', city: 'Miranda' } },
      { geometry: { coordinates: [-54.6, -20.4] }, properties: { name: 'Rodoviária de Campo Grande', city: 'Campo Grande' } },
      { geometry: { coordinates: [-56.37, -20.24] }, properties: { name: 'Mercado Central', city: 'Miranda' } },
    ] } };
  });
  const lista = await geo.sugerirEnderecos('Rodoviária', cfg);
  assert.strictEqual(lista.length, 1);
  assert.strictEqual(lista[0].properties.name, 'Rodoviária de Miranda');
  assert.strictEqual(lista[0].properties.context.neighborhood.name, 'Centro');
  assert.deepStrictEqual(lista[0].geometry.coordinates, [-56.38, -20.25]);
});

test('enderecoDoPonto devolve rua e bairro do Photon', async () => {
  simularInternet(() => ({ body: { features: [{ properties: { street: 'Rua Oriel Xavier', district: 'Centro' } }] } }));
  assert.deepStrictEqual(await geo.enderecoDoPonto(A), { rua: 'Rua Oriel Xavier', bairro: 'Centro' });
  simularInternet(() => ({ body: { features: [] } }));
  assert.deepStrictEqual(await geo.enderecoDoPonto(A), { rua: '', bairro: '' });
});

test('sugerirEnderecos mantém o número do imóvel', async () => {
  simularInternet((url) => {
    if (url.includes('nominatim')) return { body: [{ lat: '-20.24', lon: '-56.378' }] };
    return { body: { features: [
      { geometry: { coordinates: [-56.38, -20.25] }, properties: { street: 'Rua Oriel Xavier', housenumber: '2' } },
      { geometry: { coordinates: [-56.38, -20.25] }, properties: { name: 'Rua Oriel Xavier', street: 'Rua Oriel Xavier', housenumber: '40' } },
      { geometry: { coordinates: [-56.38, -20.25] }, properties: { name: 'Padaria Oriel', street: 'Rua Oriel Xavier', housenumber: '7' } },
    ] } };
  });
  const nomes = (await geo.sugerirEnderecos('Oriel Xavier', cfg)).map((f) => f.properties.name);
  assert.deepStrictEqual(nomes, ['Rua Oriel Xavier, 2', 'Rua Oriel Xavier, 40', 'Padaria Oriel (Rua Oriel Xavier, 7)']);
});

// ---- Google Maps (só com GOOGLE_MAPS_KEY)
const MIRANDA = { body: [{ lat: '-20.24', lon: '-56.378' }] }; // centro da cidade (Nominatim)

test('buscarEndereco usa o Google Geocoding quando há GOOGLE_MAPS_KEY', async () => {
  process.env.GOOGLE_MAPS_KEY = 'chave-teste';
  try {
    const chamadas = simularInternet((url) => {
      if (url.includes('nominatim')) return MIRANDA;
      return { body: { status: 'OK', results: [{ types: ['street_address'], geometry: { location: { lat: -20.245, lng: -56.38 } } }] } };
    });
    assert.deepStrictEqual(await geo.buscarEndereco('Rua Oriel Xavier, 40', cfg), { lat: -20.245, lng: -56.38 });
    const google = chamadas.find((u) => u.includes('maps.googleapis.com/maps/api/geocode'));
    assert.ok(google, 'deveria perguntar ao Google');
    assert.match(google, /components=country:BR/);
    assert.ok(!chamadas.some((u) => u.includes('photon')), 'não precisa do OpenStreetMap se o Google achou');
  } finally { delete process.env.GOOGLE_MAPS_KEY; }
});

test('Google: resultado que é só a cidade não vale; tenta o Places pelo nome do lugar', async () => {
  process.env.GOOGLE_MAPS_KEY = 'chave-teste';
  try {
    let corpoPlaces;
    simularInternet((url, opcoes) => {
      if (url.includes('nominatim')) return MIRANDA;
      if (url.includes('geocode')) return { body: { status: 'OK', results: [{ types: ['locality', 'political'], geometry: { location: { lat: -20.24, lng: -56.378 } } }] } };
      corpoPlaces = { url, opcoes };
      return { body: { places: [{ types: ['bus_station'], location: { latitude: -20.25, longitude: -56.385 } }] } };
    });
    assert.deepStrictEqual(await geo.buscarEndereco('Rodoviária', cfg), { lat: -20.25, lng: -56.385 });
    assert.match(corpoPlaces.url, /places\.googleapis\.com\/v1\/places:searchText/);
    assert.strictEqual(corpoPlaces.opcoes.headers['X-Goog-Api-Key'], 'chave-teste');
    assert.match(JSON.parse(corpoPlaces.opcoes.body).textQuery, /Rodoviária, Miranda/);
  } finally { delete process.env.GOOGLE_MAPS_KEY; }
});

test('Google longe da cidade ou com erro: volta para o OpenStreetMap', async () => {
  process.env.GOOGLE_MAPS_KEY = 'chave-teste';
  try {
    simularInternet((url) => {
      if (url.includes('nominatim.openstreetmap.org/search') && url.includes('Oriel')) return { body: [{ lat: '-20.246', lon: '-56.379' }] };
      if (url.includes('nominatim')) return MIRANDA;
      if (url.includes('geocode')) return { body: { status: 'OK', results: [{ types: ['route'], geometry: { location: { lat: -20.4, lng: -54.6 } } }] } }; // Campo Grande
      return { status: 403, body: { error: { message: 'API key not valid' } } };
    });
    assert.deepStrictEqual(await geo.buscarEndereco('Rua Oriel Xavier', cfg), { lat: -20.246, lng: -56.379 });
    simularInternet((url) => {
      if (url.includes('nominatim.openstreetmap.org/search') && url.includes('Oriel')) return { body: [{ lat: '-20.246', lon: '-56.379' }] };
      if (url.includes('nominatim')) return MIRANDA;
      return { body: { status: 'REQUEST_DENIED', error_message: 'faturamento desligado' } };
    });
    assert.deepStrictEqual(await geo.buscarEndereco('Rua Oriel Xavier', cfg), { lat: -20.246, lng: -56.379 });
  } finally { delete process.env.GOOGLE_MAPS_KEY; }
});

test('sem GOOGLE_MAPS_KEY o Google nunca é chamado', async () => {
  delete process.env.GOOGLE_MAPS_KEY;
  const chamadas = simularInternet((url) => (url.includes('nominatim') ? { body: [{ lat: '-20.246', lon: '-56.379' }] } : { body: {} }));
  await geo.buscarEndereco('Rua Oriel Xavier', cfg);
  assert.ok(!chamadas.some((u) => u.includes('google')));
});

// ---- sugestões do site do passageiro com o Google (só quando o OpenStreetMap não acha nada)
test('sugerirEnderecos pergunta ao Google quando o Photon não acha e guarda a resposta', async () => {
  process.env.GOOGLE_MAPS_KEY = 'chave-teste';
  try {
    let corpo;
    const chamadas = simularInternet((url, opcoes) => {
      if (url.includes('nominatim')) return MIRANDA;
      if (url.includes('photon')) return { body: { features: [] } };
      corpo = JSON.parse(opcoes.body);
      return { body: { places: [
        { types: ['city_hall'], location: { latitude: -20.241, longitude: -56.379 }, displayName: { text: 'Prefeitura Municipal de Miranda' },
          addressComponents: [
            { longText: 'Rua Barão do Rio Branco', types: ['route'] }, { longText: '515', types: ['street_number'] },
            { longText: 'Centro', types: ['sublocality_level_1', 'sublocality'] }, { longText: 'Miranda', types: ['administrative_area_level_2'] }] },
        { types: ['city_hall'], location: { latitude: -20.46, longitude: -54.62 }, displayName: { text: 'Prefeitura de Campo Grande' } },
        { types: ['locality', 'political'], location: { latitude: -20.24, longitude: -56.378 }, displayName: { text: 'Miranda' } },
      ] } };
    });
    const lista = await geo.sugerirEnderecos('prefeitura', cfg);
    assert.strictEqual(lista.length, 1, 'só a prefeitura de Miranda: a de Campo Grande é longe e "Miranda" é só a cidade');
    assert.strictEqual(lista[0].properties.name, 'Prefeitura Municipal de Miranda (Rua Barão do Rio Branco, 515)');
    assert.strictEqual(lista[0].properties.context.neighborhood.name, 'Centro');
    assert.deepStrictEqual(lista[0].geometry.coordinates, [-56.379, -20.241]);
    assert.match(corpo.textQuery, /prefeitura, Miranda/);
    const doGoogle = () => chamadas.filter((u) => u.includes('places.googleapis.com')).length;
    assert.strictEqual(doGoogle(), 1);
    await geo.sugerirEnderecos('Prefeitura ', cfg); // mesmo termo: não pergunta de novo ao Google
    assert.strictEqual(doGoogle(), 1);
  } finally { delete process.env.GOOGLE_MAPS_KEY; }
});

test('sugerirEnderecos não chama o Google quando o Photon acha, sem chave ou com texto curto', async () => {
  process.env.GOOGLE_MAPS_KEY = 'chave-teste';
  try {
    let chamadas = simularInternet((url) => (url.includes('nominatim') ? MIRANDA
      : { body: { features: [{ geometry: { coordinates: [-56.38, -20.25] }, properties: { name: 'Rodoviária de Miranda' } }] } }));
    assert.strictEqual((await geo.sugerirEnderecos('Rodoviária', cfg)).length, 1);
    assert.ok(!chamadas.some((u) => u.includes('google')));
    chamadas = simularInternet((url) => (url.includes('nominatim') ? MIRANDA : { body: { features: [] } }));
    assert.deepStrictEqual(await geo.sugerirEnderecos('pre', cfg), []);
    delete process.env.GOOGLE_MAPS_KEY;
    assert.deepStrictEqual(await geo.sugerirEnderecos('prefeitura nova', cfg), []);
    assert.ok(!chamadas.some((u) => u.includes('google')));
  } finally { delete process.env.GOOGLE_MAPS_KEY; }
});

test('se o Photon e o Google falharem, a sugestão volta vazia sem erro', async () => {
  process.env.GOOGLE_MAPS_KEY = 'chave-teste';
  try {
    simularInternet((url) => (url.includes('nominatim') ? MIRANDA : url.includes('photon') ? new Error('sem internet')
      : { status: 403, body: { error: { message: 'API key not valid' } } }));
    assert.deepStrictEqual(await geo.sugerirEnderecos('posto de saude', cfg), []);
  } finally { delete process.env.GOOGLE_MAPS_KEY; }
});

// ---- rua e bairro de um ponto marcado no mapa
test('enderecoDoPonto pega rua e bairro do Google e guarda o ponto', async () => {
  process.env.GOOGLE_MAPS_KEY = 'chave-teste';
  try {
    const chamadas = simularInternet(() => ({ body: { status: 'OK', results: [
      { address_components: [{ long_name: 'Rua do Cedro', types: ['route'] }, { long_name: '99', types: ['street_number'] }] },
      { address_components: [{ long_name: 'Loteamento Mondego', types: ['sublocality_level_1', 'sublocality', 'political'] }] },
    ] } }));
    const P = { lat: -20.25863, lng: -56.37805 };
    assert.deepStrictEqual(await geo.enderecoDoPonto(P), { rua: 'Rua do Cedro', bairro: 'Loteamento Mondego' });
    assert.match(chamadas[0], /geocode\/json.*latlng=-20\.2586,-56\.3781/);
    await geo.enderecoDoPonto({ lat: -20.25864, lng: -56.37806 }); // mesmo lugar (diferença de 1 m)
    assert.strictEqual(chamadas.length, 1);
  } finally { delete process.env.GOOGLE_MAPS_KEY; }
});

test('enderecoDoPonto volta para o Photon se o Google falhar ou não achar nada', async () => {
  process.env.GOOGLE_MAPS_KEY = 'chave-teste';
  try {
    simularInternet((url) => (url.includes('googleapis') ? { body: { status: 'REQUEST_DENIED', error_message: 'faturamento' } }
      : { body: { features: [{ properties: { street: 'Rua Oriel Xavier', district: 'Centro' } }] } }));
    assert.deepStrictEqual(await geo.enderecoDoPonto({ lat: -20.3, lng: -56.3 }), { rua: 'Rua Oriel Xavier', bairro: 'Centro' });
    simularInternet((url) => (url.includes('googleapis') ? { body: { status: 'ZERO_RESULTS', results: [] } }
      : { body: { features: [{ properties: { street: 'Rua B' } }] } }));
    assert.deepStrictEqual(await geo.enderecoDoPonto({ lat: -20.31, lng: -56.31 }), { rua: 'Rua B', bairro: '' });
  } finally { delete process.env.GOOGLE_MAPS_KEY; }
});

test('bairro igual ao nome da cidade (erro do OpenStreetMap) não aparece', async () => {
  delete process.env.GOOGLE_MAPS_KEY;
  simularInternet((url) => (url.includes('nominatim') ? MIRANDA : { body: { features: [
    { geometry: { coordinates: [-56.38, -20.25] }, properties: { name: 'Rua Oriel Xavier', district: 'Miranda', city: 'Miranda' } }] } }));
  const [s] = await geo.sugerirEnderecos('Oriel', cfg);
  assert.strictEqual(s.properties.context.neighborhood, undefined);
  simularInternet(() => ({ body: { features: [{ properties: { street: 'Rua Mondego', locality: 'Miranda', city: 'Miranda' } }] } }));
  assert.deepStrictEqual(await geo.enderecoDoPonto({ lat: -20.32, lng: -56.32 }), { rua: 'Rua Mondego', bairro: '' });
});

test('com número digitado, a sugestão do Google com o número certo vem no topo', async () => {
  process.env.GOOGLE_MAPS_KEY = 'chave-teste';
  try {
    const chamadas = simularInternet((url) => {
      if (url.includes('nominatim')) return MIRANDA;
      if (url.includes('photon')) return { body: { features: [{ geometry: { coordinates: [-56.37, -20.25] }, properties: { name: 'Rua Oriel Xavier' } }] } };
      return { body: { status: 'OK', results: [{ types: ['street_address'], geometry: { location: { lat: -20.2621, lng: -56.3812 } },
        address_components: [{ long_name: '2', types: ['street_number'] }, { long_name: 'Rua Oriel Xavier', types: ['route'] },
          { long_name: 'Baiazinha', types: ['sublocality_level_1', 'sublocality'] }, { long_name: 'Miranda', types: ['administrative_area_level_2'] }] }] } };
    });
    const lista = await geo.sugerirEnderecos('Rua Oriel Xavier 2', cfg);
    assert.strictEqual(lista[0].properties.name, 'Rua Oriel Xavier, 2');
    assert.strictEqual(lista[0].properties.context.neighborhood.name, 'Baiazinha');
    assert.deepStrictEqual(lista[0].geometry.coordinates, [-56.3812, -20.2621]);
    assert.strictEqual(lista[1].properties.name, 'Rua Oriel Xavier'); // a do OpenStreetMap continua, embaixo
    assert.ok(chamadas.some((u) => u.includes('geocode/json')));
  } finally { delete process.env.GOOGLE_MAPS_KEY; }
});

test('sem número digitado, ou se o Google só achar a rua, não muda nada', async () => {
  process.env.GOOGLE_MAPS_KEY = 'chave-teste';
  try {
    let chamadas = simularInternet((url) => (url.includes('nominatim') ? MIRANDA
      : { body: { features: [{ geometry: { coordinates: [-56.37, -20.25] }, properties: { name: 'Rua Oriel Xavier' } }] } }));
    await geo.sugerirEnderecos('Rua Oriel Xavier', cfg);
    assert.ok(!chamadas.some((u) => u.includes('google')));
    chamadas = simularInternet((url) => {
      if (url.includes('nominatim')) return MIRANDA;
      if (url.includes('photon')) return { body: { features: [{ geometry: { coordinates: [-56.37, -20.25] }, properties: { name: 'Rua Oriel Xavier' } }] } };
      return { body: { status: 'OK', results: [{ types: ['route'], geometry: { location: { lat: -20.26, lng: -56.38 } },
        address_components: [{ long_name: 'Rua Oriel Xavier', types: ['route'] }] }] } };
    });
    const lista = await geo.sugerirEnderecos('Rua Oriel Xavier 999', cfg);
    assert.strictEqual(lista.length, 1);
    assert.strictEqual(lista[0].properties.name, 'Rua Oriel Xavier');
  } finally { delete process.env.GOOGLE_MAPS_KEY; }
});
