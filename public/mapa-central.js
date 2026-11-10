// Mapa dos motoristas na aba Motoristas do painel (Leaflet + OpenStreetMap, sem chave).
// Usa /api/central/gps, que só devolve motoristas online com posição dos últimos 2 minutos.
(function () {
  const area = document.getElementById('centralMapa');
  const status = document.getElementById('centralMapaStatus');
  if (!area || !window.L) return;
  const ICONE = { moto: '🏍️', carro: '🚗', van: '🚐', caminhao: '🚚' };
  let mapa = null, primeira = true;
  const pinos = new Map();
  const texto = (v) => String(v ?? '');

  async function atualizar() {
    if (area.closest('section').hidden || document.hidden) return;
    if (!mapa) {
      mapa = L.map(area, { scrollWheelZoom: false }).setView([-20.24, -56.38], 13); // Miranda-MS até chegar o 1º motorista
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(mapa);
    }
    mapa.invalidateSize();
    try {
      const r = await fetch('/api/central/gps', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error();
      const { motoristas } = await r.json();
      const vistos = new Set();
      for (const m of motoristas) {
        const pos = [Number(m.lat), Number(m.lng)];
        if (!pos.every(Number.isFinite)) continue;
        vistos.add(m.id);
        const rotulo = `${ICONE[m.tipo] || '🚗'} ${texto(m.nome)} · ${texto(m.carro)} ${texto(m.placa)}` + (m.corrida_atual ? ` · corrida #${m.corrida_atual}` : ' · livre');
        if (pinos.has(m.id)) pinos.get(m.id).setLatLng(pos).setPopupContent(rotulo);
        else pinos.set(m.id, L.marker(pos, { title: texto(m.nome) }).addTo(mapa).bindPopup(rotulo));
      }
      for (const [id, p] of pinos) if (!vistos.has(id)) { mapa.removeLayer(p); pinos.delete(id); }
      if (primeira && pinos.size) { mapa.fitBounds(L.featureGroup([...pinos.values()]).getBounds(), { padding: [30, 30], maxZoom: 15 }); primeira = false; }
      status.textContent = pinos.size ? `${pinos.size} motorista(s) com GPS ligado` : 'Nenhum motorista com GPS ligado agora';
    } catch { status.textContent = 'Não foi possível carregar o GPS.'; }
  }
  setInterval(atualizar, 15000);
  // abre a aba Motoristas pelo menu de cima ou pelo cartão da tela "Escolha sua área"
  document.addEventListener('click', (e) => { if (e.target.closest('[data-aba="motoristas"], [data-ir="motoristas"]')) setTimeout(atualizar, 300); });
  document.addEventListener('visibilitychange', atualizar);
})();
