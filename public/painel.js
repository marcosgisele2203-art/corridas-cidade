// Painel da central: corridas ao vivo, motoristas, relatório e configurações.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reais = (v) => (v == null ? '—' : 'R$ ' + Number(v).toFixed(2).replace('.', ','));
const hora = (d) => (d ? new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');
const hoje = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const TIPOS = { moto: 'Moto', carro: 'Carro', van: 'Van', caminhao: 'Caminhão' };
const veiculo = (m) => esc([m.carro, m.cor].filter(Boolean).join(' '));
// tela vazia com a Manu
const vazio = (titulo, texto) => `<div class="vazio"><img src="img/manu/manu-joinha.webp" alt=""><b>${titulo}</b>${texto ? `<span>${texto}</span>` : ''}</div>`;
const STATUS = {
  procurando: 'Procurando motorista', aceita: 'Motorista a caminho', chegou: 'Motorista chegou', em_andamento: 'Em andamento',
  finalizada: 'Finalizada', cancelada: 'Cancelada', sem_motorista: 'Sem motorista',
};

async function api(metodo, caminho, corpo) {
  const r = await fetch(caminho, { method: metodo, headers: corpo ? { 'Content-Type': 'application/json' } : {}, body: corpo ? JSON.stringify(corpo) : undefined });
  const dados = await r.json().catch(() => ({}));
  if (r.status === 401 && caminho !== '/api/login') { mostrarLogin(); throw new Error(dados.erro); }
  if (!r.ok) throw new Error(dados.erro || 'Erro ' + r.status);
  return dados;
}

// ---------------------------------------------------------------- login

function mostrarNomeNoLogin() {
  fetch('/api/marca').then((r) => r.json()).then((m) => { if (m.nome) { $('#nomeLogin').textContent = m.nome; document.title = 'Painel · ' + m.nome; } }).catch(() => {});
}

function mostrarLogin() { $('#app').hidden = true; $('#login').hidden = false; mostrarNomeNoLogin(); }
$('#formLogin').onsubmit = async (e) => {
  e.preventDefault();
  try { await api('POST', '/api/login', { senha: e.target.senha.value }); iniciar(); }
  catch (err) { $('#erroLogin').textContent = err.message; }
};
$('#sair').onclick = async () => { await api('POST', '/api/sair'); mostrarLogin(); };

// ---------------------------------------------------------------- abas

let aba = 'inicio';
function irPara(nova) {
  aba = nova;
  const noInicio = aba === 'inicio';
  $('#inicio').hidden = !noInicio;
  document.querySelector('#app > header').hidden = noInicio;
  document.querySelector('#app > main').hidden = noInicio;
  document.querySelectorAll('header nav button').forEach((x) => x.classList.toggle('ativa', x.dataset.aba === aba));
  document.querySelectorAll('main > section').forEach((s) => s.hidden = s.id !== 'aba-' + aba);
  try { location.hash = noInicio ? '' : aba; } catch { /* sem hash */ }
  window.scrollTo(0, 0);
  atualizar();
}
document.querySelectorAll('header nav button').forEach((b) => b.onclick = () => irPara(b.dataset.aba));

// ---- tela inicial: cartões de cada área, com avisos do que precisa de atenção
const AREAS = [
  { aba: 'corridas', icone: '🛣️', titulo: 'Viagens', texto: 'Ao vivo: quem pediu, qual motorista aceitou e as viagens em andamento. E todas as que já foram feitas.' },
  { aba: 'motoristas', icone: '', titulo: 'Motoristas', texto: 'Aprove cadastros, libere viagens compradas e veja quem está online.' },
  { aba: 'relatorio', icone: '📊', titulo: 'Relatório', texto: 'O geral da central e o individual de cada motorista, para imprimir ou mandar.' },
  { aba: 'divulgar', icone: '📣', titulo: 'Divulgar', texto: 'Links, QR Code, cartaz e as artes da Vai de Manu para postar.' },
  { aba: 'config', icone: '⚙️', titulo: 'Configurações', texto: 'Nome, cidade, preços, pacotes de viagens, Pix e Mercado Pago.' },
];
async function carregarInicio() {
  const cartoes = AREAS.map((a) => `
    <a class="painel-cartao" href="#${a.aba}" data-ir="${a.aba}">
      <span class="painel-topo"><span class="painel-icone">${a.icone}</span><span class="painel-aviso" id="aviso-${a.aba}"></span></span>
      <b>${a.titulo}</b><span class="painel-texto">${a.texto}</span>
      <span class="painel-abrir">Abrir <i>→</i></span>
    </a>`);
  cartoes.push(`
    <a class="painel-cartao" href="/motorista" target="_blank" rel="noopener">
      <span class="painel-topo"><span class="painel-icone"></span><span class="painel-aviso">Abre em outra aba</span></span>
      <b>Área do motorista</b><span class="painel-texto">A página onde o motorista se cadastra, compra viagens e vê o relatório dele.</span>
      <span class="painel-abrir">Ver como o motorista vê <i>→</i></span>
    </a>`);
  $('#paineis').innerHTML = cartoes.join('');
  // avisos (sem travar a tela se algum falhar)
  const aviso = (id, txt) => { const el = $('#aviso-' + id); if (el && txt) { el.textContent = txt; el.classList.add('alerta'); } };
  api('GET', '/api/corridas').then((l) => {
    const n = l.filter((c) => ['procurando', 'aceita', 'chegou', 'em_andamento'].includes(c.status)).length;
    aviso('corridas', n ? `${n} em andamento` : '');
  }).catch(() => {});
  Promise.all([api('GET', '/api/motoristas'), api('GET', '/api/compras')]).then(([m, c]) => {
    const p = m.filter((x) => !x.aprovado).length;
    aviso('motoristas', [p && `${p} para aprovar`, c.length && `${c.length} Pix`].filter(Boolean).join(' · '));
  }).catch(() => {});
}
$('#paineis').onclick = (e) => {
  const c = e.target.closest('[data-ir]');
  if (c) { e.preventDefault(); irPara(c.dataset.ir); }
};
$('#sairInicio').onclick = () => $('#sair').click();

function atualizar() {
  if (aba === 'inicio') carregarInicio();
  if (aba === 'corridas') carregarCorridas();
  if (aba === 'motoristas') carregarMotoristas();
  if (aba === 'relatorio') carregarRelatorio();
  if (aba === 'config') carregarConfig();
  if (aba === 'divulgar') carregarDivulgar();
}

// ---------------------------------------------------------------- corridas

// ---- viagens: quadro ao vivo (3 colunas), histórico com filtros e o passo a passo de cada uma
const ATIVAS = ['procurando', 'aceita', 'chegou', 'em_andamento'];
const desde = (d) => {
  if (!d) return '';
  const min = Math.max(0, Math.round((Date.now() - new Date(d)) / 60000));
  return min < 1 ? 'agora' : min < 60 ? `há ${min} min` : `há ${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
};
const duracao = (a, b) => {
  if (!a || !b) return '—';
  const min = Math.max(1, Math.round((new Date(b) - new Date(a)) / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
};
const veiculoDe = (v) => [v.carro, v.cor].filter(Boolean).join(' ');
const dataHora = (d) => (d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

function cartaoVivo(v) {
  let quem = '';
  if (v.status === 'procurando') {
    quem = v.oferta_nome
      ? `<div class="vivo-quem chamando">📞 Chamando <b>${esc(v.oferta_nome)}</b> · ${v.oferta_resta}s</div>`
      : '<div class="vivo-quem chamando">⏳ Esperando um motorista ficar livre</div>';
  } else {
    quem = `<div class="vivo-quem">👤 <b>${esc(v.motorista_nome || '')}</b> · ${esc(veiculoDe(v))} <b>${esc(v.placa || '')}</b></div>`;
  }
  const quando = v.status === 'procurando' ? `pediu ${desde(v.criado_em)}`
    : v.status === 'em_andamento' ? `em viagem ${desde(v.iniciada_em || v.aceita_em)}`
    : v.status === 'chegou' ? `📍 chegou ${desde(v.chegou_em)}` : `aceitou ${desde(v.aceita_em)}`;
  return `<div class="vivo" data-viagem="${v.id}">
    <div class="vivo-topo"><b>#${v.id} · ${esc(v.passageiro_nome || 'Passageiro')}</b><span class="vivo-tipo">${TIPOS[v.tipo] || ''}</span></div>
    <div class="vivo-trajeto">📍 ${esc(v.origem_texto)}<br>🏁 ${esc(v.destino_texto)}</div>
    ${quem}
    <div class="vivo-rodape"><span class="${v.status === 'chegou' ? 'chegou' : ''}">${quando}</span>
      <span>${reais(v.valor_final ?? v.valor_estimado)}</span></div>
    <div class="vivo-acoes"><a href="https://wa.me/${esc(v.passageiro_tel)}" target="_blank" rel="noopener">💬 Passageiro</a>
      ${v.motorista_tel ? `<a href="https://wa.me/${esc(v.motorista_tel)}" target="_blank" rel="noopener">💬 Motorista</a>` : ''}
      <button class="mini perigo" data-cancelar="${v.id}">Cancelar</button></div>
  </div>`;
}

// som de pedido novo (o navegador só deixa tocar depois de um clique na página)
let somLigado = false, ultimosPedidos = null;
try { somLigado = localStorage.getItem('somPedidos') === '1'; } catch { /* sem armazenamento */ }
const mostrarSom = () => { $('#som').textContent = somLigado ? '🔔 Som de pedido novo ligado' : '🔕 Ligar som de pedido novo'; };
mostrarSom();
$('#som').onclick = () => {
  somLigado = !somLigado; mostrarSom();
  try { localStorage.setItem('somPedidos', somLigado ? '1' : '0'); } catch { /* ok */ }
  if (somLigado) tocar();
};
function tocar() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.18, 0.36].forEach((t, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = [880, 1175, 1568][i]; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.25, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.16);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.17);
    });
  } catch { /* sem áudio */ }
}

let idsAoVivo = new Set();
async function carregarAoVivo() {
  const { ativas, hoje: h } = await api('GET', '/api/viagens/ao-vivo');
  diaCentral = h.dia;
  $('#kpisViagens').innerHTML = [
    ['Acontecendo agora', ativas.length], ['Finalizadas hoje', h.finalizadas], ['Faturamento hoje', reais(h.faturamento)],
    ['Perdidas hoje', h.perdidas], ['Motoristas online', h.online],
  ].map(([t, v]) => `<div class="kpi"><span>${t}</span><b>${v}</b></div>`).join('');
  const col = { procurando: [], caminho: [], viagem: [] };
  for (const v of ativas) col[v.status === 'procurando' ? 'procurando' : v.status === 'em_andamento' ? 'viagem' : 'caminho'].push(v);
  const vazioCol = { procurando: 'Nenhum pedido esperando 😊', caminho: 'Ninguém a caminho agora', viagem: 'Nenhuma viagem rolando' };
  for (const k of Object.keys(col)) {
    $('#col-' + k).innerHTML = col[k].map(cartaoVivo).join('') || `<p class="col-vazia">${vazioCol[k]}</p>`;
    $('#n-' + k).textContent = col[k].length;
  }
  $('#atualizado').textContent = 'atualizado ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  // pedido novo: toca o som; viagem que saiu do quadro: atualiza o histórico
  const pedidos = new Set(col.procurando.map((v) => v.id));
  if (ultimosPedidos && somLigado && [...pedidos].some((id) => !ultimosPedidos.has(id))) tocar();
  ultimosPedidos = pedidos;
  const agora = new Set(ativas.map((v) => v.id));
  // O histórico é atualizado junto com o quadro, inclusive se a viagem terminou em outra aba.
  idsAoVivo = agora;
}

let motoristasFiltro = false, diaCentral = null; // "hoje" no fuso da central (o navegador pode estar em outro)
async function carregarHistorico() {
  if (!$('#vDe').value) { $('#vDe').value = diaCentral || hoje(); $('#vAte').value = diaCentral || hoje(); }
  if (!motoristasFiltro) {
    motoristasFiltro = true;
    api('GET', '/api/motoristas').then((l) => {
      $('#vMotorista').innerHTML = '<option value="">Todos</option>' +
        l.filter((m) => m.aprovado).map((m) => `<option value="${m.id}">${esc(m.nome)}</option>`).join('');
    }).catch(() => { motoristasFiltro = false; });
  }
  const q = new URLSearchParams({ de: $('#vDe').value, ate: $('#vAte').value, status: $('#vStatus').value,
    motorista: $('#vMotorista').value, busca: $('#vBusca').value.trim() });
  const lista = await api('GET', '/api/viagens?' + q);
  const fin = lista.filter((v) => v.status === 'finalizada');
  $('#historico').innerHTML = lista.length ? `
    <p class="dica">${lista.length} viage${lista.length === 1 ? 'm' : 'ns'} · ${fin.length} finalizada${fin.length === 1 ? '' : 's'} ·
      total ${reais(fin.reduce((t, v) => t + Number(v.valor_final || 0), 0))}</p>
    <div class="tabela"><table class="historico">
      <tr><th>Quando</th><th>Passageiro</th><th>Trajeto</th><th>Motorista</th><th class="num">Valor</th><th class="num">Tempo</th><th>Situação</th></tr>
      ${lista.map((v) => `<tr data-viagem="${v.id}">
        <td>${dataHora(v.criado_em)}<br><small>#${v.id} · ${TIPOS[v.tipo] || ''}</small></td>
        <td>${esc(v.passageiro_nome || 'Passageiro')}</td>
        <td><small>📍 ${esc(v.origem_texto)}<br>🏁 ${esc(v.destino_texto)}</small></td>
        <td>${v.motorista_nome ? esc(v.motorista_nome) + `<br><small>${esc(v.placa || '')}</small>` : '—'}</td>
        <td class="num">${v.status === 'finalizada' ? reais(v.valor_final) : '—'}${v.avaliacao ? `<br><small>${'⭐'.repeat(v.avaliacao)}</small>` : ''}</td>
        <td class="num">${v.status === 'finalizada' ? duracao(v.criado_em, v.finalizada_em) : '—'}</td>
        <td><span class="etiqueta st-${v.status}">${STATUS[v.status]}</span></td></tr>`).join('')}
    </table></div>` : vazio('Nenhuma viagem neste período.', 'Troque as datas ou o filtro para ver outras viagens.');
}
let esperaBusca;
['#vDe', '#vAte', '#vStatus', '#vMotorista'].forEach((id) => $(id).onchange = carregarHistorico);
$('#vBusca').oninput = () => { clearTimeout(esperaBusca); esperaBusca = setTimeout(carregarHistorico, 350); };

let atualizandoCorridas = false;
async function carregarCorridas() {
  if (atualizandoCorridas) return;
  atualizandoCorridas = true;
  try {
    await carregarAoVivo();
    await carregarHistorico();
  } finally {
    atualizandoCorridas = false;
  }
}

// passo a passo de uma viagem
async function abrirViagem(id) {
  const v = await api('GET', `/api/viagens/${id}`);
  const passos = [
    [v.criado_em, '📲', `${esc(v.passageiro_nome || 'Passageiro')} pediu ${TIPOS[v.tipo] || 'uma viagem'}`],
    [v.chamados && v.chamados.length ? v.criado_em : null, '📞', `Motoristas chamados: ${(v.chamados || []).map(esc).join(' → ')}`],
    [v.aceita_em, '✅', `${esc(v.motorista_nome || 'Motorista')} aceitou`],
    [v.chegou_em, '📍', 'Motorista chegou no local'],
    [v.iniciada_em, '🛣️', 'Passageiro embarcou'],
    [v.finalizada_em, '🏁', `Viagem finalizada · ${reais(v.valor_final)}${v.avaliacao ? ' · ' + '⭐'.repeat(v.avaliacao) : ''}`],
    [v.cancelada_em, '❌', v.status === 'sem_motorista' ? 'Nenhum motorista disponível' : `Cancelada${v.cancelado_por ? ' pelo ' + (v.cancelado_por === 'central' ? 'painel da central' : v.cancelado_por) : ''}`],
  ].filter((p) => p[0]);
  const d = $('#detalheViagem');
  d.innerHTML = `
    <div class="linha"><h2>Viagem #${v.id}</h2><button class="sec mini" id="fecharViagem">Fechar ✕</button></div>
    <p><span class="etiqueta st-${v.status}">${STATUS[v.status]}</span> ${TIPOS[v.tipo] || ''}
      ${v.km ? ` · ${String(Number(v.km)).replace('.', ',')} km` : ''} · ${reais(v.valor_final ?? v.valor_estimado)}</p>
    <div class="det-grade">
      <div><small>Passageiro</small><b>${esc(v.passageiro_nome || 'Passageiro')}</b>
        <a href="https://wa.me/${esc(v.passageiro_tel)}" target="_blank" rel="noopener">💬 ${esc(v.passageiro_tel)}</a></div>
      <div><small>Motorista</small>${v.motorista_nome ? `<b>${esc(v.motorista_nome)}</b><span>${esc(veiculoDe(v))} · <b>${esc(v.placa || '')}</b></span>
        <a href="https://wa.me/${esc(v.motorista_tel)}" target="_blank" rel="noopener">💬 ${esc(v.motorista_tel)}</a>` : '<b>—</b>'}</div>
    </div>
    <p>📍 <b>Saída:</b> ${esc(v.origem_texto)}<br>🏁 <b>Destino:</b> ${esc(v.destino_texto)}</p>
    <ol class="linha-tempo">${passos.map(([t, ic, txt]) => `<li><span class="lt-icone">${ic}</span><div>${txt}<small>${dataHora(t)}</small></div></li>`).join('')}</ol>
    ${ATIVAS.includes(v.status) ? `<button class="perigo" data-cancelar="${v.id}">Cancelar esta viagem</button>` : ''}`;
  d.showModal();
  $('#fecharViagem').onclick = () => d.close();
}

// cliques: abrir viagem, cancelar
document.querySelector('#aba-corridas').addEventListener('click', async (e) => {
  if (e.target.closest('a')) return;
  const cancelar = e.target.dataset.cancelar;
  if (cancelar) {
    if (!confirm(`Cancelar a viagem #${cancelar}? O passageiro e o motorista serão avisados.`)) return;
    try { await api('POST', `/api/corridas/${cancelar}/cancelar`); $('#detalheViagem').close(); carregarCorridas(); } catch (err) { alert(err.message); }
    return;
  }
  const alvo = e.target.closest('[data-viagem]');
  if (alvo) abrirViagem(alvo.dataset.viagem).catch((err) => alert(err.message));
});
$('#detalheViagem').addEventListener('click', (e) => { if (e.target.id === 'detalheViagem') e.currentTarget.close(); });

