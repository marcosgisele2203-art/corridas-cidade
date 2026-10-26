// Painel da central: corridas ao vivo, motoristas, relatório e configurações.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reais = (v) => (v == null ? '—' : 'R$ ' + Number(v).toFixed(2).replace('.', ','));
const hora = (d) => (d ? new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');
const hoje = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
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
        <b>#${c.id} · ${esc(c.passageiro_nome || 'Passageiro')} <small>${hora(c.criado_em)}</small></b>
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
  motoristas = await api('GET', '/api/motoristas');
  $('#listaMotoristas').innerHTML = motoristas.length ? `<div class="tabela"><table>
    <tr><th>Motorista</th><th>Carro</th><th>Situação</th><th class="num">Corridas</th><th class="num">Nota</th><th></th></tr>
    ${motoristas.map((m) => `<tr>
      <td><b>${esc(m.nome)}</b><br><small><a href="https://wa.me/${esc(m.telefone)}" target="_blank" rel="noopener">${esc(m.telefone)}</a></small></td>
      <td>${esc(m.carro)}<br><small>${esc(m.placa)}</small></td>
      <td>${!m.ativo ? '<span class="offline">Desativado</span>'
        : m.corrida_atual ? `<span class="online">Em corrida #${m.corrida_atual}</span>`
        : m.online ? '<span class="online">🟢 Online</span>' : '<span class="offline">🔴 Offline</span>'}</td>
      <td class="num">${m.corridas}</td>
      <td class="num">${m.nota ?? '—'}</td>
      <td><button class="mini sec" data-editar="${m.id}">Editar</button>
        ${m.ativo ? `<button class="mini sec" data-online="${m.id}" data-valor="${!m.online}">${m.online ? 'Tirar do ar' : 'Pôr online'}</button>` : ''}</td>
    </tr>`).join('')}</table></div>`
    : '<p class="vazio">Cadastre o primeiro motorista. Depois ele manda <b>ONLINE</b> para o WhatsApp da central.</p>';
}

function abrirFormMotorista(m = {}) {
  const f = $('#formMotorista');
  f.hidden = false;
  f.id.value = m.id || ''; f.nome.value = m.nome || ''; f.telefone.value = m.telefone || '';
  f.carro.value = m.carro || ''; f.placa.value = m.placa || ''; f.ativo.checked = m.ativo !== false;
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
  const corpo = { nome: f.nome.value, telefone: f.telefone.value, carro: f.carro.value, placa: f.placa.value, ativo: f.ativo.checked };
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
    <tr><th>Motorista</th><th class="num">Corridas</th><th class="num">Faturamento</th><th class="num">Comissão a receber</th><th class="num">Nota</th></tr>
    ${r.motoristas.map((m) => `<tr><td>${esc(m.nome)}</td><td class="num">${m.corridas}</td><td class="num">${reais(m.faturamento)}</td>
      <td class="num"><b>${reais(m.comissao)}</b></td><td class="num">${m.nota ?? '—'}</td></tr>`).join('')}
  </table></div>` : '<p class="vazio">Nenhuma corrida finalizada no período.</p>';
}

// ---------------------------------------------------------------- configurações

const CAMPOS = ['nome', 'cidade', 'numero_admin', 'taxa_base', 'por_km', 'minimo', 'comissao_pct', 'oferta_segundos', 'fator_rota'];
async function carregarConfig() {
  const c = await api('GET', '/api/config');
  const f = $('#formConfig');
  CAMPOS.forEach((k) => f[k].value = c[k] ?? '');
  f.aceitando.checked = !!c.aceitando;
  simular();
}
function simular() {
  const f = $('#formConfig');
  const v = (km) => Math.ceil(Math.max(Number(f.minimo.value), Number(f.taxa_base.value) + km * Number(f.por_km.value)) * 2) / 2;
  $('#simulacao').textContent = `Exemplos: 1 km = ${reais(v(1))} · 3 km = ${reais(v(3))} · 5 km = ${reais(v(5))} · 10 km = ${reais(v(10))}`;
}
$('#formConfig').oninput = simular;
$('#formConfig').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, corpo = { aceitando: f.aceitando.checked };
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
    $('#nomeCentral').textContent = '🚗 ' + c.nome;
    $('#login').hidden = true; $('#app').hidden = false;
    $('#diaCorridas').value = hoje();
    atualizar();
  } catch { /* mostrarLogin já foi chamado */ }
}
setInterval(() => { if (!$('#app').hidden && aba === 'corridas' && !document.hidden) carregarCorridas().catch(() => {}); }, 5000);
iniciar();
