// Distância, preço e busca de endereço digitado (Google Maps se houver GOOGLE_MAPS_KEY; senão OpenStreetMap:
// Nominatim e Photon, grátis).

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

async function centroDaCidade(cidade) {
  if (centros.has(cidade)) return centros.get(cidade);
  const [c] = await pedirJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(cidade + ', Brasil')}`);
  const centro = c ? { lat: Number(c.lat), lng: Number(c.lon) } : null;
  if (centro) centros.set(cidade, centro);
  return centro;
}

// palavras que identificam o lugar (sem "rua", "avenida", "centro", números...)
const COMUNS = new Set(['rua', 'avenida', 'travessa', 'alameda', 'praca', 'centro', 'bairro', 'perto', 'frente', 'casa', 'numero', 'das', 'dos', 'del', 'para']);
const palavrasDe = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !COMUNS.has(w));

const perto = (p, centro) => !centro || kmLinhaReta(p, centro) <= RAIO_KM;

// ---- Google Maps (opcional): só é usado se a variável GOOGLE_MAPS_KEY estiver preenchida no Easypanel.
// A chave fica só no servidor (nunca vai para as páginas) e precisa ter a Geocoding API e a Places API (New).
// Resultado que é só "a cidade" ou "o estado" não serve: o Google devolve o centro da cidade quando não acha a rua.
const GENERICOS = new Set(['country', 'administrative_area_level_1', 'administrative_area_level_2', 'locality', 'political', 'postal_code']);
const generico = (tipos = []) => tipos.length > 0 && tipos.every((t) => GENERICOS.has(t));

// endereços digitados ("Rua tal, 123"); devolve o ponto e as partes do endereço (rua, número, bairro, cidade)
async function googleEnderecos(txt, cfg, centro, chave) {
  const vies = centro ? `&bounds=${centro.lat - 0.3},${centro.lng - 0.3}|${centro.lat + 0.3},${centro.lng + 0.3}` : '';
  const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?language=pt-BR&region=br&components=country:BR${vies}` +
    `&address=${encodeURIComponent(`${txt}, ${cfg.cidade}`)}&key=${encodeURIComponent(chave)}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Google Geocoding respondeu ' + r.status);
  const d = await r.json();
  if (d.status !== 'OK' && d.status !== 'ZERO_RESULTS') throw new Error(`Google Geocoding: ${d.status} ${d.error_message || ''}`.trim());
  return (d.results || [])
    .filter((x) => !generico(x.types))
    .map((x) => {
      const parte = (...tipos) => (x.address_components || []).find((c) => tipos.some((t) => (c.types || []).includes(t)))?.long_name || '';
      return {
        lat: Number(x.geometry?.location?.lat), lng: Number(x.geometry?.location?.lng),
        rua: parte('route'), numero: parte('street_number'),
        bairro: parte('sublocality_level_1', 'sublocality', 'neighborhood'), cidade: parte('administrative_area_level_2', 'locality'),
      };
    })
    .filter((p) => temPonto(p) && perto(p, centro));
}

async function googleGeocoding(txt, cfg, centro, chave) {
  const [p] = await googleEnderecos(txt, cfg, centro, chave);
  return p ? { lat: p.lat, lng: p.lng } : null;
}

// lugares pelo nome ("Rodoviária", "Mercado X"), que a Geocoding nem sempre conhece.
// completo = também traz nome e endereço (para as sugestões do site do passageiro).
async function googleLugares(txt, cfg, centro, chave, { limite = 3, completo = false } = {}) {
  const corpo = { textQuery: `${txt}, ${cfg.cidade}`, languageCode: 'pt-BR', regionCode: 'BR', pageSize: limite };
  if (centro) corpo.locationBias = { circle: { center: { latitude: centro.lat, longitude: centro.lng }, radius: RAIO_KM * 1000 } };
  const campos = 'places.location,places.types' + (completo ? ',places.displayName,places.addressComponents' : '');
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST', signal: AbortSignal.timeout(8000), body: JSON.stringify(corpo),
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': chave, 'X-Goog-FieldMask': campos },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Places respondeu ${r.status} ${d.error?.message || ''}`.trim());
  return (d.places || [])
    .filter((x) => !generico(x.types))
    .map((x) => {
      const parte = (...tipos) => (x.addressComponents || []).find((c) => tipos.some((t) => (c.types || []).includes(t)))?.longText || '';
      return {
        lat: Number(x.location?.latitude), lng: Number(x.location?.longitude), nome: x.displayName?.text || '',
        rua: parte('route'), numero: parte('street_number'),
        bairro: parte('sublocality_level_1', 'sublocality', 'neighborhood'), cidade: parte('administrative_area_level_2', 'locality'),
      };
    })
    .filter((p) => temPonto(p) && perto(p, centro));
}