// ---------------------------------------------------------------- motoristas

let motoristas = [];
async function carregarMotoristas() {
  const [todos, compras] = await Promise.all([api('GET', '/api/motoristas'), api('GET', '/api/compras')]);
  $('#compras').innerHTML = compras.map((c) => `
    <div class="cartao pendente">
      <b>💰 ${esc(c.motorista_nome)}</b> quer comprar <b>${c.quantidade} viagens</b> · <b>${reais(c.valor)}</b>
      <small>· pedido #${c.id} às ${hora(c.criado_em)} ${c.comprovante ? '· 📎 mandou comprovante' : '· sem comprovante ainda'}</small><br>
      <a href="https://wa.me/${esc(c.motorista_tel)}" target="_blank" rel="noopener">Ver no WhatsApp</a>
      <div class="linha"><button class="mini" data-confirmar="${c.id}">✅ Pix recebido, liberar viagens</button>
        <button class="mini sec" data-cancelarcompra="${c.id}">Cancelar pedido</button></div>
    </div>`).join('');
  const pendentes = todos.filter((m) => !m.aprovado);
  motoristas = todos.filter((m) => m.aprovado);
  $('#pendentes').innerHTML = pendentes.map((m) => `
    <div class="cartao pendente">
      <b>🆕 ${esc(m.nome)}</b> quer ser motorista<br>
      ${TIPOS[m.tipo] || ''} · ${veiculo(m)} · <b>${esc(m.placa)}</b> ·
      <a href="https://wa.me/${esc(m.telefone)}" target="_blank" rel="noopener">${esc(m.telefone)}</a>
      <div class="linha"><button class="mini" data-aprovar="${m.id}">✅ Aprovar</button>
        <button class="mini perigo" data-recusar="${m.id}">Recusar</button></div>
    </div>`).join('');
  $('#listaMotoristas').innerHTML = motoristas.length ? `<div class="tabela"><table>
    <tr><th>Motorista</th><th>Veículo</th><th>Situação</th><th class="num">Viagens</th><th class="num">Corridas</th><th class="num">Nota</th><th></th></tr>
    ${motoristas.map((m) => `<tr>
      <td><b>${esc(m.nome)}</b><br><small><a href="https://wa.me/${esc(m.telefone)}" target="_blank" rel="noopener">${esc(m.telefone)}</a></small></td>
      <td>${TIPOS[m.tipo] || ''}<br><small>${veiculo(m)} · ${esc(m.placa)}</small></td>
      <td>${!m.ativo ? '<span class="offline">Desativado</span>'
        : m.corrida_atual ? `<span class="online">Em corrida #${m.corrida_atual}</span>`
        : m.online ? '<span class="online">🟢 Online</span>' : '<span class="offline">🔴 Offline</span>'}</td>
      <td class="num"><b class="${m.creditos > 0 ? '' : 'sem-saldo'}">${m.creditos}</b></td>
      <td class="num">${m.corridas}</td>
      <td class="num">${m.nota ?? '—'}</td>
      <td><button class="mini sec" data-creditos="${m.id}">🎟️ Viagens</button>
        <button class="mini sec" data-editar="${m.id}">Editar</button>
        ${m.ativo ? `<button class="mini sec" data-online="${m.id}" data-valor="${!m.online}">${m.online ? 'Tirar do ar' : 'Pôr online'}</button>` : ''}</td>
    </tr>`).join('')}</table></div>`
    : vazio('Nenhum motorista ainda.', 'Peça para eles mandarem <b>CADASTRO</b> no WhatsApp da central (o link está na aba Divulgar), ou cadastre aqui.');
}
$('#compras').onclick = async (e) => {
  const { confirmar, cancelarcompra } = e.target.dataset;
  try {
    if (confirmar && confirm('Confirma que o Pix caiu na sua conta? As viagens entram na hora para o motorista.')) await api('POST', `/api/compras/${confirmar}/confirmar`);
    if (cancelarcompra && confirm('Cancelar esse pedido de compra?')) await api('POST', `/api/compras/${cancelarcompra}/cancelar`);
    carregarMotoristas();
  } catch (err) { alert(err.message); }
};
$('#pendentes').onclick = async (e) => {
  const { aprovar, recusar } = e.target.dataset;
  try {
    if (aprovar) await api('POST', `/api/motoristas/${aprovar}/aprovar`);
    if (recusar && confirm('Recusar esse cadastro? O motorista recebe um aviso no WhatsApp.')) await api('POST', `/api/motoristas/${recusar}/recusar`);
    carregarMotoristas();
  } catch (err) { alert(err.message); }
};

