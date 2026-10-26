// Painel da central: corridas ao vivo, motoristas, relatório e configurações.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reais = (v) => (v == null ? '—' : 'R$ ' + Number(v).toFixed(2).replace('.', ','));
const hora = (d) => (d ? new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');
const hoje = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const TIPOS = { moto: '🏍️ Moto', carro: '🚗 Carro', van: '🚐 Van', caminhao: '🚚 Caminhão' };
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

function mostrarLogin() { $('#app').hidden = true; $('#login').hidden = false; }
$('#formLogin').onsubmit = async (e) => {
  e.preventDefault();
  try { await api('POST', '/api/login', { senha: e.target.senha.value }); iniciar(); }
  catch (err) { $('#erroLogin').textContent = err.message; }
};
$('#sair').onclick = async () => { await api('POST', '/api/sair'); mostrarLogin(); };

// ---------------------------------------------------------------- abas

let aba = 'corridas';
document.querySelectorAll('header nav button').forEach((b) => b.onclick = () => {
  aba = b.dataset.aba;
  document.querySelectorAll('header nav button').forEach((x) => x.classList.toggle('ativa', x === b));
  document.querySelectorAll('main > section').forEach((s) => s.hidden = s.id !== 'aba-' + aba);
  atualizar();
});

function atualizar() {
  if (aba === 'corridas') carregarCorridas();
  if (aba === 'motoristas') carregarMotoristas();
  if (aba === 'relatorio') carregarRelatorio();
  if (aba === 'config') carregarConfig();
}

// ---------------------------------------------------------------- corridas

$('#diaCorridas').onchange = carregarCorridas;
async function carregarCorridas() {
  const dia = $('#diaCorridas').value;
  const lista = await api('GET', '/api/corridas' + (dia && dia !== hoje() ? '?dia=' + dia : ''));
  const ativas = lista.filter((c) => ['procurando', 'aceita', 'chegou', 'em_andamento'].includes(c.status));
  const fin = lista.filter((c) => c.status === 'finalizada');
  $('#kpisAgora').innerHTML = [
    ['Em andamento', ativas.length], ['Finalizadas', fin.length],
    ['Faturamento', reais(fin.reduce((s, c) => s + Number(c.valor_final || 0), 0))],
    ['Comissão', reais(fin.reduce((s, c) => s + Number(c.comissao || 0), 0))],
  ].map(([t, v]) => `<div class="kpi"><span>${t}</span><b>${v}</b></div>`).join('');

  $('#listaCorridas').innerHTML = lista.length ? lista.map((c) => `
    <div class="cartao corrida">
      <div class="topo">
        <b>#${c.id} · ${esc(c.passageiro_nome || 'Passageiro')} <small>${TIPOS[c.tipo] || ''} · ${hora(c.criado_em)}</small></b>
        <span class="etiqueta st-${c.status}">${STATUS[c.status] || c.status}</span>
      </div>
      <div>📍 ${esc(c.origem_texto)}</div>
      <div>🏁 ${esc(c.destino_texto)}</div>
      <small>
        ${c.motorista_nome ? '🚗 ' + esc(c.motorista_nome) + ' · ' : ''}
        ${reais(c.valor_final ?? c.valor_estimado)}${c.km ? ' · ' + String(Number(c.km)).replace('.', ',') + ' km' : ''}
        ${c.avaliacao ? ' · ' + '⭐'.repeat(c.avaliacao) : ''}
        · <a href="https://wa.me/${esc(c.passageiro_tel)}" target="_blank" rel="noopener">WhatsApp do passageiro</a>
      </small>
      ${['procurando', 'aceita', 'chegou', 'em_andamento'].includes(c.status)
        ? `<div><button class="mini perigo" data-cancelar="${c.id}">Cancelar corrida</button></div>` : ''}
    </div>`).join('') : '<p class="vazio">Nenhuma corrida por enquanto.</p>';
}
$('#listaCorridas').onclick = async (e) => {
  const id = e.target.dataset.cancelar;
  if (!id || !confirm(`Cancelar a corrida #${id}? O passageiro e o motorista serão avisados.`)) return;
  try { await api('POST', `/api/corridas/${id}/cancelar`); carregarCorridas(); } catch (err) { alert(err.message); }
};

// ---------------------------------------------------------------- motoristas

let motoristas = [];
async function carregarMotoristas() {
  const todos = await api('GET', '/api/motoristas');
  const pendentes = todos.filter((m) => !m.aprovado);
  motoristas = todos.filter((m) => m.aprovado);
  $('#pendentes').innerHTML = pendentes.map((m) => `
    <div class="cartao pendente">
      <b>🆕 ${esc(m.nome)}</b> quer ser motorista<br>
      ${TIPOS[m.tipo] || ''} · ${esc(m.carro)} · <b>${esc(m.placa)}</b> ·
      <a href="https://wa.me/${esc(m.telefone)}" target="_blank" rel="noopener">${esc(m.telefone)}</a>
      <div class="linha"><button class="mini" data-aprovar="${m.id}">✅ Aprovar</button>
        <button class="mini perigo" data-recusar="${m.id}">Recusar</button></div>
    </div>`).join('');
  $('#listaMotoristas').innerHTML = motoristas.length ? `<div class="tabela"><table>
    <tr><th>Motorista</th><th>Veículo</th><th>Situação</th><th class="num">Corridas</th><th class="num">Nota</th><th></th></tr>
    ${motoristas.map((m) => `<tr>
      <td><b>${esc(m.nome)}</b><br><small><a href="https://wa.me/${esc(m.telefone)}" target="_blank" rel="noopener">${esc(m.telefone)}</a></small></td>
      <td>${TIPOS[m.tipo] || ''}<br><small>${esc(m.carro)} · ${esc(m.placa)}</small></td>
      <td>${!m.ativo ? '<span class="offline">Desativado</span>'
        : m.corrida_atual ? `<span class="online">Em corrida #${m.corrida_atual}</span>`
        : m.online ? '<span class="online">🟢 Online</span>' : '<span class="offline">🔴 Offline</span>'}</td>
      <td class="num">${m.corridas}</td>
      <td class="num">${m.nota ?? '—'}</td>
      <td><button class="mini sec" data-editar="${m.id}">Editar</button>
        ${m.ativo ? `<button class="mini sec" data-online="${m.id}" data-valor="${!m.online}">${m.online ? 'Tirar do ar' : 'Pôr online'}</button>` : ''}</td>
    </tr>`).join('')}</table></div>`
    : '<p class="vazio">Nenhum motorista ainda. Peça para eles mandarem <b>CADASTRO</b> no WhatsApp da central, ou cadastre aqui.</p>';
}
$('#pendentes').onclick = async (e) => {
  const { aprovar, recusar } = e.target.dataset;
  try {
    if (aprovar) await api('POST', `/api/motoristas/${aprovar}/aprovar`);
    if (recusar && confirm('Recusar esse cadastro? O motorista recebe um aviso no WhatsApp.')) await api('POST', `/api/motoristas/${recusar}/recusar`);
    carregarMotoristas();
  } catch (err) { alert(err.message); }
};

function abrirFormMotorista(m = {}) {
  const f = $('#formMotorista');
  f.hidden = false;
  f.id.value = m.id || ''; f.nome.value = m.nome || ''; f.telefone.value = m.telefone || '';
  f.carro.value = m.carro || ''; f.placa.value = m.placa || ''; f.ativo.checked = m.ativo !== false; f.tipo.value = m.tipo || 'carro';
  $('#erroMotorista').textContent = '';
  f.nome.focus();
}
$('#novoMotorista').onclick = () => abrirFormMotorista();
$('#cancelarMotorista').onclick = () => { $('#formMotorista').hidden = true; };
$('#listaMotoristas').onclick = async (e) => {
  const { editar, online, valor } = e.target.dataset;
  if (editar) abrirFormMotorista(motoristas.find((m) => m.id === Number(editar)));
  if (online) { await api('POST', `/api/motoristas/${online}/online`, { online: valor === 'true' }); carregarMotoristas(); }
};
$('#formMotorista').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const corpo = { nome: f.nome.value, telefone: f.telefone.value, tipo: f.tipo.value, carro: f.carro.value, placa: f.placa.value, ativo: f.ativo.checked };
  try {
    await api(f.id.value ? 'PUT' : 'POST', '/api/motoristas' + (f.id.value ? '/' + f.id.value : ''), corpo);
    f.hidden = true;
    carregarMotoristas();
  } catch (err) { $('#erroMotorista').textContent = err.message; }
};

