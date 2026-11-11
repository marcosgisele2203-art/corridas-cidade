// Aba Bairros do painel: o administrador desenha o contorno de cada bairro no mapa (Leaflet + OpenStreetMap, sem chave).
// Usa api() e esc() do painel.js.
(function () {
  const area = document.getElementById('mapaBairros');
  if (!area || !window.L) return;
  const $id = (id) => document.getElementById(id);
  const CORES = ['#0a9d48', '#e5197a', '#1e6fd9', '#b7791f', '#7b3fc4', '#c62828', '#0e8a8a', '#d35400'];

  let mapa = null, camada = null, lista = [];
  // desenho em andamento: null ou { id (null = novo), pontos: [[lat, lng]], marcadores: [], forma }
  let desenho = null;

  function iniciarMapa() {
    if (mapa) return;
    mapa = L.map(area).setView([-20.24, -56.38], 14); // Miranda-MS até existir algum bairro
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(mapa);
    camada = L.layerGroup().addTo(mapa);
    mapa.on('click', (e) => { if (desenho) adicionarPonto([e.latlng.lat, e.latlng.lng]); });
  }

  // ---- bairros já cadastrados
  async function carregar() {
    iniciarMapa();
    setTimeout(() => mapa.invalidateSize(), 50);
    try { lista = await api('GET', '/api/bairros'); }
    catch (e) { $id('statusBairros').textContent = 'Não foi possível carregar os bairros: ' + e.message; return; }
    desenharCadastrados();
    mostrarLista();
  }
  window.carregarBairros = carregar;

  function desenharCadastrados() {
    camada.clearLayers();
    lista.forEach((b, i) => {
      if (desenho && desenho.id === b.id) return; // o que está sendo editado aparece como desenho
      const cor = CORES[i % CORES.length];
      L.polygon(b.contorno, { color: cor, weight: 2, fillOpacity: 0.18, interactive: !desenho })
        .bindTooltip(esc(b.nome), { permanent: true, direction: 'center', className: 'rotulo-bairro' })
        .addTo(camada);
    });
    if (lista.length && !desenho) mapa.fitBounds(L.featureGroup(camada.getLayers()).getBounds(), { padding: [20, 20], maxZoom: 16 });
    $id('statusBairros').textContent = lista.length
      ? `${lista.length} bairro(s) cadastrado(s). Pontos fora de todos eles usam o bairro do mapa, quando existir.`
      : 'Nenhum bairro cadastrado ainda. Clique em "+ Desenhar bairro" para começar.';
  }

  function mostrarLista() {
    const el = $id('listaBairros');
    if (!lista.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="cartao"><h3>Bairros cadastrados</h3>` + lista.map((b) => `
      <div class="linha" style="border-top:1px solid var(--borda);padding-top:10px">
        <b>${esc(b.nome)}</b>
        <span>
          <button type="button" class="sec mini" data-editar="${b.id}">✏️ Editar</button>
          <button type="button" class="perigo mini" data-excluir="${b.id}">🗑️ Excluir</button>
        </span>
      </div>`).join('') + '</div>';
  }

  $id('listaBairros').addEventListener('click', async (e) => {
    const editar = e.target.closest('[data-editar]'), excluir = e.target.closest('[data-excluir]');
    if (editar) {
      const b = lista.find((x) => x.id === Number(editar.dataset.editar));
      if (b) comecar(b);
    }
    if (excluir) {
      const b = lista.find((x) => x.id === Number(excluir.dataset.excluir));
      if (!b || !confirm(`Excluir o bairro "${b.nome}"?`)) return;
      try { await api('DELETE', '/api/bairros/' + b.id); await carregar(); }
      catch (err) { alert(err.message); }
    }
  });

  // ---- desenho (novo bairro ou edição de um existente)
  function comecar(bairro) {
    if (desenho) parar();
    desenho = { id: bairro ? bairro.id : null, pontos: [], marcadores: [], forma: null };
    $id('nomeBairro').value = bairro ? bairro.nome : '';
    $id('erroBairro').textContent = '';
    $id('desenhoBairro').hidden = false;
    $id('novoBairro').hidden = true;
    area.style.cursor = 'crosshair';
    desenharCadastrados();
    (bairro ? bairro.contorno : []).forEach((p) => adicionarPonto(p));
    if (bairro) mapa.fitBounds(L.polygon(bairro.contorno).getBounds(), { padding: [40, 40], maxZoom: 17 });
    $id('nomeBairro').focus();
    window.scrollTo({ top: $id('desenhoBairro').getBoundingClientRect().top + window.scrollY - 90, behavior: 'smooth' });
  }

  function parar() {
    if (!desenho) return;
    desenho.marcadores.forEach((m) => mapa.removeLayer(m));
    if (desenho.forma) mapa.removeLayer(desenho.forma);
    desenho = null;
    $id('desenhoBairro').hidden = true;
    $id('novoBairro').hidden = false;
    area.style.cursor = '';
    desenharCadastrados();
  }

  const PINO = L.divIcon({ className: '', iconSize: [16, 16], iconAnchor: [8, 8],
    html: '<div style="width:16px;height:16px;border-radius:50%;background:#fff;border:3px solid #e5197a;box-sizing:border-box"></div>' });

  function adicionarPonto(p) {
    const m = L.marker(p, { icon: PINO, draggable: true }).addTo(mapa);
    // arrastar um canto ajusta o contorno
    m.on('drag', () => { const i = desenho.marcadores.indexOf(m); const ll = m.getLatLng(); desenho.pontos[i] = [ll.lat, ll.lng]; redesenhar(); });
    desenho.pontos.push([p[0], p[1]]);
    desenho.marcadores.push(m);
    redesenhar();
  }

  function redesenhar() {
    if (desenho.forma) mapa.removeLayer(desenho.forma);
    const n = desenho.pontos.length;
    desenho.forma = n >= 3 ? L.polygon(desenho.pontos, { color: '#e5197a', weight: 3, fillOpacity: 0.25, interactive: false }).addTo(mapa)
      : n === 2 ? L.polyline(desenho.pontos, { color: '#e5197a', weight: 3, interactive: false }).addTo(mapa) : null;
    $id('dicaDesenho').textContent = n < 3
      ? `Toque no mapa, em volta do bairro, para marcar os cantos (${n} de pelo menos 3).`
      : `${n} pontos marcados. Pode arrastar os pontos para ajustar. Quando estiver bom, clique em "Salvar bairro".`;
  }

  $id('novoBairro').onclick = () => comecar(null);
  $id('cancelarBairro').onclick = parar;
  $id('desfazerPonto').onclick = () => {
    if (!desenho || !desenho.pontos.length) return;
    mapa.removeLayer(desenho.marcadores.pop());
    desenho.pontos.pop();
    redesenhar();
  };
  $id('salvarBairro').onclick = async () => {
    if (!desenho) return;
    const corpo = { nome: $id('nomeBairro').value, contorno: desenho.pontos };
    try {
      if (desenho.id) await api('PUT', '/api/bairros/' + desenho.id, corpo);
      else await api('POST', '/api/bairros', corpo);
      parar();
      await carregar();
    } catch (e) { $id('erroBairro').textContent = e.message; }
  };
})();