// paleta de cores: muda conforme o tipo de veículo escolhido
let CORES = null;
const EXEMPLO_MODELO = { moto: 'Honda Titan 160', carro: 'VW Gol', van: 'Sprinter', caminhao: 'Mercedes 710 baú' };
async function desenharPaleta() {
  const f = $('#formMotorista');
  f.carro.placeholder = EXEMPLO_MODELO[f.tipo.value] || '';
  if (!CORES) CORES = await api('GET', '/api/cores');
  const atual = f.cor.value.trim().toLowerCase();
  $('#paleta').innerHTML = (CORES[f.tipo.value] || []).map((c) => `
    <button type="button" class="cor${c.nome === atual ? ' escolhida' : ''}" data-cor="${esc(c.nome)}" title="${esc(c.nome)}">
      <span style="background:${c.hex}"></span>${esc(c.nome)}</button>`).join('');
}
$('#paleta').onclick = (e) => {
  const b = e.target.closest('[data-cor]');
  if (!b) return;
  $('#formMotorista').cor.value = b.dataset.cor;
  desenharPaleta();
};
$('#formMotorista').tipo.onchange = () => {
  // trocou carro ↔ moto: "branco" vira "branca" se for da paleta
  const f = $('#formMotorista'), atual = f.cor.value.trim().toLowerCase();
  if (CORES && atual) {
    for (const t of Object.keys(CORES)) {
      const i = CORES[t].findIndex((c) => c.nome === atual);
      const nova = i >= 0 && CORES[f.tipo.value].find((c) => c.hex === CORES[t][i].hex);
      if (nova) { f.cor.value = nova.nome; break; }
    }
  }
  desenharPaleta();
};
$('#formMotorista').cor.oninput = desenharPaleta;