// ---------------------------------------------------------------- relatório

$('#relDe').onchange = $('#relAte').onchange = carregarRelatorio;
async function carregarRelatorio() {
  if (!$('#relDe').value) { $('#relDe').value = hoje().slice(0, 8) + '01'; $('#relAte').value = hoje(); }
  const r = await api('GET', `/api/resumo?de=${$('#relDe').value}&ate=${$('#relAte').value}`);
  $('#kpisRel').innerHTML = [
    ['Corridas finalizadas', r.total.finalizadas], ['Canceladas', r.total.canceladas], ['Sem motorista', r.total.sem_motorista],
    ['Faturamento', reais(r.total.faturamento)], ['Comissão da central', reais(r.total.comissao)],
  ].map(([t, v]) => `<div class="kpi"><span>${t}</span><b>${v}</b></div>`).join('');
  $('#tabelaRel').innerHTML = r.motoristas.length ? `<div class="tabela"><table>
    <tr><th>Motorista</th><th>Veículo</th><th class="num">Corridas</th><th class="num">Faturamento</th><th class="num">Comissão a receber</th><th class="num">Nota</th></tr>
    ${r.motoristas.map((m) => `<tr><td>${esc(m.nome)}</td><td>${TIPOS[m.tipo] || ''}</td><td class="num">${m.corridas}</td><td class="num">${reais(m.faturamento)}</td>
      <td class="num"><b>${reais(m.comissao)}</b></td><td class="num">${m.nota ?? '—'}</td></tr>`).join('')}
  </table></div>` : '<p class="vazio">Nenhuma corrida finalizada no período.</p>';
}

