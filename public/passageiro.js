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
  // estado do pedido pelo site; versaoPedido muda a cada alteração da viagem e invalida a cotação anterior
  const pedido = $('pedido');
  let telefone = null, cotacao = null, acompanhando = null, versaoPedido = 0;
  const dropoffFields = ['bairro', 'referencia'].map(name => $('desembarque-' + name));
  const dropoffValues = () => dropoffFields.map(input => input.value.trim());
  const hasDropoffDetails = () => dropoffValues().some(Boolean);
  const dropoffLines = () => {
    const labels = ['Bairro do destino', 'Referência do destino'];
    return dropoffValues().flatMap((value, index) => value ? [labels[index] + ': ' + value] : []);
  };
  const updateDropoffMarker = () => {
    if (!destinoMarker) return;
    const content = document.createElement('div');
    content.textContent = ['Desembarque B', ...dropoffLines(), 'Destino marcado no mapa'].join(' · ');
    destinoMarker.bindPopup(content);
  };

  const paymentInputs = [...document.querySelectorAll('input[name="pagamento"]')];
  const paymentLabel = () => ({ dinheiro: 'Dinheiro', cartao: 'Cartão', pix: 'Pix' })[paymentInputs.find(input => input.checked)?.value] || '';
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
  const addressRequests = { origin: 0, destination: 0 };
  const addressControllers = { origin: null, destination: null };
  const addressNotice = $('endereco-status');
  const suggestionLists = { origin: $('sugestoes-origem'), destination: $('sugestoes-destino') };
  const suggestionTimers = { origin: null, destination: null };
  const suggestionControllers = { origin: null, destination: null };
  const suggestionRequests = { origin: 0, destination: 0 };
  const addressHint = (message) => { if (addressNotice) addressNotice.textContent = message; };
  const reverseAddress = async (kind, point) => {
    const input = kind === 'origin' ? origemInput : destinoInput;
    const request = ++addressRequests[kind];
    if (addressControllers[kind]) addressControllers[kind].abort();
    addressControllers[kind] = null;
    const controller = new AbortController();
    addressControllers[kind] = controller;
    input.value = 'Identificando rua e bairro…';
    addressHint('Consultando o endereço aproximado…');
    try {
      const params = new URLSearchParams({ lat: String(point.lat), lng: String(point.lng) });
      const response = await fetch('/api/publico/endereco-do-ponto?' + params, { signal: controller.signal });
      if (!response.ok) throw new Error('Serviço de endereços indisponível (HTTP ' + response.status + ').');
      const data = await response.json();
      if (request !== addressRequests[kind]) return;
      const road = String(data.rua || '').trim(), district = String(data.bairro || '').trim();
      if (!road && !district) {
        input.value = pointLabel(point);
        addressHint('Rua e bairro não encontrados neste ponto. Arraste o marcador ou confira o endereço.');
        return;
      }
      input.value = [
        road || 'Rua não identificada',
        district ? 'Bairro ' + district : 'Bairro não identificado'
      ].join(' · ');
      addressHint('Endereço aproximado: confira rua e bairro antes de solicitar a corrida.');
    } catch (error) {
      if (request !== addressRequests[kind] || error.name === 'AbortError') return;
      input.value = pointLabel(point);
      addressHint('Não foi possível identificar a rua e o bairro. Verifique a conexão.');
    } finally {
      if (addressControllers[kind] === controller) addressControllers[kind] = null;
    }
  };
  const closeSuggestions = (kind) => {
    const list = suggestionLists[kind];
    if (!list) return;
    list.replaceChildren();
    list.hidden = true;
  };
  const cancelSuggestions = (kind) => {
    suggestionRequests[kind]++;
    clearTimeout(suggestionTimers[kind]);
    if (suggestionControllers[kind]) suggestionControllers[kind].abort();
    suggestionControllers[kind] = null;
    closeSuggestions(kind);
  };
  const placeLabel = (feature) => {
    const properties = feature.properties || {};
    const ctx = properties.context || {};
    const street = properties.feature_type === 'street' ? properties.name :
      ctx.street?.name || properties.name || '';
    const neighborhood = ctx.neighborhood?.name ||
      (properties.feature_type === 'neighborhood' ? properties.name : '');
    const city = ctx.place?.name || '';
    const segments = [street, neighborhood && !String(street).includes(neighborhood) ? 'Bairro ' + neighborhood : '', city];
    return segments.filter(Boolean).join(' · ') || properties.full_address || '';
  };
  const suggestAddresses = (kind, text) => {
    cancelSuggestions(kind);
    const term = String(text).trim();
    if (term.length < 3) return;
    const list = suggestionLists[kind];
    const request = suggestionRequests[kind];
    if (list) {
      list.replaceChildren();
      list.hidden = false;
      const loading = document.createElement('div');
      loading.className = 'address-option address-option-info';
      loading.textContent = 'Buscando endereços de Miranda…';
      list.append(loading);
    }
    suggestionTimers[kind] = setTimeout(async () => {
      const controller = new AbortController();
      suggestionControllers[kind] = controller;
      // A busca roda no servidor (Photon/OpenStreetMap perto da cidade da central), sem chave.
      const search = async (query) => {
        const response = await fetch('/api/publico/enderecos?' + new URLSearchParams({ q: query }), {
          signal: controller.signal
        });
        if (!response.ok) throw new Error('Busca indisponível (HTTP ' + response.status + ').');
        const data = await response.json();
        return Array.isArray(data.features) ? data.features : [];
      };
      try {
        let results = await search(term);
        if (request !== suggestionRequests[kind]) return;
        // Os nomes das ruas no mapa OSM nem sempre aparecem nos índices de geocodificação.
        // Consulta pontual aos nomes cadastrados perto de Miranda, somente após as duas buscas falharem.
        if (!results.length && term.length >= 5) {
          const simplified = term.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/^(rua|avenida|av[.]?|travessa)\s+/i, '')
            .trim().replace(/[^a-zA-Z0-9À-ÿ -]/g, '');
          // Limita o termo usado na expressão de pesquisa a letras, números e espaços.
          const keyword = simplified.split(/\s+/).filter((w) => w.length >= 4).slice(-1)[0];
          if (keyword) {
            const overpassQuery = '[out:json][timeout:10];' +
              'way["highway"]["name"~"' + keyword + '",i]' +
              '(-20.31,-56.45,-20.17,-56.29);out geom 20;';
            const fallbackController = new AbortController();
            const onAbort = () => fallbackController.abort();
            controller.signal.addEventListener('abort', onAbort, { once: true });
            const fallbackTimer = setTimeout(() => fallbackController.abort(), 11000);
            try {
              const response = await fetch('https://overpass.kumi.systems/api/interpreter', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ data: overpassQuery }),
                signal: fallbackController.signal
              });
              if (response.ok) {
                const data = await response.json();
                const clean = (value) => String(value || '').normalize('NFD')
                  .replace(/[\u0300-\u036f]/g, '').toLowerCase();
                const fragment = clean(simplified);
                results = (Array.isArray(data.elements) ? data.elements : [])
                  .filter((way) => {
                    const name = way.tags?.name;
                    const geometry = way.geometry;
                    return name && clean(name).includes(fragment) &&
                      Array.isArray(geometry) && geometry.length > 0;
                  })
                  .slice(0, 8)
                  .map((way) => {
                    const point = way.geometry[Math.floor(way.geometry.length / 2)];
                    return {
                      geometry: { coordinates: [point.lon, point.lat] },
                      properties: {
                        name: way.tags.name, feature_type: 'street',
                        context: { place: { name: 'Miranda' } }
                      }
                    };
                  });
              }
            } catch (error) {
              if (controller.signal.aborted) throw error;
              // Sem bloquear a escolha manual pelo mapa.
            } finally {
              clearTimeout(fallbackTimer);
              controller.signal.removeEventListener('abort', onAbort);
            }
          }
        }
        if (request !== suggestionRequests[kind] || !list) return;
        list.replaceChildren();
        const used = new Set();
        results.forEach((feature) => {
          const coords = feature.geometry.coordinates;
          const label = placeLabel(feature);
          if (!label || used.has(label)) return;
          used.add(label);
          const option = document.createElement('button');
          option.type = 'button';
          option.className = 'address-option';
          option.setAttribute('role', 'option');
          option.textContent = label;
          option.addEventListener('click', () => {
            cancelSuggestions(kind);
            if (map) {
              setPoint(kind, L.latLng(coords[1], coords[0]), label);
              map.setView([coords[1], coords[0]], 16);
              if (origemPoint && destinoPoint) {
                map.fitBounds(L.latLngBounds(origemPoint, destinoPoint), {
                  padding: [70, 70], maxZoom: 16
                });
              }
            }
          });
          list.append(option);
        });
        if (!list.childElementCount) {
          const empty = document.createElement('div');
          empty.className = 'address-option address-option-info';
          empty.textContent = 'Não encontrei essa rua em Miranda. Você pode marcar o destino no mapa.';
          list.append(empty);
          addressHint('Nenhuma sugestão confirmada. Confira o nome ou marque o ponto no mapa.');
        } else {
          addressHint('Selecione uma sugestão abaixo do campo.');
        }
        list.hidden = false;
      } catch (error) {
        if (request !== suggestionRequests[kind] || error.name === 'AbortError') return;
        if (list) {
          list.replaceChildren();
          const notice = document.createElement('div');
          notice.className = 'address-option address-option-info';
          notice.textContent = 'Não foi possível consultar os endereços agora.';
          list.append(notice);
          list.hidden = false;
        }
        addressHint('Falha na busca. Tente novamente ou selecione o ponto no mapa.');
      } finally {
        if (suggestionControllers[kind] === controller) suggestionControllers[kind] = null;
      }
    }, 350);
  };
  const updateContinueButton = () => {
    continuar.disabled = !origemPoint || !destinoPoint || !paymentLabel();
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
    // mudou endereço, ponto, veículo ou pagamento: a cotação antiga não vale mais
    versaoPedido += 1;
    cotacao = null;
    if (!acompanhando && pedido) { pedido.hidden = true; pedido.replaceChildren(); }
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

  // o valor vem da central (mesma conta do WhatsApp), não é calculado aqui no celular
  const loadEstimate = async (signal) => {
    const response = await fetch('/api/publico/estimativa', {
      method: 'POST', cache: 'no-store', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: veiculo, origemPonto: { lat: origemPoint.lat, lng: origemPoint.lng }, destinoPonto: { lat: destinoPoint.lat, lng: destinoPoint.lng } })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !Number.isFinite(data.valor)) throw new Error(data.erro || 'Valor indisponível agora.');
    return data;
  };

  const routePreview = async () => {

    if (!paymentLabel()) {
      mensagem.textContent = 'Escolha Dinheiro, Cartão ou Pix antes de ver a prévia.';
      return;
    }
    if (!origemPoint || !destinoPoint || !map) {
      mensagem.textContent = 'Marque a origem A e o destino B no mapa para calcular a rota.';
      return;
    }

    clearRoute();
    const requestId = routeRequestId;
    routeAbortController = new AbortController();
    const controller = routeAbortController;
    previa.hidden = true;
    mensagem.textContent = '';
    continuar.disabled = true;
    continuar.querySelector('span').textContent = 'Calculando rota…';
    mapaStatus.textContent = 'Calculando trajeto pelas ruas…';
    showPreview('Calculando sua prévia', [
      'Consultando a rota entre os pontos A e B. Isso pode levar alguns segundos.',
      'Nenhuma corrida foi enviada.'
    ]);
    // A prévia fica abaixo do botão: apresente feedback visível logo após o clique.
    previa.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    const coordinates = `${origemPoint.lng},${origemPoint.lat};${destinoPoint.lng},${destinoPoint.lat}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`;
    // Evita ficar indefinidamente sem resposta quando a rede bloqueia o roteador.
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const [routeResponse, estimateResult] = await Promise.allSettled([
        fetch(url, { signal: controller.signal }),
        loadEstimate(controller.signal)
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
      const fare = estimateResult.status === 'fulfilled' ? estimateResult.value.valor : null;
      const fareText = fare === null
        ? 'Valor indisponível agora: ' + (estimateResult.reason?.message || 'tente de novo.')
        : `Valor da central: R$ ${fare.toFixed(2).replace('.', ',')}`;
      showPreview(`Prévia da viagem · ${veiculo === 'carro' ? 'Carro' : 'Moto'}`, [
        `Distância pelas ruas: ${estimateResult.status === 'fulfilled' && Number.isFinite(estimateResult.value.km) ? estimateResult.value.km.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' km' : distance}`,
        `Tempo estimado: ${time}`,
        fareText,
        `Partida: ${origemInput.value}`,
        `Destino: ${destinoInput.value}`,
        `Forma de pagamento: ${paymentLabel()}`,
        ...dropoffLines(),
        'Estimativa. A corrida só é pedida no botão abaixo.'
      ], fare === null);
      mapaStatus.textContent = 'Rota pelas ruas exibida · arraste A ou B para alterar';
      prepararPedido();
    } catch (error) {
      if (requestId !== routeRequestId) return;
      const timeoutError = error.name === 'AbortError';
      const details = timeoutError
        ? 'O serviço de rotas não respondeu a tempo. Verifique sua internet e tente novamente.'
        : error instanceof TypeError
          ? 'Não foi possível conectar ao serviço de rotas. A rede pode estar bloqueando o acesso.'
          : error.message || 'Não foi possível calcular a rota. Tente novamente.';
      showPreview('Rota indisponível', [
        details,
        'O trajeto, o tempo e o preço não foram estimados. Nenhuma corrida foi enviada.'
      ], true);
      mapaStatus.textContent = 'Rota indisponível · confira o aviso na prévia';
      previa.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } finally {
      clearTimeout(timeout);
      if (requestId === routeRequestId) {
        if (routeAbortController === controller) routeAbortController = null;
        updateContinueButton();
        continuar.querySelector('span').textContent = 'Ver prévia da viagem';
      }
    }
  };

  const setPoint = (kind, latlng, selectedAddress = null) => {
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
    else {
      destinoPoint = latlng;
      updateDropoffMarker();
    }
    input.value = selectedAddress || pointLabel(latlng);
    cancelSuggestions(kind);
    if (selectedAddress) {
      addressRequests[kind]++;
      if (addressControllers[kind]) addressControllers[kind].abort();
      addressHint('Endereço selecionado na busca. Confira o ponto marcado no mapa.');
    } else {
      reverseAddress(kind, latlng);
    }
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

  document.addEventListener('vehicle-selected', (event) => {
    if (!['carro', 'moto'].includes(event.detail)) return;
    if (veiculo === event.detail) return;
    veiculo = event.detail;
    clearRoute();
    routePreviewRequested = false;
    previa.hidden = true;
    updateContinueButton();
  });

  const dropoffChanged = () => {
    clearRoute();
    routePreviewRequested = false;
    previa.hidden = true;
    updateDropoffMarker();
    updateContinueButton();
  };
  dropoffFields.forEach(input => input.addEventListener('input', dropoffChanged));

  paymentInputs.forEach(input => input.addEventListener('change', () => {
    clearRoute();
    routePreviewRequested = false;
    mensagem.textContent = '';
    previa.hidden = true;
    updateContinueButton();
  }));

  [origemInput, destinoInput].forEach((input) => {
    input.addEventListener('input', () => {
      const isOrigin = input === origemInput;
      const marker = isOrigin ? origemMarker : destinoMarker;
      if (marker) marker.remove();
      if (isOrigin) origemMarker = null;
      else destinoMarker = null;
      if (isOrigin) origemPoint = null;
      else {
        destinoPoint = null;
      }
      const kind = isOrigin ? 'origin' : 'destination';
      addressRequests[kind]++;
      if (addressControllers[kind]) addressControllers[kind].abort();
      clearRoute();
      nextMapPoint = isOrigin ? 'origin' : 'destination';
      mensagem.textContent = '';
      previa.hidden = true;
      updateContinueButton();
      mapaStatus.textContent = isOrigin
        ? 'Toque no mapa para marcar a origem A'
        : 'Toque no mapa para marcar o destino B';
      suggestAddresses(kind, input.value);
    });
  });

  [ ['origin', origemInput], ['destination', destinoInput] ].forEach(([kind, input]) => {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') cancelSuggestions(kind);
      if (event.key === 'Enter') {
        const first = suggestionLists[kind]?.querySelector('.address-option');
        if (first) { event.preventDefault(); first.click(); }
      }
    });
  });

  $('localizar-embarque').addEventListener('click', () => {
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
      // O retorno da geocodificação preencherá rua e bairro, sem substituir por texto genérico.
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

  $('escolher-destino-mapa').addEventListener('click', () => {
    nextMapPoint = 'destination';
    mapaStatus.textContent = 'Toque no mapa no local onde você quer chegar';
    mensagem.textContent = 'Toque no mapa para escolher seu destino.';
    $('mapa').scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (map) map.invalidateSize();
  });

  // Ditado opcional do navegador: o resultado entra na busca normal de destino.
  const speechButton = $('falar-destino');
  const speechStatus = $('voz-status');
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let speech = null;
  let listening = false;
  let receivedSpeech = false;
  let speechFailed = false;
  const resetSpeechButton = () => {
    listening = false;
    speechButton.textContent = 'Falar endereço';
    speechButton.setAttribute('aria-pressed', 'false');
  };
  if (!SpeechRecognition || !window.isSecureContext) {
    speechButton.disabled = true;
    speechStatus.textContent = 'Ditado indisponível neste navegador. Digite o endereço ou escolha no mapa.';
  } else {
    speech = new SpeechRecognition();
    speech.lang = 'pt-BR';
    speech.continuous = false;
    speech.interimResults = false;
    speech.onstart = () => {
      listening = true;
      speechButton.textContent = 'Parar de ouvir';
      speechButton.setAttribute('aria-pressed', 'true');
      speechStatus.textContent = 'Estou ouvindo. Diga a rua, o número e o bairro do destino.';
    };
    speech.onresult = (event) => {
      const text = String(event.results?.[0]?.[0]?.transcript || '').trim();
      if (!text) return;
      receivedSpeech = true;
      destinoInput.value = text.slice(0, 300);
      destinoInput.dispatchEvent(new Event('input', { bubbles: true }));
      speechStatus.textContent = 'Confira o texto e escolha uma sugestão da busca. Se o local não aparecer, escolha no mapa.';
      destinoInput.focus({ preventScroll: true });
    };
    speech.onerror = (event) => {
      speechFailed = true;
      const messages = {
        'not-allowed': 'Permita o microfone no navegador para falar o endereço.',
        'service-not-allowed': 'O ditado não está disponível neste navegador.',
        'audio-capture': 'Microfone não encontrado. Digite o endereço ou escolha no mapa.',
        'no-speech': 'Não ouvi o endereço. Toque em Falar endereço e tente novamente.',
        'network': 'Não foi possível reconhecer a fala. Confira a conexão ou digite o endereço.',
        'aborted': 'Ditado encerrado. Você pode digitar o endereço ou tentar novamente.'
      };
      speechStatus.textContent = messages[event.error] || 'Não foi possível reconhecer a fala. Digite o endereço ou tente novamente.';
      resetSpeechButton();
    };
    speech.onend = () => {
      if (!receivedSpeech && !speechFailed) speechStatus.textContent = 'Nenhum endereço reconhecido. Tente novamente ou digite o destino.';
      resetSpeechButton();
    };
    speechButton.addEventListener('click', () => {
      if (listening) { speech.stop(); return; }
      receivedSpeech = false;
      speechFailed = false;
      try {
        speech.start();
        listening = true;
        speechButton.textContent = 'Parar de ouvir';
        speechButton.setAttribute('aria-pressed', 'true');
        speechStatus.textContent = 'Permita o microfone, se solicitado, e fale o endereço do destino.';
      } catch {
        speechFailed = true;
        resetSpeechButton();
        speechStatus.textContent = 'Não foi possível abrir o microfone. Tente novamente ou digite o endereço.';
      }
    });
    const stopSpeech = () => { if (listening) speech.abort(); };
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopSpeech(); });
    $('hub-nav-home').addEventListener('click', stopSpeech);
    $('hub-back').addEventListener('click', stopSpeech);
    window.addEventListener('pagehide', stopSpeech);
  }

  $('centralizar').addEventListener('click', () => {
    if (map) map.setView(MIRANDA, 14);
  });

  continuar.addEventListener('click', () => {
    routePreviewRequested = true;
    routePreview();
  });


  // ---------------------------------------------------------------- pedir a corrida de verdade
  // 1) o passageiro confirma o WhatsApp com um código de 6 números;
  // 2) a central calcula o valor (a mesma conta do WhatsApp) e assina a cotação por 5 minutos;
  // 3) "Pedir corrida" cria a corrida e chama o motorista mais perto. A tela acompanha a situação.
  const guardar = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
  const lido = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const reais = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');
  const SITUACAO = {
    procurando: '🔎 Procurando motorista…', aceita: '🚗 Motorista a caminho', chegou: '📍 O motorista chegou!',
    em_andamento: '🛣️ Em viagem', finalizada: '🏁 Corrida finalizada', cancelada: '❌ Corrida cancelada',
    sem_motorista: '😕 Nenhum motorista disponível agora'
  };
  const api = async (metodo, caminho, corpo) => {
    const r = await fetch(caminho, { method: metodo, credentials: 'same-origin', cache: 'no-store',
      headers: corpo ? { 'Content-Type': 'application/json' } : {}, body: corpo ? JSON.stringify(corpo) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.erro || d.error || 'Não deu certo. Tente de novo.'); e.status = r.status; throw e; }
    return d;
  };
  const el = (tag, props = {}, ...filhos) => { const n = Object.assign(document.createElement(tag), props); n.append(...filhos); return n; };
  const aviso = (txt, erro = false) => el('p', { className: 'pedido-aviso' + (erro ? ' erro' : ''), textContent: txt, role: 'status' });
  const mostrar = (...filhos) => { pedido.replaceChildren(...filhos); pedido.hidden = false; };

  function formularioEntrar(msg) {
    const nome = el('input', { type: 'text', autocomplete: 'name', placeholder: 'Seu nome', value: lido('vai-manu-nome'), maxLength: 80 });
    const fone = el('input', { type: 'tel', autocomplete: 'tel', inputMode: 'tel', placeholder: 'WhatsApp com DDD', value: lido('vai-manu-fone') });
    const codigo = el('input', { type: 'text', inputMode: 'numeric', autocomplete: 'one-time-code', placeholder: 'Código de 6 números', maxLength: 6, hidden: true });
    const botao = el('button', { type: 'button', className: 'continue-button', textContent: 'Receber código no WhatsApp' });
    const status = aviso(msg || 'Para pedir a corrida, confirme seu WhatsApp. Mandamos um código para ele.');
    let etapa = 'codigo';
    botao.onclick = async () => {
      botao.disabled = true;
      try {
        if (nome.value.trim().length < 2) throw new Error('Diga seu nome.');
        guardar('vai-manu-nome', nome.value.trim()); guardar('vai-manu-fone', fone.value.trim());
        if (etapa === 'codigo') {
          await api('POST', '/api/passageiro/codigo', { telefone: fone.value });
          etapa = 'entrar'; codigo.hidden = false; codigo.focus();
          botao.textContent = 'Confirmar código';
          status.textContent = 'Enviamos o código para o seu WhatsApp. Ele vale 10 minutos.';
        } else {
          const r = await api('POST', '/api/passageiro/entrar', { telefone: fone.value, codigo: codigo.value });
          telefone = r.telefone;
          await prepararPedido();
        }
      } catch (e) { status.textContent = e.message; status.classList.add('erro'); }
      finally { botao.disabled = false; }
    };
    mostrar(el('strong', { textContent: 'Pedir esta corrida' }), status, nome, fone, codigo, botao);
  }

  async function prepararPedido() {
    if (acompanhando) return;
    cotacao = null;
    const versao = versaoPedido;
    if (!origemPoint || !destinoPoint) return;
    if (!telefone) return formularioEntrar();
    const nome = lido('vai-manu-nome');
    if (nome.length < 2) return formularioEntrar('Confirme seu nome para pedir a corrida.');
    mostrar(aviso('Calculando o valor com a central…'));
    try {
      const extras = dropoffLines().join(' · ');
      cotacao = await api('POST', '/api/passageiro/cotacao', {
        nome, tipo: veiculo, pagamento: paymentInputs.find((i) => i.checked)?.value || '',
        origem: origemInput.value, destino: destinoInput.value + (extras ? ' · ' + extras : ''),
        origemPonto: { lat: origemPoint.lat, lng: origemPoint.lng }, destinoPonto: { lat: destinoPoint.lat, lng: destinoPoint.lng }
      });
    } catch (e) {
      if (versao !== versaoPedido) return; // a viagem mudou enquanto calculava
      if (e.status === 401) { telefone = null; return formularioEntrar(); }
      return mostrar(aviso(e.message, true));
    }
    if (versao !== versaoPedido) { cotacao = null; return; }
    const botao = el('button', { type: 'button', className: 'continue-button', textContent: `Pedir corrida · ${reais(cotacao.valor)}` });
    botao.onclick = async () => {
      if (versao !== versaoPedido || !cotacao) { pedido.hidden = true; return; }
      botao.disabled = true; botao.textContent = 'Pedindo…';
      try {
        const r = await api('POST', '/api/passageiro/pedir', { token: cotacao.token });
        guardar('vai-manu-corrida', String(r.id));
        acompanhar(r.id);
      } catch (e) {
        if (e.status === 409) { mostrar(aviso(e.message, true)); return; }
        botao.disabled = false; botao.textContent = `Pedir corrida · ${reais(cotacao.valor)}`;
        pedido.append(aviso(e.message, true));
      }
    };
    const sair = el('button', { type: 'button', className: 'link-sair', textContent: 'Não é você? Trocar número' });
    sair.onclick = async () => { await api('POST', '/api/passageiro/sair').catch(() => {}); telefone = null; formularioEntrar(); };
    mostrar(el('strong', { textContent: 'Valor da central: ' + reais(cotacao.valor) }),
      aviso(`${String(cotacao.km).replace('.', ',')} km pelas ruas. Você paga direto ao motorista (${paymentLabel() || 'dinheiro ou Pix'}). Válido por 5 minutos.`),
      botao, sair);
  }

  async function acompanhar(id) {
    acompanhando = id;
    let c;
    try { c = await api('GET', '/api/passageiro/viagem/' + id); }
    catch (e) {
      if (e.status === 401 || e.status === 404) { guardar('vai-manu-corrida', null); acompanhando = null; return; }
      setTimeout(() => acompanhar(id), 8000); return;
    }
    const fim = ['finalizada', 'cancelada', 'sem_motorista'].includes(c.status);
    const partes = [el('strong', { textContent: `Corrida #${c.id} · ${SITUACAO[c.status] || c.status}` }),
      aviso(`${c.origem_texto} → ${c.destino_texto}`),
      aviso('Valor: ' + reais(c.valor_final ?? c.valor_estimado))];
    if (c.motorista_nome) partes.push(aviso(`Motorista: ${c.motorista_nome} · ${[c.carro, c.cor].filter(Boolean).join(' ')} · placa ${c.placa || '—'}`));
    if (['procurando', 'aceita', 'chegou'].includes(c.status)) {
      const cancelar = el('button', { type: 'button', className: 'link-sair', textContent: 'Cancelar corrida' });
      cancelar.onclick = async () => {
        if (!confirm('Cancelar esta corrida?')) return;
        try { await api('POST', `/api/passageiro/viagem/${c.id}/cancelar`); acompanhar(c.id); } catch (e) { alert(e.message); }
      };
      partes.push(cancelar);
    }
    if (!fim) partes.push(aviso('Você também recebe os avisos no seu WhatsApp.'));
    else {
      guardar('vai-manu-corrida', null); acompanhando = null;
      const nova = el('button', { type: 'button', className: 'continue-button', textContent: 'Pedir outra corrida' });
      nova.onclick = () => { pedido.hidden = true; clearRoute(); previa.hidden = true; updateContinueButton(); };
      partes.push(nova);
    }
    mostrar(...partes);
    pedido.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (!fim) setTimeout(() => acompanhar(id), 5000);
  }

  api('GET', '/api/passageiro/eu').then((r) => {
    telefone = r.telefone;
    const aberta = Number(lido('vai-manu-corrida'));
    if (telefone && aberta) acompanhar(aberta);
  }).catch(() => {});

  window.addEventListener('pagehide', () => {
    if (gpsWatch !== null && navigator.geolocation) navigator.geolocation.clearWatch(gpsWatch);
  });
})();