function abrirFormMotorista(m = {}) {
  const f = $('#formMotorista');
  f.hidden = false;
  f.id.value = m.id || ''; f.nome.value = m.nome || ''; f.telefone.value = m.telefone || '';
  f.carro.value = m.carro || ''; f.cor.value = m.cor || ''; f.placa.value = m.placa || ''; f.ativo.checked = m.ativo !== false; f.tipo.value = m.tipo || 'carro';
  $('#erroMotorista').textContent = '';
  desenharPaleta();
  f.nome.focus();
}
$('#novoMotorista').onclick = () => abrirFormMotorista();
$('#cancelarMotorista').onclick = () => { $('#formMotorista').hidden = true; };
$('#listaMotoristas').onclick = async (e) => {
  const { editar, online, valor, creditos } = e.target.dataset;
  if (editar) abrirFormMotorista(motoristas.find((m) => m.id === Number(editar)));
  if (creditos) {
    const m = motoristas.find((x) => x.id === Number(creditos));
    const qtd = prompt(`${m.nome} tem ${m.creditos} viagens.\nQuantas viagens dar? (use número negativo para tirar, ex.: -2)`);
    if (!qtd) return;
    try { await api('POST', `/api/motoristas/${m.id}/creditos`, { quantidade: qtd }); carregarMotoristas(); } catch (err) { alert(err.message); }
  }
  if (online) { await api('POST', `/api/motoristas/${online}/online`, { online: valor === 'true' }); carregarMotoristas(); }
};
$('#formMotorista').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const corpo = { nome: f.nome.value, telefone: f.telefone.value, tipo: f.tipo.value, carro: f.carro.value, cor: f.cor.value, placa: f.placa.value, ativo: f.ativo.checked };
  try {
    await api(f.id.value ? 'PUT' : 'POST', '/api/motoristas' + (f.id.value ? '/' + f.id.value : ''), corpo);
    f.hidden = true;
    carregarMotoristas();
  } catch (err) { $('#erroMotorista').textContent = err.message; }
};

