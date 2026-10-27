// Distância, preço e busca de endereço digitado (OpenStreetMap: Nominatim e Photon, grátis).

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

async function buscarEndereco(txt, cfg) {
  if (process.env.GEOCODIFICAR === 'nao') return null;
  if (!cfg.cidade) {
    console.log('Busca de endereço desligada: preencha a Cidade em Painel › Configurações.');
    return null;
  }
  const centro = await centroDaCidade(cfg.cidade).catch(() => null);
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

const linkMapa = (p) => `https://maps.google.com/?q=${p.lat},${p.lng}`;

module.exports = { kmLinhaReta, kmRota, preco, reais, buscarEndereco, temPonto, linkMapa };
