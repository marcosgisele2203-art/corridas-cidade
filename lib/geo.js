// Distância, preço e busca de endereço digitado (OpenStreetMap / Nominatim, grátis).

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
function preco(km, cfg) {
  if (km == null) return null;
  const v = Math.max(Number(cfg.minimo), Number(cfg.taxa_base) + km * Number(cfg.por_km));
  return Math.ceil(v * 2) / 2;
}

const reais = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');

// "Rodoviária" → coordenadas, procurando dentro da cidade configurada
async function buscarEndereco(txt, cfg) {
  if (!cfg.cidade || process.env.GEOCODIFICAR === 'nao') return null;
  try {
    const q = encodeURIComponent(`${txt}, ${cfg.cidade}, Brasil`);
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=${q}`, {
      headers: { 'User-Agent': 'corridas-cidade/1.0 (central de corridas)' }, signal: AbortSignal.timeout(8000),
    });
    const [achou] = await r.json();
    return achou ? { lat: Number(achou.lat), lng: Number(achou.lon) } : null;
  } catch { return null; }
}

const linkMapa = (p) => `https://maps.google.com/?q=${p.lat},${p.lng}`;

module.exports = { kmLinhaReta, kmRota, preco, reais, buscarEndereco, temPonto, linkMapa };