// ---------------------------------------------------------------- relatório

$('#relDe').onchange = $('#relAte').onchange = () => {
  $('#relIndividual').hidden = true; $('#relGeral').hidden = false;
  carregarRelatorio();
};
async function carregarRelatorio() {
  if (!$('#relDe').value) { $('#relDe').value = hoje().slice(0, 8) + '01'; $('#relAte').value = hoje(); }
  const r = await api('GET', `/api/resumo?de=${$('#relDe').value}&ate=${$('#relAte').value}`);
  $('#kpisRel').innerHTML = [
    ['Corridas finalizadas', r.total.finalizadas], ['Canceladas', r.total.canceladas], ['Sem motorista', r.total.sem_motorista],
    ['Faturamento das corridas', reais(r.total.faturamento)], ['Comissão da central', reais(r.total.comissao)],
    ['Venda de viagens', reais(r.vendas.valor)], ['Viagens vendidas', r.vendas.viagens],
  ].map(([t, v]) => `<div class="kpi"><span>${t}</span><b>${v}</b></div>`).join('');
  relMotoristas = r.motoristas;
  const comComissao = r.motoristas.some((m) => m.comissao > 0);
  $('#tabelaRel').innerHTML = r.motoristas.length ? `<div class="tabela"><table>
    <tr><th>Motorista</th><th>Veículo</th><th class="num">Corridas</th><th class="num">Total das corridas</th>
      ${comComissao ? '<th class="num">Comissão</th>' : ''}<th class="num">Nota</th><th class="num">Saldo</th><th class="nao-imprimir"></th></tr>
    ${r.motoristas.map((m) => `<tr><td><b>${esc(m.nome)}</b></td><td>${TIPOS[m.tipo] || ''}</td><td class="num">${m.corridas}</td>
      <td class="num">${reais(m.faturamento)}</td>${comComissao ? `<td class="num">${reais(m.comissao)}</td>` : ''}
      <td class="num">${m.nota ?? '—'}</td><td class="num">${m.saldo}</td>
      <td class="nao-imprimir"><button class="mini" data-ver="${m.id}">📄 Ver</button>
        <button class="mini sec" data-enviar="${m.id}">📲 Enviar</button></td></tr>`).join('')}
  </table></div>` : vazio('Nenhum motorista aprovado ainda.', 'Aprove os cadastros na aba Motoristas.');
}

