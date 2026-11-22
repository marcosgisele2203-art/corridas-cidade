// Pedido de corrida do passageiro em 3 telas: onde te buscar, para onde vai, confirmar e chamar.
// O valor vem sempre da central (a mesma conta do WhatsApp); aqui no celular nada é calculado.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CIDADE = [-20.240, -56.378]; // centro do mapa enquanto o GPS não responde
  const NOMES = { moto: ['Moto', '1 pessoa'], carro: ['Carro', 'até 4 pessoas'], van: ['Van', 'grupos e famílias'], caminhao: ['Frete', 'mudança e cargas'] };
  const SITUACAO = {
    procurando: ['🔎', 'Procurando motorista', 'Estamos chamando o motorista mais perto. Você também recebe os avisos no WhatsApp.'],
    aceita: ['🚗', 'Motorista a caminho', 'Fique no local de embarque. Avisamos quando ele chegar.'],
    chegou: ['📍', 'O motorista chegou!', 'Ele está te esperando no local de embarque.'],
    em_andamento: ['🛣️', 'Boa viagem!', 'Você está a caminho do destino.'],
    finalizada: ['🏁', 'Corrida finalizada', 'Obrigado por ir com a gente! Você pode dar uma nota ao motorista pelo WhatsApp.'],
    cancelada: ['✖️', 'Corrida cancelada', 'Se precisar, chame outra corrida.'],
    sem_motorista: ['😕', 'Nenhum motorista livre agora', 'Tente de novo em alguns minutos ou fale com a central.'],
  };
  const guardar = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
  const lido = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const reais = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');
  const api = async (metodo, caminho, corpo) => {
    const r = await fetch(caminho, { method: metodo, credentials: 'same-origin', cache: 'no-store',
      headers: corpo ? { 'Content-Type': 'application/json' } : {}, body: corpo ? JSON.stringify(corpo) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.erro || d.error || 'Não deu certo. Tente de novo.'); e.status = r.status; throw e; }
    return d;
  };

  // ---------------------------------------------------------------- estado da corrida que está sendo montada
  const viagem = { busca: null, destino: null }; // { ponto: {lat,lng}, texto }
  let central = { aceitando: true, tipos: ['moto', 'carro'] };
  let etapa = 'busca';
  let mapaBuscaAberto = false; // na tela 1 o mapa só aparece se a pessoa pedir
  let precos = {}, rodadaPrecos = 0, cotacao = null;

  // ---------------------------------------------------------------- telas e botão "voltar" do celular
  const TELAS = ['busca', 'destino', 'confirmar', 'corrida'];
  function irPara(nova, { historico = true } = {}) {
    etapa = nova;
    TELAS.forEach((t) => { $('tela-' + t).hidden = t !== nova; });
    // o mapa aparece para marcar o embarque e, se a pessoa pedir, o destino
    const comMapa = (nova === 'busca' && mapaBuscaAberto) || (nova === 'destino' && !$('destinoNoMapa').hidden);
    document.body.classList.toggle('sem-mapa', !comMapa || !mapa);
    document.body.classList.toggle('destino', nova === 'destino');
    $('balaoPino').textContent = nova === 'destino' ? 'Levar até aqui' : 'Te buscamos aqui';
    if (mapa && comMapa) setTimeout(() => {
      // o mapa estava escondido: ajusta o tamanho e volta para o ponto já escolhido, sem mudar nada
      ignorarAte = Date.now() + 600;
      mapa.invalidateSize({ pan: false });
      const alvo = viagem[nova === 'busca' ? 'busca' : 'destino'];
      if (alvo) levarMapaPara(alvo.ponto);
    }, 50);
    if (historico) { try { history.pushState({ etapa: nova }, ''); } catch {} }
    window.scrollTo(0, 0);
    if (nova === 'confirmar') prepararConfirmacao();
  }
  addEventListener('popstate', (e) => {
    const alvo = e.state?.etapa;
    if (etapa === 'corrida') { try { history.pushState({ etapa }, ''); } catch {} return; } // corrida aberta: não sai dela pelo voltar
    if (alvo && TELAS.includes(alvo)) irPara(alvo, { historico: false });
    else irPara('busca', { historico: false });
  });
  document.querySelectorAll('[data-voltar]').forEach((b) => b.addEventListener('click', () => history.back()));

  // ---------------------------------------------------------------- mapa com o pino parado no centro
  // ignorarAte: movimentos feitos pelo próprio site (GPS, busca, troca de tela) não mudam o ponto escolhido
  // a consulta do nome da rua é separada para o embarque e o destino: uma não cancela a outra
  let mapa = null, mexeuNoMapa = false, ignorarAte = 0;
  const timerEndereco = { busca: null, destino: null }, rodadaEndereco = { busca: 0, destino: 0 };
  const PROCURANDO = 'Procurando o endereço…';
  // texto que vai para a central: nunca "Procurando…", mesmo se o nome da rua ainda não chegou
  const textoDe = (tipo) => (viagem[tipo].texto === PROCURANDO ? 'Ponto marcado no mapa' : viagem[tipo].texto);
  if (window.L && typeof window.mapaFundo === 'function') {
    mapa = L.map('mapa', { zoomControl: true, attributionControl: true }).setView(CIDADE, 15);
    mapaFundo(mapa);
    mapa.on('movestart', () => $('mapaCaixa').classList.add('movendo'));
    mapa.on('dragstart', () => { mexeuNoMapa = true; });
    mapa.on('moveend', () => {
      $('mapaCaixa').classList.remove('movendo');
      if (Date.now() < ignorarAte || !mexeuNoMapa) return;
      const c = mapa.getCenter(), ponto = { lat: c.lat, lng: c.lng };
      if (etapa === 'busca') marcar('busca', ponto);
      else if (etapa === 'destino') marcar('destino', ponto);
    });
  } else {
    $('mapaErro').hidden = false;
    document.body.classList.add('sem-mapa');
  }

  // ponto escolhido no mapa ou pelo GPS: pergunta à central o nome da rua e do bairro
  function marcar(tipo, ponto, texto) {
    viagem[tipo] = { ponto, texto: texto || PROCURANDO };
    mostrarEndereco(tipo);
    clearTimeout(timerEndereco[tipo]);
    const rodada = ++rodadaEndereco[tipo];
    if (texto) return;
    timerEndereco[tipo] = setTimeout(async () => {
      let nome = 'Ponto marcado no mapa';
      try {
        const d = await api('GET', '/api/publico/endereco-do-ponto?' + new URLSearchParams({ lat: String(ponto.lat), lng: String(ponto.lng) }));
        const rua = String(d.rua || '').trim(), bairro = String(d.bairro || '').trim();
        if (rua || bairro) nome = [rua, bairro && 'Bairro ' + bairro].filter(Boolean).join(', ');
      } catch { /* sem nome de rua o ponto do mapa continua valendo */ }
      if (rodada !== rodadaEndereco[tipo] || viagem[tipo]?.ponto !== ponto) return;
      viagem[tipo].texto = nome;
      mostrarEndereco(tipo);
      if (etapa === 'confirmar') mostrarResumo(); // o nome chegou depois de a pessoa avançar
    }, 350);
  }
  function mostrarEndereco(tipo) {
    const caixa = $(tipo === 'busca' ? 'enderecoBusca' : 'enderecoDestino');
    const v = viagem[tipo];
    caixa.querySelector('span').textContent = v ? v.texto : (tipo === 'busca' ? '' : 'Arraste o mapa até o lugar');
    caixa.classList.toggle('vazio', !v);
    if (tipo === 'destino') { $('confirmarDestino').disabled = !v; return; }
    // tela 1: as opções somem quando já há endereço ou o mapa está aberto
    $('opcoesBusca').hidden = !!v || mapaBuscaAberto;
    $('buscaEscolhida').hidden = !v;
    $('confirmarBusca').hidden = !v;
    $('dicaMapaBusca').hidden = !mapaBuscaAberto;
    $('ajustarBusca').hidden = mapaBuscaAberto;
    $('fecharMapaBusca').hidden = !(mapaBuscaAberto && !v);
  }
  function abrirMapaBusca() {
    if (!mapa) { $('erroBusca').textContent = 'O mapa não carregou. Use “Usar onde estou agora” ou escreva o endereço.'; return; }
    mapaBuscaAberto = true;
    mexeuNoMapa = false;
    document.body.classList.remove('sem-mapa');
    mostrarEndereco('busca');
    setTimeout(() => {
      ignorarAte = Date.now() + 600;
      mapa.invalidateSize({ pan: false });
      if (viagem.busca) levarMapaPara(viagem.busca.ponto);
      $('mapaCaixa').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }
  function trocarBusca() {
    viagem.busca = null;
    mapaBuscaAberto = false;
    document.body.classList.add('sem-mapa');
    $('erroBusca').textContent = '';
    mostrarEndereco('busca');
    window.scrollTo(0, 0);
  }
  function levarMapaPara(ponto) {
    if (!mapa) return;
    ignorarAte = Date.now() + 600;
    mapa.setView([ponto.lat, ponto.lng], 17, { animate: false });
  }

  // ---------------------------------------------------------------- tela 1: onde te buscar
  $('usarGps').addEventListener('click', () => {
    const erro = $('erroBusca');
    erro.textContent = '';
    if (!navigator.geolocation || !window.isSecureContext) { erro.textContent = 'Este celular não deixou usar a localização. Escreva o endereço.'; return; }
    const botao = $('usarGps');
    botao.disabled = true; botao.lastChild.textContent = 'Procurando você…';
    navigator.geolocation.getCurrentPosition((pos) => {
      botao.disabled = false; botao.lastChild.textContent = 'Usar onde estou agora';
      const ponto = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      levarMapaPara(ponto);
      mexeuNoMapa = true;
      marcar('busca', ponto);
    }, (e) => {
      botao.disabled = false; botao.lastChild.textContent = 'Usar onde estou agora';
      erro.textContent = e.code === 1 ? 'Para usar onde você está, toque em “Permitir” quando o celular perguntar. Ou escreva o endereço.'
        : 'Não achamos sua localização. Escreva o endereço.';
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
  });
  $('abrirDigitar').addEventListener('click', () => {
    $('abrirDigitar').hidden = true;
    $('digitarBox').hidden = false;
    $('digitarBusca').focus();
  });
  $('mapaBusca').addEventListener('click', abrirMapaBusca);
  $('ajustarBusca').addEventListener('click', abrirMapaBusca);
  $('trocarBusca').addEventListener('click', trocarBusca);
  $('fecharMapaBusca').addEventListener('click', trocarBusca);
  $('confirmarBusca').addEventListener('click', () => {
    if (!viagem.busca) return;
    guardar('vai-manu-referencia', $('referencia').value.trim());
    irPara('destino');
    setTimeout(() => $('digitarDestino').focus(), 100);
  });
  $('referencia').value = lido('vai-manu-referencia');

  // ---------------------------------------------------------------- busca de endereço (a mesma do site antigo)
  const rotulo = (f) => {
    const p = f.properties || {}, ctx = p.context || {};
    const rua = p.feature_type === 'street' ? p.name : ctx.street?.name || p.name || '';
    const bairro = ctx.neighborhood?.name || (p.feature_type === 'neighborhood' ? p.name : '');
    return [rua, bairro && !String(rua).includes(bairro) ? 'Bairro ' + bairro : ''].filter(Boolean).join(', ') || p.full_address || '';
  };
  // ruas que o índice de endereços não conhece: procura pelo nome no mapa aberto (OpenStreetMap), perto da cidade
  async function ruasDoMapa(termo, sinal) {
    const simples = termo.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^(rua|avenida|av[.]?|travessa)\s+/i, '').trim().replace(/[^a-zA-Z0-9 -]/g, '');
    const chave = simples.split(/\s+/).filter((w) => w.length >= 4).slice(-1)[0];
    if (!chave) return [];
    const consulta = '[out:json][timeout:10];way["highway"]["name"~"' + chave + '",i](-20.31,-56.45,-20.17,-56.29);out geom 20;';
    const r = await fetch('https://overpass.kumi.systems/api/interpreter', { method: 'POST', signal: sinal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ data: consulta }) });
    if (!r.ok) return [];
    const limpo = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    return ((await r.json()).elements || []).filter((w) => w.tags?.name && limpo(w.tags.name).includes(limpo(simples)) && w.geometry?.length)
      .slice(0, 6).map((w) => { const pt = w.geometry[Math.floor(w.geometry.length / 2)]; return { geometry: { coordinates: [pt.lon, pt.lat] }, properties: { name: w.tags.name, feature_type: 'street' } }; });
  }
  function busca(campo, lista, aoEscolher) {
    let timer = null, controle = null, rodada = 0;
    const fechar = () => { lista.replaceChildren(); lista.hidden = true; };
    const info = (txt) => { const d = document.createElement('div'); d.className = 'info'; d.textContent = txt; lista.replaceChildren(d); lista.hidden = false; };
    const procurar = () => {
      clearTimeout(timer); if (controle) controle.abort();
      const termo = campo.value.trim(), minha = ++rodada;
      if (termo.length < 3) { fechar(); return; }
      info('Procurando…');
      timer = setTimeout(async () => {
        controle = new AbortController();
        try {
          const r = await api('GET', '/api/publico/enderecos?' + new URLSearchParams({ q: termo }));
          let achados = Array.isArray(r.features) ? r.features : [];
          if (!achados.length && termo.length >= 5) achados = await ruasDoMapa(termo, controle.signal).catch(() => []);
          if (minha !== rodada) return;
          lista.replaceChildren();
          const vistos = new Set();
          for (const f of achados) {
            const nome = rotulo(f), c = f.geometry?.coordinates;
            if (!nome || !c || vistos.has(nome)) continue;
            vistos.add(nome);
            const b = document.createElement('button');
            b.type = 'button'; b.setAttribute('role', 'option');
            b.innerHTML = '<svg class="ic"><use href="#i-pino"/></svg>';
            b.append(document.createTextNode(nome));
            b.addEventListener('click', () => { fechar(); campo.value = nome; aoEscolher({ lat: c[1], lng: c[0] }, nome); });
            lista.append(b);
          }
          if (!lista.childElementCount) info('Não achamos esse endereço. Tente outro nome ou marque no mapa.');
          lista.hidden = false;
        } catch (e) {
          if (minha === rodada && e.name !== 'AbortError') info('A busca não respondeu. Tente de novo ou marque no mapa.');
        }
      }, 400);
    };
    campo.addEventListener('input', procurar);
    campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const b = lista.querySelector('button'); if (b) { e.preventDefault(); b.click(); } } });
    return procurar;
  }
  busca($('digitarBusca'), $('sugestoesBusca'), (ponto, nome) => { levarMapaPara(ponto); mexeuNoMapa = true; marcar('busca', ponto, nome); });
  const procurarDestino = busca($('digitarDestino'), $('sugestoesDestino'), (ponto, nome) => {
    viagem.destino = { ponto, texto: nome };
    irPara('confirmar');
  });

  // ---------------------------------------------------------------- tela 2: para onde vai
  $('mapaDestino').addEventListener('click', () => {
    if (!mapa) { $('erroDestino').textContent = 'O mapa não carregou. Escreva o lugar no campo acima.'; return; }
    $('destinoNoMapa').hidden = false;
    document.body.classList.remove('sem-mapa');
    // começa perto do embarque: o destino costuma ser na mesma cidade
    mexeuNoMapa = false;
    viagem.destino = null; mostrarEndereco('destino');
    setTimeout(() => {
      ignorarAte = Date.now() + 600;
      mapa.invalidateSize({ pan: false });
      if (viagem.busca) levarMapaPara(viagem.busca.ponto);
      $('mapaCaixa').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  });
  $('confirmarDestino').addEventListener('click', () => { if (viagem.destino) irPara('confirmar'); });

  // ditado: a pessoa fala o lugar e a busca procura sozinha
  const Ditado = window.SpeechRecognition || window.webkitSpeechRecognition;
  const botaoFalar = $('falarDestino'), vozStatus = $('vozStatus');
  if (!Ditado || !window.isSecureContext) {
    botaoFalar.hidden = true;
    botaoFalar.parentElement.style.gridTemplateColumns = '1fr';
  } else {
    const ouvir = new Ditado();
    let ouvindo = false;
    ouvir.lang = 'pt-BR'; ouvir.continuous = false; ouvir.interimResults = false;
    const parar = () => { ouvindo = false; botaoFalar.setAttribute('aria-pressed', 'false'); botaoFalar.querySelector('span').textContent = 'Falar'; };
    ouvir.onstart = () => { ouvindo = true; botaoFalar.setAttribute('aria-pressed', 'true'); botaoFalar.querySelector('span').textContent = 'Parar'; vozStatus.textContent = 'Pode falar o lugar para onde você vai.'; };
    ouvir.onresult = (e) => {
      const texto = String(e.results?.[0]?.[0]?.transcript || '').trim();
      if (!texto) return;
      $('digitarDestino').value = texto.slice(0, 200);
      vozStatus.textContent = 'Toque no lugar certo na lista abaixo.';
      procurarDestino();
    };
    ouvir.onerror = (e) => {
      vozStatus.textContent = e.error === 'not-allowed' ? 'Para falar, permita o microfone quando o celular perguntar.' : 'Não deu para ouvir. Tente de novo ou escreva o lugar.';
      parar();
    };
    ouvir.onend = parar;
    botaoFalar.addEventListener('click', () => {
      if (ouvindo) { ouvir.stop(); return; }
      try { ouvir.start(); } catch { vozStatus.textContent = 'Não deu para abrir o microfone. Escreva o lugar.'; }
    });
    addEventListener('pagehide', () => { if (ouvindo) ouvir.abort(); });
  }

  // ---------------------------------------------------------------- tela 3: confirmar e chamar
  $('nome').value = lido('vai-manu-nome');
  $('whats').value = lido('vai-manu-fone');
  const tipoEscolhido = () => document.querySelector('input[name="veiculo"]:checked')?.value;
  const pagamento = () => document.querySelector('input[name="pagamento"]:checked')?.value || 'dinheiro';

  function textoBotao() {
    const botao = $('chamar'), tipo = tipoEscolhido();
    if (!central.aceitando) { botao.disabled = true; botao.textContent = 'A central está fechada agora'; return; }
    if (!tipo) { botao.disabled = true; botao.textContent = 'Escolha como quer ir'; return; }
    const nome = NOMES[tipo][0].toLowerCase(), p = precos[tipo];
    botao.disabled = false;
    botao.textContent = cotacao && cotacao.tipo === tipo ? `Chamar ${nome} · ${reais(cotacao.valor)}`
      : p === undefined ? 'Calculando o valor…' : p === null ? `Chamar ${nome}` : `Chamar ${nome} · ${reais(p)}`;
    if (p === undefined) botao.disabled = true;
  }
  function mostrarResumo() {
    const ref = lido('vai-manu-referencia');
    $('resumoBusca').textContent = textoDe('busca') + (ref ? ' · ' + ref : '');
    $('resumoDestino').textContent = textoDe('destino');
  }
  function prepararConfirmacao() {
    $('erroPedido').textContent = '';
    cotacao = null;
    mostrarResumo();
    const tipos = central.tipos.length ? central.tipos : ['moto', 'carro'];
    const lista = $('veiculos');
    const antes = tipoEscolhido();
    lista.replaceChildren();
    precos = {};
    for (const tipo of tipos) {
      const [nome, quem] = NOMES[tipo] || [tipo, ''];
      const l = document.createElement('label');
      l.className = 'veiculo';
      l.innerHTML = '<input type="radio" name="veiculo"><span class="marca"></span><span><b></b><small></small></span><span class="preco">…</span>';
      l.querySelector('input').value = tipo;
      l.querySelector('b').textContent = nome;
      l.querySelector('small').textContent = quem;
      lista.append(l);
    }
    const marcar = lista.querySelector(`input[value="${antes}"]`) || lista.querySelector('input[value="carro"]') || lista.querySelector('input');
    if (marcar) marcar.checked = true;
    lista.querySelectorAll('input').forEach((i) => i.addEventListener('change', () => { cotacao = null; textoBotao(); }));
    textoBotao();
    // valor de cada veículo, calculado pela central
    const rodada = ++rodadaPrecos;
    for (const tipo of tipos) {
      api('POST', '/api/publico/estimativa', { tipo, origemPonto: viagem.busca.ponto, destinoPonto: viagem.destino.ponto })
        .then((d) => { if (rodada === rodadaPrecos) precos[tipo] = d.valor; })
        .catch(() => { if (rodada === rodadaPrecos) precos[tipo] = null; })
        .finally(() => {
          if (rodada !== rodadaPrecos) return;
          const alvo = lista.querySelector(`input[value="${tipo}"]`)?.closest('.veiculo')?.querySelector('.preco');
          if (alvo) alvo.textContent = precos[tipo] == null ? 'na hora' : reais(precos[tipo]);
          textoBotao();
        });
    }
  }
  document.querySelectorAll('input[name="pagamento"]').forEach((i) => i.addEventListener('change', () => { cotacao = null; textoBotao(); }));

  $('chamar').addEventListener('click', async () => {
    const erro = $('erroPedido'), botao = $('chamar');
    erro.textContent = '';
    const nome = $('nome').value.trim(), fone = $('whats').value.trim(), digitos = fone.replace(/\D/g, '');
    if (nome.length < 2) { erro.textContent = 'Escreva o nome de quem vai.'; $('nome').focus(); return; }
    if (digitos.length < 10 || digitos.length > 13) { erro.textContent = 'Escreva o WhatsApp com DDD. Exemplo: 67 99999-9999.'; $('whats').focus(); return; }
    guardar('vai-manu-nome', nome); guardar('vai-manu-fone', fone);
    const tipo = tipoEscolhido(), ref = lido('vai-manu-referencia');
    botao.disabled = true; botao.textContent = 'Chamando…';
    try {
      if (!cotacao || cotacao.tipo !== tipo || cotacao.pagamento !== pagamento()) {
        const c = await api('POST', '/api/passageiro/cotacao', {
          nome, telefone: fone, tipo, pagamento: pagamento(),
          origem: textoDe('busca') + (ref ? ' · Referência: ' + ref : ''), destino: textoDe('destino'),
          origemPonto: viagem.busca.ponto, destinoPonto: viagem.destino.ponto,
        });
        cotacao = { ...c, tipo, pagamento: pagamento() };
        // se o valor mudou desde que a tela abriu, mostra o novo e espera outro toque
        if (precos[tipo] != null && c.valor !== precos[tipo]) {
          precos[tipo] = c.valor;
          erro.textContent = `O valor ficou ${reais(c.valor)}. Toque de novo para chamar.`;
          textoBotao();
          return;
        }
      }
      const r = await api('POST', '/api/passageiro/pedir', { token: cotacao.token });
      guardar('vai-manu-corrida', String(r.id));
      cotacao = null;
      abrirCorrida(r.id);
    } catch (e) {
      if (e.status === 400 && /cota/i.test(e.message)) cotacao = null; // cotação vencida: a próxima tentativa faz outra
      erro.textContent = e.message;
      textoBotao();
    }
  });

  // ---------------------------------------------------------------- tela 4: acompanhar a corrida
  let timerCorrida = null, rodadaCorrida = 0;
  function abrirCorrida(id) {
    irPara('corrida', { historico: false });
    try { history.replaceState({ etapa: 'corrida' }, ''); } catch {}
    acompanhar(id);
  }
  async function acompanhar(id) {
    clearTimeout(timerCorrida);
    const rodada = ++rodadaCorrida;
    let c;
    try { c = await api('GET', '/api/passageiro/viagem/' + id); }
    catch (e) {
      if (rodada !== rodadaCorrida) return;
      if (e.status === 401 || e.status === 404) { guardar('vai-manu-corrida', null); recomecar(); return; }
      timerCorrida = setTimeout(() => acompanhar(id), 8000);
      return;
    }
    if (rodada !== rodadaCorrida) return;
    const [icone, titulo, texto] = SITUACAO[c.status] || ['🚗', c.status, ''];
    $('situacao').className = 'situacao ' + c.status;
    $('situacaoIcone').textContent = icone;
    $('situacaoTitulo').textContent = c.status === 'aceita' && c.motorista_nome ? `${c.motorista_nome.split(' ')[0]} está a caminho` : titulo;
    $('situacaoTexto').textContent = c.status === 'chegou' && c.carro
      ? `Procure o ${[c.carro, c.cor].filter(Boolean).join(' ')}${c.placa ? ', placa ' + c.placa : ''}.` : texto;
    $('motorista').hidden = !c.motorista_nome;
    if (c.motorista_nome) {
      $('motoristaIniciais').textContent = c.motorista_nome.split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
      $('motoristaNome').textContent = c.motorista_nome;
      $('motoristaCarro').textContent = [c.carro, c.cor].filter(Boolean).join(' ');
      $('motoristaPlaca').textContent = c.placa || '—';
    }
    $('corridaBusca').textContent = c.origem_texto;
    $('corridaDestino').textContent = c.destino_texto;
    $('corridaValor').textContent = (c.valor_final != null ? 'Valor: ' : 'Valor combinado: ') + reais(c.valor_final ?? c.valor_estimado);
    const fim = ['finalizada', 'cancelada', 'sem_motorista'].includes(c.status);
    $('cancelar').hidden = !['procurando', 'aceita', 'chegou'].includes(c.status);
    $('outraCorrida').hidden = !fim;
    $('cancelar').onclick = async () => {
      if (!confirm('Quer mesmo cancelar esta corrida?')) return;
      try { await api('POST', `/api/passageiro/viagem/${c.id}/cancelar`); acompanhar(c.id); }
      catch (e) { alert(e.message); }
    };
    if (fim) { guardar('vai-manu-corrida', null); return; }
    timerCorrida = setTimeout(() => acompanhar(id), 5000);
  }
  function recomecar() {
    clearTimeout(timerCorrida); rodadaCorrida++;
    viagem.destino = null;
    $('digitarDestino').value = ''; $('destinoNoMapa').hidden = true;
    mapaBuscaAberto = false;
    mostrarEndereco('busca');
    try { history.replaceState({ etapa: 'busca' }, ''); } catch {}
    irPara('busca', { historico: false });
  }
  $('outraCorrida').addEventListener('click', recomecar);

  // ---------------------------------------------------------------- dados da central e corrida aberta
  api('GET', '/api/publico/inicio').then((d) => {
    const nome = (d.nome || '').trim();
    if (nome && nome.toLowerCase().replace(/\s+/g, ' ') !== 'vai de manu') document.querySelectorAll('[data-marca]').forEach((el) => { el.textContent = nome; });
    if (d.passageiro) document.querySelectorAll('[data-whats]').forEach((a) => { a.href = d.passageiro; a.hidden = false; });
    // o site pede todos os veículos ligados nas Configurações
    central = { aceitando: d.aceitando !== false, tipos: Array.isArray(d.tipos) ? d.tipos.filter((t) => NOMES[t]) : central.tipos };
    $('avisoFechado').hidden = central.aceitando;
    if (etapa === 'confirmar') prepararConfirmacao();
  }).catch(() => {});

  try { history.replaceState({ etapa: 'busca' }, ''); } catch {}
  mostrarEndereco('busca');
  const aberta = Number(lido('vai-manu-corrida'));
  if (aberta) abrirCorrida(aberta);
  else irPara('busca', { historico: false });
})();