async function googleLugar(txt, cfg, centro, chave) {
  const [p] = await googleLugares(txt, cfg, centro, chave);
  return p ? { lat: p.lat, lng: p.lng } : null;
}

async function buscarNoGoogle(txt, cfg, centro) {
  const chave = (process.env.GOOGLE_MAPS_KEY || '').trim();
  if (!chave) return null;
  for (const [nome, buscar] of [['Geocoding', googleGeocoding], ['Places', googleLugar]]) {
    try {
      const achou = await buscar(txt, cfg, centro, chave);
      if (achou) { console.log(`Endereço encontrado (Google ${nome}): "${txt}"`); return achou; }
    } catch (e) { console.log(`Busca de endereço (Google ${nome}) falhou:`, e.message); }
  }
  return null;
}

async function buscarEndereco(txt, cfg) {
  if (process.env.GEOCODIFICAR === 'nao') return null;
  if (!cfg.cidade) {
    console.log('Busca de endereço desligada: preencha a Cidade em Painel › Configurações.');
    return null;
  }
  const centro = await centroDaCidade(cfg.cidade).catch(() => null);
  // 0) Google Maps, se a chave estiver configurada; se não achar ou falhar, segue para o OpenStreetMap
  const doGoogle = await buscarNoGoogle(txt, cfg, centro);
  if (doGoogle) return doGoogle;
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


// mesmo formato para o Photon e para o Google; mantém o número do imóvel: "Rua X, 123" ou "Mercado Y (Rua X, 123)"
// o OpenStreetMap às vezes põe o nome da cidade no lugar do bairro ("Bairro Miranda"): aí não mostra bairro
const semAcento = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
function sugestao(lng, lat, { nome, rua, numero, bairro, cidade }) {
  if (bairro && semAcento(bairro) === semAcento(cidade)) bairro = '';
  const ruaNum = rua ? rua + (numero ? ', ' + numero : '') : '';
  const name = nome && nome !== rua ? (ruaNum ? `${nome} (${ruaNum})` : nome) : (ruaNum || nome);
  return { geometry: { coordinates: [lng, lat] }, properties: {
    name, feature_type: 'street',
    context: { neighborhood: bairro ? { name: bairro } : undefined, place: { name: cidade || '' } } } };
}

async function sugestoesPhoton(txt, cfg, centro) {
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
      return sugestao(f.geometry.coordinates[0], f.geometry.coordinates[1],
        { nome: p.name, rua: p.street, numero: p.housenumber, bairro: p.district, cidade: p.city });
    });
}

// O Google só é chamado quando o OpenStreetMap não acha nada (ex.: "prefeitura"), e cada termo fica guardado,
// para não gastar a cota a cada letra digitada.
const sugestoesGoogleCache = new Map(); // "cidade|texto" → sugestões (guarda as últimas 300)
async function sugestoesGoogle(txt, cfg, centro) {
  const chave = (process.env.GOOGLE_MAPS_KEY || '').trim();
  if (!chave || !cfg.cidade || String(txt).trim().length < 4) return [];
  const id = `${cfg.cidade}|${String(txt).trim().toLowerCase()}`;
  if (sugestoesGoogleCache.has(id)) return sugestoesGoogleCache.get(id);
  try {
    const lista = (await googleLugares(txt, cfg, centro, chave, { limite: 5, completo: true }))
      .map((p) => sugestao(p.lng, p.lat, p));
    if (sugestoesGoogleCache.size >= 300) sugestoesGoogleCache.delete(sugestoesGoogleCache.keys().next().value);
    sugestoesGoogleCache.set(id, lista);
    if (lista.length) console.log(`Sugestões do Google para "${txt}": ${lista.length}`);
    return lista;
  } catch (e) {
    console.log('Sugestões de endereço (Google Places) falharam:', e.message);
    return [];
  }
}

