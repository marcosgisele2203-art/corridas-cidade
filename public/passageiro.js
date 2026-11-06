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
  // Token público usado também nos painéis de mapas da mesma origem.
  const MAPBOX_TOKEN_KEY = 'vai-manu-mapbox-public-token';
  const addressRequests = { origin: 0, destination: 0 };
  const addressControllers = { origin: null, destination: null };
  const addressNotice = $('endereco-status');
  const configButton = $('configurar-enderecos');
  const suggestionLists = { origin: $('sugestoes-origem'), destination: $('sugestoes-destino') };
  const suggestionTimers = { origin: null, destination: null };
  const suggestionControllers = { origin: null, destination: null };
  const suggestionRequests = { origin: 0, destination: 0 };
  const validMapboxToken = (token) => /^pk\.[A-Za-z0-9._-]{10,}$/.test(token || '');
  const mapboxToken = () => localStorage.getItem(MAPBOX_TOKEN_KEY) || '';
  const addressHint = (message) => { if (addressNotice) addressNotice.textContent = message; };
  const findStreetAndNeighborhood = (features) => {
    // Sem inferir números de imóveis vizinhos ao ponto escolhido.
    const street = features.find((f) => f?.properties?.feature_type === 'street');
    const address = features.find((f) => f?.properties?.feature_type === 'address');
    const neighborhood = features.find((f) => f?.properties?.feature_type === 'neighborhood');
    const locality = features.find((f) => f?.properties?.feature_type === 'locality');
    const context = (street || address || features[0])?.properties?.context || {};
    const road = street?.properties?.name || address?.properties?.context?.street?.name ||
      context.street?.name || '';
    const district = neighborhood?.properties?.name || context.neighborhood?.name ||
      locality?.properties?.name || context.locality?.name || '';
    return { road: String(road).trim(), district: String(district).trim() };
  };
  const reverseAddress = async (kind, point) => {
    const input = kind === 'origin' ? origemInput : destinoInput;
    const request = ++addressRequests[kind];
    if (addressControllers[kind]) addressControllers[kind].abort();
    addressControllers[kind] = null;
    const token = mapboxToken();
    if (!validMapboxToken(token)) {
      addressHint('Para identificar ruas e bairros automaticamente, configure seu token público do Mapbox.');
      return;
    }
    const controller = new AbortController();
    addressControllers[kind] = controller;
    input.value = 'Identificando rua e bairro…';
    addressHint('Consultando o endereço aproximado no Mapbox…');
    try {
      const params = new URLSearchParams({
        longitude: String(point.lng), latitude: String(point.lat),
        language: 'pt', country: 'br', access_token: token
      });
      const response = await fetch('https://api.mapbox.com/search/geocode/v6/reverse?' + params, {
        signal: controller.signal
      });
      if (!response.ok) throw new Error('Serviço de endereços indisponível (HTTP ' + response.status + ').');
      const data = await response.json();
      if (request !== addressRequests[kind]) return;
      const { road, district } = findStreetAndNeighborhood(Array.isArray(data.features) ? data.features : []);
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
      addressHint('Não foi possível identificar a rua e o bairro. Verifique a conexão ou o token Mapbox.');
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
    const token = mapboxToken();
    if (!validMapboxToken(token)) {
      addressHint('Configure o token público Mapbox em Configurações de endereço para pesquisar.');
      return;
    }
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
      const search = async (query) => {
        const params = new URLSearchParams({
          q: query, language: 'pt', country: 'br', limit: '10',
          proximity: '-56.378,-20.240', types: 'street,address,neighborhood',
          access_token: token
        });
        const response = await fetch('https://api.mapbox.com/search/geocode/v6/forward?' + params, {
          signal: controller.signal
        });
        if (!response.ok) throw new Error('Busca indisponível (HTTP ' + response.status + ').');
        const data = await response.json();
        const features = Array.isArray(data.features) ? data.features : [];
        return features.filter((feature) => {
          const coords = feature.geometry?.coordinates;
          return Array.isArray(coords) && Number.isFinite(coords[0]) && Number.isFinite(coords[1]) &&
            Math.abs(coords[0] + 56.378) <= 0.42 && Math.abs(coords[1] + 20.240) <= 0.36;
        });
      };
      try {
        // "Alegria" isolado encontra muitos lugares fora da cidade.
        // Priorizar a cidade, com fallback para a busca original.
        const contextual = /miranda/i.test(term) ? term : term + ', Miranda, Mato Grosso do Sul';
        let results = await search(contextual);
        if (request !== suggestionRequests[kind]) return;
        if (!results.length && contextual !== term) results = await search(term);
        // Fallback OpenStreetMap/Photon quando o índice Mapbox não cobre uma rua local.
        // API pública de demonstração: uso limitado e sem garantia de disponibilidade.
        if (!results.length) {
          const query = /^rua\b/i.test(term) ? term : 'Rua ' + term;
          const photonParams = new URLSearchParams({
            q: query, lat: '-20.240', lon: '-56.378', limit: '12', lang: 'pt'
          });
          try {
            const photonResponse = await fetch('https://photon.komoot.io/api/?' + photonParams, {
              signal: controller.signal
            });
            if (photonResponse.ok) {
              const photonData = await photonResponse.json();
              const clean = (v) => String(v || '').normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
              const searchWords = clean(term).replace(/^(rua|avenida|av|travessa)\s+/, '');
              results = (Array.isArray(photonData.features) ? photonData.features : [])
                .filter((feature) => {
                  const coords = feature.geometry?.coordinates;
                  const props = feature.properties || {};
                  const streetName = String(props.name || props.street || '');
                  return Array.isArray(coords) && Number.isFinite(coords[0]) &&
                    Number.isFinite(coords[1]) &&
                    Math.abs(coords[0] + 56.378) <= 0.12 &&
                    Math.abs(coords[1] + 20.240) <= 0.12 &&
                    clean(streetName).includes(searchWords);
                })
                .map((feature) => {
                  const props = feature.properties || {};
                  return {
                    geometry: feature.geometry,
                    properties: {
                      name: props.name || props.street,
                      feature_type: 'street',
                      context: {
                        neighborhood: props.district ? { name: props.district } : undefined,
                        place: { name: props.city || 'Miranda' }
                      }
                    }
                  };
                });
            }
          } catch (fallbackError) {
            if (fallbackError.name === 'AbortError') throw fallbackError;
            // A busca original permanece disponível mesmo se Photon falhar.
          }
        }
        // Os nomes das ruas no mapa OSM nem sempre aparecem nos índices de geocodificação.
        // Consulta pontual aos nomes cadastrados perto de Miranda, somente após as duas buscas falharem.
        if (!results.length && term.length >= 5) {
          const simplified = term.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/^(rua|avenida|av\\.?|travessa)\s+/i, '')
            .trim().replace(/[^\\p{L}\\p{N} -]/gu, '');
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
  if (configButton) configButton.addEventListener('click', () => {
    const token = window.prompt('Cole somente seu token PÚBLICO do Mapbox (começa com pk.). Nunca use token secreto (sk.).', mapboxToken());
    if (token === null) return;
    if (!validMapboxToken(token.trim())) {
      addressHint('Token inválido. Use apenas um token público Mapbox iniciado por pk.');
      return;
    }
    localStorage.setItem(MAPBOX_TOKEN_KEY, token.trim());
    addressHint('Mapbox configurado neste navegador. Identificando os pontos do mapa…');
    if (origemPoint) reverseAddress('origin', origemPoint);
    if (destinoPoint) reverseAddress('destination', destinoPoint);
  });


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

  const loadTariffs = async (signal) => {
    const response = await fetch('/api/publico/tarifas', { cache: 'no-store', signal });
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
      const [routeResponse, tariffsResult] = await Promise.allSettled([
        fetch(url, { signal: controller.signal }),
        loadTariffs(controller.signal)
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
    else destinoPoint = latlng;
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
