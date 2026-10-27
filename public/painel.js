// Painel da central: corridas ao vivo, motoristas, relatório e configurações.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reais = (v) => (v == null ? '—' : 'R$ ' + Number(v).toFixed(2).replace('.', ','));
const hora = (d) => (d ? new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');
const hoje = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const TIPOS = { moto: '🏍️ Moto', carro: '🚗 Carro', van: '🚐 Van', caminhao: '🚚 Caminhão' };
const veiculo = (m) => esc([m.carro, m.cor].filter(Boolean).join(' '));
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
  if (aba === 'divulgar') carregarDivulgar();
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
    : '<p class="vazio">Nenhum motorista ainda. Peça para eles mandarem <b>CADASTRO</b> no WhatsApp da central, ou cadastre aqui.</p>';
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
  </table></div>` : '<p class="vazio">Nenhum motorista aprovado ainda.</p>';
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
    </table></div>` : '<p class="vazio">Nenhuma corrida no período.</p>'}`;
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

const foneBR = (n) => { const d = String(n).replace(/^55/, ''); return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}` : n; };
async function carregarDivulgar() {
  const d = await api('GET', '/api/divulgar');
  const caixa = $('#divulgar');
  if (!d.numero) {
    caixa.innerHTML = `<p class="vazio">Não consegui descobrir o número da central pela Evolution.<br>
      Preencha <b>WhatsApp da central</b> em Configurações e volte aqui.</p>`;
    return;
  }
  const textoPassageiro = `🚗 *${d.nome}*\nPrecisa de uma corrida? Peça pelo WhatsApp, rapidinho!\n🏍️ Moto · 🚗 Carro · 🚐 Van · 🚚 Frete\n\n👉 ${d.passageiro}\n📞 ${foneBR(d.numero)}`;
  const textoMotorista = `🚘 *${d.nome}* está cadastrando motoristas!\nMoto, carro, van ou caminhão. Cadastro pelo WhatsApp em 1 minuto.\n\n👉 ${d.motorista}`;
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
      <h3>🚘 Para motoristas</h3>
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
      <h1>🚗 ${esc(d.nome)}</h1>
      <p class="cartaz-sub">Peça sua corrida pelo WhatsApp</p>
      <p class="cartaz-tipos">🏍️ Moto · 🚗 Carro · 🚐 Van · 🚚 Frete</p>
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

const CAMPOS = ['nome', 'cidade', 'numero_admin', 'numero_central', 'comissao_pct', 'oferta_segundos', 'fator_rota',
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