// Quando o passageiro digita um número ("Rua Oriel Xavier 2"), o OpenStreetMap quase nunca tem a numeração das
// casas e devolve um ponto qualquer da rua. Aí o Google (Geocoding) acha o número; a sugestão só vale se trouxer o número.
async function sugestaoComNumero(txt, cfg, centro) {
  const chave = (process.env.GOOGLE_MAPS_KEY || '').trim();
  if (!chave || !cfg.cidade || !/\d/.test(txt)) return null;
  const id = `n|${cfg.cidade}|${String(txt).trim().toLowerCase()}`;
  if (sugestoesGoogleCache.has(id)) return sugestoesGoogleCache.get(id);
  try {
    const p = (await googleEnderecos(txt, cfg, centro, chave)).find((x) => x.rua && x.numero);
    const achou = p ? sugestao(p.lng, p.lat, p) : null;
    if (sugestoesGoogleCache.size >= 300) sugestoesGoogleCache.delete(sugestoesGoogleCache.keys().next().value);
    sugestoesGoogleCache.set(id, achou);
    if (achou) console.log(`Sugestão com número do Google para "${txt}"`);
    return achou;
  } catch (e) {
    console.log('Sugestão com número (Google Geocoding) falhou:', e.message);
    return null;
  }
}

// ---- sugestões para o site do passageiro: primeiro o Photon (grátis); se ele não achar nada, o Google (se houver chave).
// Com número digitado, a sugestão do Google com o número certo vem no topo.
// Devolve no formato que o site já entende: { geometry: { coordinates: [lng, lat] }, properties: { name, context } }.
async function sugerirEnderecos(txt, cfg) {
  const centro = cfg.cidade ? await centroDaCidade(cfg.cidade).catch(() => null) : null;
  const [comNumero, lista] = await Promise.all([
    sugestaoComNumero(txt, cfg, centro),
    sugestoesPhoton(txt, cfg, centro).catch((e) => { console.log('Sugestões de endereço (Photon) falharam:', e.message); return []; }),
  ]);
  if (comNumero) return [comNumero, ...lista.filter((f) => f.properties.name !== comNumero.properties.name)].slice(0, 8);
  return lista.length ? lista : sugestoesGoogle(txt, cfg, centro);
}

// ---- rua e bairro de um ponto marcado no mapa (site do passageiro)
// O OpenStreetMap quase não tem os bairros de cidade pequena (devolvia o nome da cidade como bairro), então,
// com GOOGLE_MAPS_KEY, pergunta primeiro à Geocoding API do Google. Cada ponto (arredondado a ~10 m) fica
// guardado, para não gastar a cota quando o passageiro arrasta o pino de volta.
const pontosGoogleCache = new Map(); // "lat,lng" → { rua, bairro } (guarda os últimos 500)
async function enderecoDoPontoGoogle(p, chave) {
  const id = `${Number(p.lat).toFixed(4)},${Number(p.lng).toFixed(4)}`;
  if (pontosGoogleCache.has(id)) return pontosGoogleCache.get(id);
  const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?language=pt-BR&region=br&latlng=${id}&key=${encodeURIComponent(chave)}`,
    { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Google Geocoding respondeu ' + r.status);
  const d = await r.json();
  if (d.status !== 'OK' && d.status !== 'ZERO_RESULTS') throw new Error(`Google Geocoding: ${d.status} ${d.error_message || ''}`.trim());
  // o primeiro resultado nem sempre traz o bairro: procura rua e bairro em todos
  const partes = (d.results || []).flatMap((x) => x.address_components || []);
  const pega = (...tipos) => partes.find((c) => tipos.some((t) => (c.types || []).includes(t)))?.long_name || '';
  const achou = { rua: pega('route'), bairro: pega('sublocality_level_1', 'sublocality', 'neighborhood') };
  if (pontosGoogleCache.size >= 500) pontosGoogleCache.delete(pontosGoogleCache.keys().next().value);
  pontosGoogleCache.set(id, achou);
  return achou;
}

async function enderecoDoPonto(p) {
  const chave = (process.env.GOOGLE_MAPS_KEY || '').trim();
  if (chave) {
    try {
      const achou = await enderecoDoPontoGoogle(p, chave);
      if (achou.rua || achou.bairro) return achou;
    } catch (e) { console.log('Rua e bairro do ponto (Google) falharam:', e.message); }
  }
  const d = await pedirJson(`https://photon.komoot.io/reverse?lat=${p.lat}&lon=${p.lng}&limit=1`);
  const x = d.features?.[0]?.properties || {};
  let bairro = x.district || x.locality || '';
  if (semAcento(bairro) === semAcento(x.city)) bairro = '';
  return { rua: x.street || (x.type === 'street' ? x.name : '') || '', bairro };
}

const linkMapa = (p) => `https://maps.google.com/?q=${p.lat},${p.lng}`;

module.exports = { kmLinhaReta, kmRota, kmRuas, sugerirEnderecos, enderecoDoPonto, preco, reais, buscarEndereco, temPonto, linkMapa };
