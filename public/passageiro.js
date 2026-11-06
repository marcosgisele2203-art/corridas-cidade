(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MIRANDA = [-20.240, -56.378];
  const origemInput = $('origem');
  const destinoInput = $('destino');
  const continuar = $('continuar');
  const mensagem = $('mensagem');
  const previa = $('previa');
  const mapaStatus = $('map-status');
  let veiculo = 'carro';
  let origemMarker = null;
  let destinoMarker = null;
  let currentLocationMarker = null;
  let routeLine = null;
  let origemPoint = null;
  let destinoPoint = null;
  let map;
  let gpsWatch = null;
  let nextMapPoint = 'origin';
  let routePreviewRequested = false;
  let routeRequestId = 0;
  let routeAbortController = null;

  const updateContinueButton = () => {
    continuar.disabled = !origemPoint || !destinoPoint;
  };

  const pointLabel = (latlng) =>
    `Ponto no mapa (${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)})`;

  const makeMarker = (latlng, label, type) => L.marker(latlng, {
    draggable: true,
    icon: L.divIcon({
      className: 'ride-marker-wrap',
      html: `<div class="ride-marker ${type}"><span>${label}</span></div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 34]
    }),
    keyboard: true,
    title: type === 'origin' ? 'Ponto de partida' : 'Destino'
  }).addTo(map);

  const clearRoute = () => {
    routeRequestId += 1;
    if (routeAbortController) routeAbortController.abort();
    routeAbortController = null;
    if (routeLine) routeLine.remove();
    routeLine = null;
    continuar.querySelector('span').textContent = 'Ver prévia da viagem';
  };

  const showPreview = (title, lines, error = false) => {
    previa.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = title;
    previa.append(heading);
    lines.forEach((text) => {
      const line = document.createElement('span');
      line.textContent = text;
      previa.append(line);
    });
    previa.classList.toggle('has-error', error);
    previa.hidden = false;
  };

  const loadTariffs = async () => {
    const response = await fetch('/api/publico/tarifas', { cache: 'no-store' });
    if (!response.ok) throw new Error('Tarifas da central indisponíveis.');
    const tariffs = await response.json();
    if (!tariffs || typeof tariffs !== 'object' || Array.isArray(tariffs)) {
      throw new Error('Não foi possível ler as tarifas da central.');
    }
    return tariffs;
  };

  const fareFor = (km, tariff) => {
    if (!tariff || !['taxa_base', 'por_km', 'minimo'].every((key) =>
      Number.isFinite(tariff[key]) && tariff[key] >= 0)) return null;
    return Math.ceil(Math.max(Number(tariff.minimo), Number(tariff.taxa_base) + km * Number(tariff.por_km)) * 2) / 2;
  };

  const routePreview = async () => {
    if (!origemPoint || !destinoPoint || !map) {
      mensagem.textContent = 'Marque a origem A e o destino B no mapa para calcular a rota.';
      return;
    }

    clearRoute();
    const requestId = routeRequestId;
    routeAbortController = new AbortController();
    previa.hidden = true;
    mensagem.textContent = '';
    continuar.disabled = true;
    continuar.querySelector('span').textContent = 'Calculando rota…';
    mapaStatus.textContent = 'Calculando trajeto pelas ruas…';

    const coordinates = `${origemPoint.lng},${origemPoint.lat};${destinoPoint.lng},${destinoPoint.lat}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`;
    try {
      const [routeResponse, tariffsResult] = await Promise.allSettled([
        fetch(url, { signal: routeAbortController.signal }),
        loadTariffs()
      ]);
      if (requestId !== routeRequestId) return;
      if (routeResponse.status !== 'fulfilled') throw routeResponse.reason;
      if (!routeResponse.value.ok) throw new Error(`Serviço de rotas indisponível (HTTP ${routeResponse.value.status}).`);
      const routeData = await routeResponse.value.json();
      if (requestId !== routeRequestId) return;
      const route = routeData.routes?.[0];
      const coordinatesList = route?.geometry?.coordinates;
      if (routeData.code !== 'Ok' || !route || !Number.isFinite(route.distance) || !Number.isFinite(route.duration) ||
          !Array.isArray(coordinatesList) || coordinatesList.length < 2 ||
          coordinatesList.some((point) => !Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) {
        throw new Error('Não foi encontrada uma rota pelas ruas entre esses pontos.');
      }

      routeLine = L.geoJSON(route.geometry, {
        style: { color: '#07875b', weight: 6, opacity: 0.88, lineCap: 'round', lineJoin: 'round' }
      }).addTo(map);
      map.fitBounds(routeLine.getBounds(), { padding: [70, 70], maxZoom: 16 });

      const km = route.distance / 1000;
      const distance = `${km.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
      const minutes = Math.max(1, Math.round(route.duration / 60));
      const time = `${minutes} min (estimativa)`;
      const tariffs = tariffsResult.status === 'fulfilled' ? tariffsResult.value : null;
      const fare = fareFor(km, tariffs?.[veiculo]);
      const fareText = fare === null
        ? (tariffs && !tariffs[veiculo]
          ? 'Tarifa deste veículo não está disponível na central.'
          : 'Valor indisponível: não foi possível carregar a tarifa atual.')
        : `Valor estimado: R$ ${fare.toFixed(2).replace('.', ',')}`;
      showPreview(`Prévia da viagem · ${veiculo === 'carro' ? 'Carro' : 'Moto'}`, [
        `Distância pelas ruas: ${distance}`,
        `Tempo estimado: ${time}`,
        fareText,
        'Estimativa, não é uma corrida. Nenhuma corrida foi enviada.'
      ], fare === null);
      mapaStatus.textContent = 'Rota pelas ruas exibida · arraste A ou B para alterar';
    } catch (error) {
      if (requestId !== routeRequestId || error.name === 'AbortError') return;
      showPreview('Prévia indisponível', [
        error.message || 'Não foi possível calcular a rota. Tente novamente.',
        'Nenhuma corrida foi enviada.'
      ], true);
      mapaStatus.textContent = 'Não foi possível calcular a rota';
    } finally {
      if (requestId === routeRequestId) {
        routeAbortController = null;
        updateContinueButton();
        continuar.querySelector('span').textContent = 'Ver prévia da viagem';
      }
    }
  };

  const setPoint = (kind, latlng) => {
    const isOrigin = kind === 'origin';
    const input = isOrigin ? origemInput : destinoInput;
    const oldMarker = isOrigin ? origemMarker : destinoMarker;
    if (oldMarker) oldMarker.remove();

    const marker = makeMarker(latlng, isOrigin ? 'A' : 'B', isOrigin ? 'origin' : 'destination');
    marker.on('dragend', (event) => {
      setPoint(kind, event.target.getLatLng());
    });
    if (isOrigin) origemMarker = marker;
    else destinoMarker = marker;
    if (isOrigin) origemPoint = latlng;
    else destinoPoint = latlng;
    input.value = pointLabel(latlng);
    updateContinueButton();
    mensagem.textContent = '';
    clearRoute();
    previa.hidden = true;
    nextMapPoint = 'destination';
    mapaStatus.textContent = origemPoint && destinoPoint
      ? 'A e B definidos · arraste os marcadores ou toque para ajustar B'
      : isOrigin
        ? 'Origem A marcada · toque para escolher o destino B'
        : 'Destino B marcado · toque novamente para ajustar o destino';

    if (origemMarker && destinoMarker) {
      map.fitBounds(L.latLngBounds(origemMarker.getLatLng(), destinoMarker.getLatLng()), { padding: [70, 70], maxZoom: 15 });
    }
    if (routePreviewRequested && origemPoint && destinoPoint) routePreview();
  };

  const mapClick = (event) => {
    setPoint(nextMapPoint, event.latlng);
  };

  if (!window.L) {
    mapaStatus.textContent = 'O mapa não carregou. Verifique sua conexão e atualize a página.';
    $('mapa').setAttribute('aria-label', 'Mapa indisponível');
  } else {
    map = L.map('mapa', { zoomControl: false, scrollWheelZoom: false }).setView(MIRANDA, 14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
    map.on('click', mapClick);
  }

  document.querySelectorAll('[data-vehicle]').forEach((button) => {
    button.addEventListener('click', () => {
      veiculo = button.dataset.vehicle;
      document.querySelectorAll('[data-vehicle]').forEach((option) => {
        const selected = option === button;
        option.classList.toggle('is-selected', selected);
        option.setAttribute('aria-pressed', String(selected));
      });
      if (routePreviewRequested && origemPoint && destinoPoint) routePreview();
      else previa.hidden = true;
    });
  });

  [origemInput, destinoInput].forEach((input) => {
    input.addEventListener('input', () => {
      const isOrigin = input === origemInput;
      const marker = isOrigin ? origemMarker : destinoMarker;
      if (marker) marker.remove();
      if (isOrigin) origemMarker = null;
      else destinoMarker = null;
      if (isOrigin) origemPoint = null;
      else destinoPoint = null;
      clearRoute();
      nextMapPoint = isOrigin ? 'origin' : 'destination';
      mensagem.textContent = '';
      previa.hidden = true;
      updateContinueButton();
      mapaStatus.textContent = isOrigin
        ? 'Toque no mapa para marcar a origem A'
        : 'Toque no mapa para marcar o destino B';
    });
  });

  $('usar-gps').addEventListener('click', () => {
    mensagem.textContent = '';
    if (!map) {
      mensagem.textContent = 'O mapa está indisponível. Atualize a página e tente novamente.';
      return;
    }
    if (!navigator.geolocation) {
      mensagem.textContent = 'Este navegador não oferece acesso ao GPS.';
      return;
    }
    if (!window.isSecureContext) {
      mensagem.textContent = 'Para usar o GPS, abra esta página em uma conexão segura (HTTPS).';
      return;
    }
    if (gpsWatch !== null) navigator.geolocation.clearWatch(gpsWatch);
    mensagem.textContent = 'Aguardando sua permissão para acessar a localização…';
    gpsWatch = navigator.geolocation.watchPosition((position) => {
      const { latitude, longitude, accuracy } = position.coords;
      const point = L.latLng(latitude, longitude);
      if (destinoMarker) destinoMarker.remove();
      destinoMarker = null;
      destinoPoint = null;
      destinoInput.value = '';
      nextMapPoint = 'destination';
      setPoint('origin', point);
      origemInput.value = 'Minha localização atual';
      mensagem.textContent = `Localização encontrada${Number.isFinite(accuracy) ? ` · precisão aproximada de ${Math.round(accuracy)} m` : ''}.`;
      previa.hidden = true;
      if (currentLocationMarker) currentLocationMarker.remove();
      currentLocationMarker = L.circleMarker(point, {
        radius: 7, color: '#fff', weight: 3, fillColor: '#4388db', fillOpacity: 1
      }).addTo(map);
      map.setView(point, 15);
      mapaStatus.textContent = 'Origem A definida pelo GPS · toque para escolher o destino B';
      if (gpsWatch !== null) {
        navigator.geolocation.clearWatch(gpsWatch);
        gpsWatch = null;
      }
    }, (error) => {
      const errors = {
        1: 'Permissão de localização não concedida.',
        2: 'Não foi possível determinar sua localização.',
        3: 'A solicitação de localização expirou. Tente novamente.'
      };
      mensagem.textContent = errors[error.code] || 'Não foi possível acessar sua localização.';
      if (gpsWatch !== null) navigator.geolocation.clearWatch(gpsWatch);
      gpsWatch = null;
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  });

  $('centralizar').addEventListener('click', () => {
    if (map) map.setView(MIRANDA, 14);
  });

  continuar.addEventListener('click', () => {
    routePreviewRequested = true;
    routePreview();
  });

  window.addEventListener('pagehide', () => {
    if (gpsWatch !== null && navigator.geolocation) navigator.geolocation.clearWatch(gpsWatch);
  });
})();