// ---- relatório individual
let relMotoristas = [];
const periodoRel = () => ({ de: $('#relDe').value, ate: $('#relAte').value });
const dataBR = (iso) => iso.split('-').reverse().join('/');

async function enviarRelatorios(ids, quem) {
  if (!confirm(`Mandar o relatório de ${dataBR(periodoRel().de)} a ${dataBR(periodoRel().ate)} no WhatsApp de ${quem}?`)) return;
  try {
    const r = await api('POST', '/api/relatorios/enviar', { ...periodoRel(), ids });
    alert(r.enviados > 1 ? `Enviando para ${r.enviados} motoristas (um a cada 3 segundos, termina em cerca de ${Math.ceil(r.segundos / 60) || 1} min).` : 'Relatório enviado! ✅');
  } catch (err) { alert(err.message); }
}

async function abrirIndividual(id) {
  const { de, ate } = periodoRel();
  const r = await api('GET', `/api/motoristas/${id}/relatorio?de=${de}&ate=${ate}`);
  const t = r.totais, v = r.viagens, mo = r.motorista;
  const caixa = $('#relIndividual');
  caixa.innerHTML = `
    <div class="linha nao-imprimir">
      <button class="sec" id="voltarGeral">← Voltar ao geral</button>
      <span><button id="enviarUm">📲 Enviar no WhatsApp</button> <button class="sec" id="imprimirUm">🖨️ Imprimir / PDF</button></span>
    </div>
    <h2>📊 ${esc(mo.nome)}</h2>
    <p>${TIPOS[mo.tipo] || ''} · ${esc(mo.veiculo)} · <b>${esc(mo.placa)}</b> · ${esc(mo.telefone)}<br>
      Período: <b>${dataBR(de)}</b>${de !== ate ? ` a <b>${dataBR(ate)}</b>` : ''}</p>
    <div class="kpis">
      ${[['Corridas feitas', t.finalizadas], ['Canceladas', t.canceladas], ['Total das corridas', reais(t.ganhos)],
        ['Distância', t.km.toFixed(1).replace('.', ',') + ' km'], ['Nota média', t.nota ? String(t.nota).replace('.', ',') + ' ⭐' : '—'],
        ['Viagens compradas', v.compradas], ['Viagens usadas', v.usadas], ['Saldo atual', mo.saldo]]
        .map(([n, x]) => `<div class="kpi"><span>${n}</span><b>${x}</b></div>`).join('')}
    </div>
    ${v.pago ? `<p class="dica">Pago à central por viagens no período: <b>${reais(v.pago)}</b>${v.bonus ? ` · grátis: ${v.bonus}` : ''}${v.ajustes ? ` · ajustes: ${v.ajustes}` : ''}</p>` : ''}
    ${r.corridas.length ? `<div class="tabela"><table>
      <tr><th>Quando</th><th>Saída → Destino</th><th class="num">Km</th><th class="num">Valor</th><th class="num">Nota</th><th>Situação</th></tr>
      ${r.corridas.map((c) => `<tr><td>${c.quando}</td><td>${esc(c.origem_texto)} → ${esc(c.destino_texto)}</td>
        <td class="num">${c.km ? String(Number(c.km)).replace('.', ',') : '—'}</td><td class="num">${c.status === 'finalizada' ? reais(c.valor_final) : '—'}</td>
        <td class="num">${c.avaliacao ? c.avaliacao + '⭐' : '—'}</td><td>${STATUS[c.status]}</td></tr>`).join('')}
    </table></div>` : vazio('Nenhuma corrida no período.', '')}`;
  $('#relGeral').hidden = true; caixa.hidden = false;
  window.scrollTo(0, 0);
  $('#voltarGeral').onclick = () => { caixa.hidden = true; $('#relGeral').hidden = false; };
  $('#enviarUm').onclick = () => enviarRelatorios([mo.id], mo.nome);
  $('#imprimirUm').onclick = () => window.print();
}

$('#tabelaRel').onclick = (e) => {
  const { ver, enviar } = e.target.dataset;
  if (ver) abrirIndividual(Number(ver)).catch((err) => alert(err.message));
  if (enviar) enviarRelatorios([Number(enviar)], relMotoristas.find((m) => m.id === Number(enviar)).nome);
};
$('#enviarTodos').onclick = () => {
  if (!relMotoristas.length) return alert('Nenhum motorista para enviar.');
  enviarRelatorios(relMotoristas.map((m) => m.id), `todos os ${relMotoristas.length} motoristas`);
};
$('#imprimirGeral').onclick = () => window.print();

// ---------------------------------------------------------------- divulgar

