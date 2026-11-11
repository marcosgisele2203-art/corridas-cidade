// Distância, preço e busca de endereço digitado.
// Endereços e bairros: Google Maps quando há GOOGLE_MAPS_KEY (acha bem mais bairros de cidade pequena);
// sem a chave, ou se o Google falhar, usa o OpenStreetMap (Nominatim e Photon, grátis).

function kmLinhaReta(a, b) {
  const R = 6371, rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const temPonto = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);

// distância aproximada pelas ruas (linha reta × fator da configuração)
function kmRota(a, b, cfg) {
  if (!temPonto(a) || !temPonto(b)) return null;
  return Math.round(kmLinhaReta(a, b) * Number(cfg.fator_rota || 1.3) * 10) / 10;
}

// distância pelas ruas (OSRM, grátis e sem conta). Se o OSRM não responder, usa a linha reta × fator (kmRota).
// O site do passageiro e o WhatsApp usam esta mesma função, então o preço mostrado é o mesmo cobrado.
const OSRM_URL = (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');
const rotasCache = new Map(); // "lat,lng;lat,lng" → km (guarda as últimas 500 rotas)
async function kmRuas(a, b, cfg) {
  if (!temPonto(a) || !temPonto(b)) return null;
  if (process.env.ROTA_PELAS_RUAS === 'nao') return kmRota(a, b, cfg);
  const chave = [a.lat, a.lng, b.lat, b.lng].map((n) => Number(n).toFixed(5)).join(',');
  if (rotasCache.has(chave)) return rotasCache.get(chave);
  try {
    const r = await fetch(`${OSRM_URL}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`,
      { headers: AGENTE, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('OSRM respondeu ' + r.status);
    const d = await r.json();
    const metros = d.routes?.[0]?.distance;
    if (!Number.isFinite(metros)) throw new Error('OSRM sem rota');
    const km = Math.round((metros / 1000) * 10) / 10;
    if (rotasCache.size >= 500) rotasCache.delete(rotasCache.keys().next().value);
    rotasCache.set(chave, km);
    return km;
  } catch (e) {
    console.log('Rota pelas ruas indisponível, usando linha reta × fator:', e.message);
    return kmRota(a, b, cfg);
  }
}

// taxa base + km, nunca abaixo do mínimo, arredondado para cima de 50 em 50 centavos
// tabela = preços de um tipo de veículo (cfg.precos.carro, por exemplo)
function preco(km, tabela) {
  if (km == null) return null;
  const v = Math.max(Number(tabela.minimo), Number(tabela.taxa_base) + km * Number(tabela.por_km));
  return Math.ceil(v * 2) / 2;
}

const reais = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');

// ---- busca de endereço digitado ("Rodoviária", "Rua tal 123") perto da cidade da central
// Tenta o Nominatim (OpenStreetMap) e, se não achar, o Photon (também OpenStreetMap). Os dois são grátis e sem conta.
const AGENTE = { 'User-Agent': 'corridas-cidade/1.0 (central de corridas pelo WhatsApp)' };
const RAIO_KM = 40; // resultado mais longe que isso do centro da cidade é de outra cidade com rua de mesmo nome
const centros = new Map(); // cidade → centro (para não perguntar toda vez)

async function pedirJson(url) {
  const r = await fetch(url, { headers: AGENTE, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('mapa respondeu ' + r.status);
  return r.json();
}

// ---- Google Maps (só no servidor: a chave nunca vai para o navegador)
// Usa a Places API (New) para achar endereço/lugar digitado e a Geocoding API para rua e bairro de um ponto.
const chaveGoogle = () => String(process.env.GOOGLE_MAPS_KEY || '').trim();

// pega rua, número e bairro dos "address components" do Google
// (aceita os dois formatos: Geocoding usa long_name, Places (New) usa longText)
function partesGoogle(componentes) {
  const lista = Array.isArray(componentes) ? componentes : [];
  const pega = (...tipos) => {
    for (const t of tipos) {
      const c = lista.find((x) => Array.isArray(x.types) && x.types.includes(t));
      if (c) return String(c.long_name ?? c.longText ?? '');
    }
    return '';
  };
  return {
    rua: pega('route'),
    numero: pega('street_number'),
    bairro: pega('sublocality_level_1', 'sublocality', 'neighborhood'),
    cidade: pega('administrative_area_level_2', 'locality'),
  };
}

// resultado que é só a cidade, o estado ou o país inteiro não serve como endereço
const SO_REGIAO = new Set(['locality', 'administrative_area_level_1', 'administrative_area_level_2', 'country', 'political']);
const ehSoRegiao = (tipos) => Array.isArray(tipos) && tipos.length > 0 && tipos.every((t) => SO_REGIAO.has(t));

// cache curto das buscas no Google (economiza cota quando várias pessoas digitam a mesma coisa)
const buscasGoogle = new Map();
async function googleLugares(txt, cfg, centro, limite) {
  const chave = `${limite}|${cfg.cidade}|${txt.toLowerCase()}`;
  if (buscasGoogle.has(chave)) return buscasGoogle.get(chave);
  const corpo = { textQuery: `${txt}, ${cfg.cidade}`, languageCode: 'pt-BR', regionCode: 'BR', pageSize: limite };
  if (centro) corpo.locationBias = { circle: { center: { latitude: centro.lat, longitude: centro.lng }, radius: RAIO_KM * 1000 } };
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': chaveGoogle(),
      'X-Goog-FieldMask': 'places.displayName,places.location,places.addressComponents,places.types',
    },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(8000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Places respondeu ${r.status}: ${d.error?.message || ''}`.trim());
  const lugares = (d.places || [])
    .filter((x) => Number.isFinite(x.location?.latitude) && Number.isFinite(x.location?.longitude) && !ehSoRegiao(x.types))
    .map((x) => ({ lat: x.location.latitude, lng: x.location.longitude, nome: x.displayName?.text || '', ...partesGoogle(x.addressComponents) }))
    .filter((p) => perto(p, centro));
  if (buscasGoogle.size >= 500) buscasGoogle.delete(buscasGoogle.keys().next().value);
  buscasGoogle.set(chave, lugares);
  return lugares;
}

async function googleGeocode(params) {
  const q = new URLSearchParams({ ...params, language: 'pt-BR', region: 'br', key: chaveGoogle() });
  const d = await pedirJson(`https://maps.googleapis.com/maps/api/geocode/json?${q}`);
  if (d.status === 'ZERO_RESULTS') return [];
  // REQUEST_DENIED costuma ser faturamento desligado ou chave sem a Geocoding API liberada
  if (d.status !== 'OK') throw new Error(`Google Geocoding: ${d.status} ${d.error_message || ''}`.trim());
  return d.results || [];
}

async function centroDaCidade(cidade) {
  if (centros.has(cidade)) return centros.get(cidade);
  let centro = null;
  if (chaveGoogle()) {
    try {
      const [c] = await googleGeocode({ address: cidade + ', Brasil', components: 'country:BR' });
      if (c?.geometry?.location) centro = { lat: c.geometry.location.lat, lng: c.geometry.location.lng };
    } catch (e) { console.log('Centro da cidade (Google) falhou:', e.message); }
  }
  if (!centro) {
    const [c] = await pedirJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(cidade + ', Brasil')}`);
    centro = c ? { lat: Number(c.lat), lng: Number(c.lon) } : null;
  }
  if (centro) centros.set(cidade, centro);
  return centro;
}

// palavras que identificam o lugar (sem "rua", "avenida", "centro", números...)
const COMUNS = new Set(['rua', 'avenida', 'travessa', 'alameda', 'praca', 'centro', 'bairro', 'perto', 'frente', 'casa', 'numero', 'das', 'dos', 'del', 'para']);
const palavrasDe = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !COMUNS.has(w));

const perto = (p, centro) => !centro || kmLinhaReta(p, centro) <= RAIO_KM;

async function buscarEndereco(txt, cfg) {
  if (process.env.GEOCODIFICAR === 'nao') return null;
  if (!cfg.cidade) {
    console.log('Busca de endereço desligada: preencha a Cidade em Painel › Configurações.');
    return null;
  }
  const centro = await centroDaCidade(cfg.cidade).catch(() => null);
  // 0) Google, se houver chave
  if (chaveGoogle()) {
    try {
      const [achou] = await googleLugares(txt, cfg, centro, 3);
      if (achou) { console.log(`Endereço encontrado (Google): "${txt}"`); return { lat: achou.lat, lng: achou.lng }; }
    } catch (e) { console.log('Busca de endereço (Google) falhou:', e.message); }
  }
  // 1) Nominatim, procurando "texto, cidade"
  try {
    const lista = await pedirJson(`https://nominatim.openstreetmap.org/search?format=json&limit=3&countrycodes=br&q=${encodeURIComponent(`${txt}, ${cfg.cidade}, Brasil`)}`);
    const achou = lista.map((x) => ({ lat: Number(x.lat), lng: Number(x.lon) })).find((p) => perto(p, centro));
    if (achou) { console.log(`Endereço encontrado (OSM): "${txt}"`); return achou; }
  } catch (e) { console.log('Busca de endereço (Nominatim) falhou:', e.message); }
  // 2) Photon, que aceita nome escrito pela metade ou com erro, priorizando o que está perto da cidade
  try {
    const vies = centro ? `&lat=${centro.lat}&lon=${centro.lng}` : '';
    const d = await pedirJson(`https://photon.komoot.io/api/?limit=3${vies}&q=${encodeURIComponent(`${txt} ${cfg.cidade}`)}`);
    // o Photon devolve qualquer coisa parecida: só vale se o nome ou a rua tiver alguma palavra do que foi digitado
    const palavras = palavrasDe(txt);
    const achou = (d.features || [])
      .filter((f) => { const p = f.properties || {}; const tem = palavrasDe(`${p.name || ''} ${p.street || ''}`); return palavras.some((w) => tem.includes(w)); })
      .map((f) => ({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] })).find((p) => perto(p, centro));
    if (achou) { console.log(`Endereço encontrado (Photon): "${txt}"`); return achou; }
  } catch (e) { console.log('Busca de endereço (Photon) falhou:', e.message); }
  console.log(`Endereço NÃO encontrado no mapa: "${txt}" (cidade: ${cfg.cidade})`);
  return null;
}


// ---- sugestões e endereço de um ponto para o site do passageiro (Google se houver chave; senão Photon)
// Devolve no formato que o site já entende: { geometry: { coordinates: [lng, lat] }, properties: { name, context } }.
async function sugerirEnderecos(txt, cfg) {
  const centro = cfg.cidade ? await centroDaCidade(cfg.cidade).catch(() => null) : null;
  if (chaveGoogle() && cfg.cidade) {
    try {
      const lugares = await googleLugares(txt, cfg, centro, 8);
      if (lugares.length) {
        return lugares.map((p) => {
          const rua = p.rua ? p.rua + (p.numero ? ', ' + p.numero : '') : '';
          const nome = p.nome && p.nome !== p.rua && p.nome !== rua ? (rua ? `${p.nome} (${rua})` : p.nome) : (rua || p.nome);
          return { geometry: { coordinates: [p.lng, p.lat] }, properties: {
            name: nome, feature_type: 'street',
            context: { neighborhood: p.bairro ? { name: p.bairro } : undefined, place: { name: p.cidade } } } };
        });
      }
    } catch (e) { console.log('Sugestões de endereço (Google) falharam:', e.message); }
  }
  const vies = centro ? `&lat=${centro.lat}&lon=${centro.lng}` : '';
  const d = await pedirJson(`https://photon.komoot.io/api/?limit=12${vies}&q=${encodeURIComponent(`${txt} ${cfg.cidade || ''}`.trim())}`);
  const palavras = palavrasDe(txt);
  return (d.features || [])
    .filter((f) => {
      const c = f.geometry?.coordinates, p = f.properties || {};
      if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return false;
      if (!perto({ lat: c[1], lng: c[0] }, centro)) return false;
      const tem = palavrasDe(`${p.name || ''} ${p.street || ''}`);
      return !palavras.length || palavras.some((w) => tem.includes(w));
    })
    .slice(0, 8)
    .map((f) => {
      const p = f.properties || {};
      // mantém o número do imóvel: "Rua X, 123" ou "Mercado Y (Rua X, 123)"
      const rua = p.street ? p.street + (p.housenumber ? ', ' + p.housenumber : '') : '';
      const nome = p.name && p.name !== p.street ? (rua ? `${p.name} (${rua})` : p.name) : (rua || p.name);
      return { geometry: { coordinates: f.geometry.coordinates }, properties: {
        name: nome, feature_type: 'street',
        context: { neighborhood: p.district ? { name: p.district } : undefined, place: { name: p.city || '' } } } };
    });
}

async function enderecoDoPonto(p) {
  if (chaveGoogle()) {
    try {
      const resultados = await googleGeocode({ latlng: `${p.lat},${p.lng}` });
      // o primeiro resultado nem sempre traz o bairro: procura rua e bairro em todos
      const partes = resultados.map((r) => partesGoogle(r.address_components));
      const rua = partes.find((x) => x.rua)?.rua || '';
      const bairro = partes.find((x) => x.bairro)?.bairro || '';
      if (rua || bairro) return { rua, bairro };
    } catch (e) { console.log('Rua e bairro do ponto (Google) falharam:', e.message); }
  }
  const d = await pedirJson(`https://photon.komoot.io/reverse?lat=${p.lat}&lon=${p.lng}&limit=1`);
  const x = d.features?.[0]?.properties || {};
  return { rua: x.street || (x.type === 'street' ? x.name : '') || '', bairro: x.district || x.locality || '' };
}

const linkMapa = (p) => `https://maps.google.com/?q=${p.lat},${p.lng}`;

module.exports = { kmLinhaReta, kmRota, kmRuas, sugerirEnderecos, enderecoDoPonto, preco, reais, buscarEndereco, temPonto, linkMapa };