// ---------------------------------------------------------------- configurações

const CAMPOS = ['nome', 'cidade', 'numero_admin', 'comissao_pct', 'oferta_segundos', 'fator_rota'];
const reaisCurto = (v) => 'R$ ' + (Math.ceil(v * 2) / 2).toFixed(2).replace('.', ',');
async function carregarConfig() {
  const c = await api('GET', '/api/config');
  const f = $('#formConfig');
  CAMPOS.forEach((k) => f[k].value = c[k] ?? '');
  f.aceitando.checked = !!c.aceitando;
  f.aprovar_automatico.checked = !!c.aprovar_automatico;
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
  const f = e.target, corpo = { aceitando: f.aceitando.checked, aprovar_automatico: f.aprovar_automatico.checked, precos: lerPrecos() };
  CAMPOS.forEach((k) => corpo[k] = f[k].value);
  try {
    const c = await api('PUT', '/api/config', corpo);
    $('#nomeCentral').textContent = '🚗 ' + c.nome;
    $('#okConfig').textContent = '✅ Salvo!';
    setTimeout(() => $('#okConfig').textContent = '', 3000);
  } catch (err) { alert(err.message); }
};

// ---------------------------------------------------------------- início

async function iniciar() {
  try {
    const c = await api('GET', '/api/config');
    $('#nomeCentral').textContent = '🚗 ' + c.nome;
    $('#login').hidden = true; $('#app').hidden = false;
    $('#diaCorridas').value = hoje();
    atualizar();
  } catch { /* mostrarLogin já foi chamado */ }
}
setInterval(() => { if (!$('#app').hidden && aba === 'corridas' && !document.hidden) carregarCorridas().catch(() => {}); }, 5000);
iniciar();