const ARTES = [
  { arquivo: 'todos-os-veiculos', titulo: 'Todos os veículos', uso: 'Lançamento, cartaz impresso e status (vertical)' },
  { arquivo: 'carro-e-moto', titulo: 'Carro e moto', uso: 'Status e stories (vertical)' },
  { arquivo: 'moto', titulo: 'Moto', uso: 'Feed do Instagram/Facebook e grupos (quadrada)' },
  { arquivo: 'frete', titulo: 'Frete / caminhão', uso: 'Grupos de mudança, compra e venda (quadrada)' },
];
$('#artes').innerHTML = ARTES.map((a) => `
  <figure class="arte">
    <a href="artes/${a.arquivo}.jpg" target="_blank" rel="noopener"><img src="artes/${a.arquivo}.jpg" alt="Arte ${a.titulo}" loading="lazy"></a>
    <figcaption><b>${a.titulo}</b><br><small>${a.uso}</small></figcaption>
    <a class="botao" href="artes/${a.arquivo}.jpg" download="vai-de-manu-${a.arquivo}.jpg">⬇️ Baixar</a>
  </figure>`).join('');

const foneBR = (n) => { const d = String(n).replace(/^55/, ''); return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}` : n; };
async function carregarDivulgar() {
  const d = await api('GET', '/api/divulgar');
  const caixa = $('#divulgar');
  if (!d.numero) {
    caixa.innerHTML = `<p class="vazio">Não consegui descobrir o número da central pela Evolution.<br>
      Preencha <b>WhatsApp da central</b> em Configurações e volte aqui.</p>`;
    return;
  }
  const textoPassageiro = ` *${d.nome}*\nPrecisa de uma corrida? Peça pelo WhatsApp, rapidinho!\n Moto ·  Carro ·  Van ·  Frete\n\n👉 ${d.passageiro}\n📞 ${foneBR(d.numero)}`;
  const textoMotorista = ` *${d.nome}* está cadastrando motoristas!\nMoto, carro, van ou caminhão. Cadastro pelo WhatsApp em 1 minuto.\n\n👉 ${d.motorista}`;
  caixa.innerHTML = `
    <div class="cartao divulga nao-imprimir">
      <h3>👥 Para passageiros</h3>
      <div class="divulga-grade">
        <div class="qr">${d.qr_passageiro}</div>
        <div>
          <label>Link (abre o WhatsApp com "Oi! Quero uma corrida")</label>
          <div class="copiar"><input readonly value="${esc(d.passageiro)}"><button class="mini" data-copiar="${esc(d.passageiro)}">Copiar link</button></div>
          <label>Texto pronto para grupos, status, Instagram e Facebook</label>
          <textarea readonly rows="7">${esc(textoPassageiro)}</textarea>
          <div class="linha"><button class="mini" data-copiar="${esc(textoPassageiro)}">Copiar texto</button>
            <button class="mini sec" id="imprimirCartaz">🖨️ Imprimir cartaz com QR Code</button></div>
        </div>
      </div>
    </div>
    <div class="cartao divulga nao-imprimir">
      <h3> Para motoristas</h3>
      <div class="divulga-grade">
        <div class="qr">${d.qr_motorista}</div>
        <div>
          <label>Link (abre o WhatsApp já com "CADASTRO")</label>
          <div class="copiar"><input readonly value="${esc(d.motorista)}"><button class="mini" data-copiar="${esc(d.motorista)}">Copiar link</button></div>
          <label>Texto pronto</label>
          <textarea readonly rows="5">${esc(textoMotorista)}</textarea>
          <div class="linha"><button class="mini" data-copiar="${esc(textoMotorista)}">Copiar texto</button></div>
        </div>
      </div>
    </div>
    <div class="cartaz">
      <h1> ${esc(d.nome)}</h1>
      <p class="cartaz-sub">Peça sua corrida pelo WhatsApp</p>
      <p class="cartaz-tipos"> Moto ·  Carro ·  Van ·  Frete</p>
      <div class="qr">${d.qr_passageiro}</div>
      <p class="cartaz-passo">Aponte a câmera do celular aqui 👆</p>
      <p class="cartaz-fone">ou chame no WhatsApp<br><b>${foneBR(d.numero)}</b></p>
    </div>`;
  $('#imprimirCartaz').onclick = () => { document.body.classList.add('imprimindo-cartaz'); window.print(); document.body.classList.remove('imprimindo-cartaz'); };
}
$('#divulgar').onclick = async (e) => {
  const t = e.target.dataset.copiar;
  if (!t) return;
  try { await navigator.clipboard.writeText(t); } catch {
    const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove();
  }
  const antes = e.target.textContent; e.target.textContent = '✅ Copiado!'; setTimeout(() => e.target.textContent = antes, 1500);
};

// ---------------------------------------------------------------- configurações

const CAMPOS = ['nome', 'cidade', 'numero_admin', 'numero_central', 'arte_boas_vindas', 'comissao_pct', 'oferta_segundos', 'fator_rota',
  'creditos_boas_vindas', 'pix_chave', 'pix_nome'];
const reaisCurto = (v) => 'R$ ' + (Math.ceil(v * 2) / 2).toFixed(2).replace('.', ',');
async function carregarConfig() {
  const c = await api('GET', '/api/config');
  const f = $('#formConfig');
  CAMPOS.forEach((k) => f[k].value = c[k] ?? '');
  f.aceitando.checked = !!c.aceitando;
  f.aprovar_automatico.checked = !!c.aprovar_automatico;
  f.cobranca_ativa.checked = !!c.cobranca_ativa;
  f.mp_ativo.checked = c.mp_ativo !== false;
  $('#mpSituacao').textContent = c.mp_configurado ? '· ✅ conectado' : '· ⚠️ falta o MP_ACCESS_TOKEN no Easypanel';
  desenharPacotes(c.pacotes || []);
  $('#tabelaPrecos').innerHTML = `<tr><th>Oferecer</th><th>Veículo</th><th>Taxa base</th><th>Por km</th><th>Mínimo</th><th>3 km</th><th>10 km</th></tr>` +
    Object.keys(TIPOS).map((t) => `<tr data-tipo="${t}">
      <td><input type="checkbox" data-c="ativo" ${c.precos[t].ativo ? 'checked' : ''}></td>
      <td>${TIPOS[t]}</td>
      <td><input type="number" step="0.5" min="0" data-c="taxa_base" value="${c.precos[t].taxa_base}"></td>
      <td><input type="number" step="0.1" min="0" data-c="por_km" value="${c.precos[t].por_km}"></td>
      <td><input type="number" step="0.5" min="0" data-c="minimo" value="${c.precos[t].minimo}"></td>
      <td class="ex3"></td><td class="ex10"></td></tr>`).join('');
  simular();
}
// ---- pacotes de viagens: quantidade + preço; valor de cada viagem e desconto calculados
function desenharPacotes(lista) {
  $('#tabelaPacotes').innerHTML = `<tr><th>Viagens</th><th>Preço do pacote (R$)</th><th class="num">Cada viagem</th><th class="num">Desconto</th><th></th></tr>` +
    lista.map((p) => `<tr class="pacote">
      <td><input type="number" min="1" step="1" data-p="qtd" value="${p.qtd ?? ''}" placeholder="10"></td>
      <td><input type="number" min="0" step="0.5" data-p="preco" value="${p.preco ?? ''}" placeholder="9,50"></td>
      <td class="num cada"></td><td class="num desc"></td>
      <td><button type="button" class="mini sec" data-remover>Remover</button></td></tr>`).join('');
  calcularPacotes();
}
function lerPacotes() {
  return [...document.querySelectorAll('#tabelaPacotes tr.pacote')].map((tr) => ({
    qtd: tr.querySelector('[data-p=qtd]').value, preco: tr.querySelector('[data-p=preco]').value,
  })).filter((p) => p.qtd !== '' || p.preco !== '');
}
function calcularPacotes() {
  const linhas = [...document.querySelectorAll('#tabelaPacotes tr.pacote')];
  const cada = linhas.map((tr) => Number(tr.querySelector('[data-p=preco]').value) / Number(tr.querySelector('[data-p=qtd]').value));
  const cheio = Math.max(0, ...cada.filter((v) => Number.isFinite(v) && v > 0));
  linhas.forEach((tr, i) => {
    const ok = Number.isFinite(cada[i]) && cada[i] > 0;
    tr.querySelector('.cada').textContent = ok ? reais(cada[i]) : '—';
    const d = ok && cheio ? Math.round((1 - cada[i] / cheio) * 100) : 0;
    tr.querySelector('.desc').innerHTML = d > 0 ? `<b class="desconto">${d}% off</b>` : '—';
  });
}
$('#tabelaPacotes').oninput = calcularPacotes;
$('#tabelaPacotes').onclick = (e) => { if ('remover' in e.target.dataset) { e.target.closest('tr').remove(); calcularPacotes(); } };
$('#maisPacote').onclick = () => {
  desenharPacotes([...lerPacotes(), {}]);
  const ultimas = document.querySelectorAll('#tabelaPacotes [data-p=qtd]');
  ultimas[ultimas.length - 1].focus();
};

function lerPrecos() {
  const precos = {};
  document.querySelectorAll('#tabelaPrecos tr[data-tipo]').forEach((tr) => {
    const v = (c) => tr.querySelector(`[data-c=${c}]`);
    precos[tr.dataset.tipo] = { ativo: v('ativo').checked, taxa_base: v('taxa_base').value, por_km: v('por_km').value, minimo: v('minimo').value };
  });
  return precos;
}
function simular() {
  const precos = lerPrecos();
  document.querySelectorAll('#tabelaPrecos tr[data-tipo]').forEach((tr) => {
    const p = precos[tr.dataset.tipo];
    const v = (km) => reaisCurto(Math.max(Number(p.minimo), Number(p.taxa_base) + km * Number(p.por_km)));
    tr.querySelector('.ex3').textContent = v(3);
    tr.querySelector('.ex10').textContent = v(10);
  });
}
$('#formConfig').oninput = simular;
$('#formConfig').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, corpo = {
    aceitando: f.aceitando.checked, aprovar_automatico: f.aprovar_automatico.checked,
    cobranca_ativa: f.cobranca_ativa.checked, mp_ativo: f.mp_ativo.checked, pacotes: lerPacotes(), precos: lerPrecos(),
  };
  CAMPOS.forEach((k) => corpo[k] = f[k].value);
  try {
    const c = await api('PUT', '/api/config', corpo);
    $('#nomeCentral').textContent = c.nome;
    $('#okConfig').textContent = '✅ Salvo!';
    setTimeout(() => $('#okConfig').textContent = '', 3000);
  } catch (err) { alert(err.message); }
};

// ---------------------------------------------------------------- início

async function iniciar() {
  try {
    const c = await api('GET', '/api/config');
    $('#nomeCentral').textContent = c.nome;
    document.querySelectorAll('.nome-central').forEach((el) => el.textContent = c.nome);
    if (c.cidade) $('#cidadeInicio').textContent = c.cidade;
    $('#login').hidden = true; $('#app').hidden = false;
    const pedida = (location.hash || '').slice(1);
    irPara(AREAS.some((a) => a.aba === pedida) ? pedida : 'inicio');
  } catch { /* mostrarLogin já foi chamado */ }
}
setInterval(() => { if (!$('#app').hidden && aba === 'corridas' && !document.hidden) carregarCorridas().catch(() => {}); }, 5000);
iniciar();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('#app').hidden && aba === 'corridas') carregarCorridas().catch(() => {});
});
window.addEventListener('focus', () => {
  if (!document.hidden && !$('#app').hidden && aba === 'corridas') carregarCorridas().catch(() => {});
});
