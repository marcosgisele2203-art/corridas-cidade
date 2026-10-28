// Área do motorista: entra com código no WhatsApp, fica online, compra viagens, vê o relatório e edita o cadastro.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reais = (v) => (v == null ? '—' : 'R$ ' + Number(v).toFixed(2).replace('.', ','));
const hoje = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const TIPOS = { moto: 'Moto', carro: 'Carro', van: 'Van', caminhao: 'Caminhão' };
const MODELO = { moto: 'Honda Titan 160', carro: 'VW Gol', van: 'Sprinter', caminhao: 'Mercedes 710 baú' };

async function api(metodo, caminho, corpo) {
  const r = await fetch(caminho, { method: metodo, headers: corpo ? { 'Content-Type': 'application/json' } : {}, body: corpo ? JSON.stringify(corpo) : undefined });
  const dados = await r.json().catch(() => ({}));
  if (r.status === 401 && caminho !== '/api/motorista/entrar') { mostrarEntrar(); throw new Error(dados.erro); }
  if (!r.ok) throw new Error(dados.erro || 'Erro ' + r.status);
  return dados;
}

fetch('/api/publico/inicio').then((r) => r.json()).then((d) => {
  if (d.nome) document.querySelectorAll('.nome-central').forEach((el) => el.textContent = d.nome);
}).catch(() => {});

// ---------------------------------------------------------------- paleta de cores (muda com o tipo de veículo)

let CORES = null;
async function paleta(caixa, input, tipo) {
  if (!CORES) CORES = await fetch('/api/publico/cores').then((r) => r.json());
  const atual = input.value.trim().toLowerCase();
  caixa.innerHTML = (CORES[tipo] || []).map((c) => `
    <button type="button" class="cor${c.nome === atual ? ' escolhida' : ''}" data-cor="${esc(c.nome)}"><span style="background:${c.hex}"></span>${esc(c.nome)}</button>`).join('');
  caixa.onclick = (e) => { const b = e.target.closest('[data-cor]'); if (b) { input.value = b.dataset.cor; paleta(caixa, input, tipo); } };
  input.oninput = () => paleta(caixa, input, tipo);
}

// ---------------------------------------------------------------- entrar / cadastrar

function mostrarEntrar() { $('#area').hidden = true; $('#entrar').hidden = false; }
document.querySelectorAll('[data-entrar]').forEach((b) => b.onclick = () => {
  document.querySelectorAll('[data-entrar]').forEach((x) => x.classList.toggle('ativa', x === b));
  $('#formCodigo').hidden = b.dataset.entrar !== 'login';
  $('#formCadastro').hidden = b.dataset.entrar !== 'cadastro';
  if (b.dataset.entrar === 'cadastro') paleta($('#paletaCadastro'), $('#formCadastro').cor, $('#formCadastro').tipo.value);
});

let codigoPedido = false;
async function pedirCodigo() {
  const f = $('#formCodigo');
  const r = await api('POST', '/api/motorista/codigo', { telefone: f.telefone.value });
  codigoPedido = true;
  $('#passoCodigo').hidden = false; $('#reenviar').hidden = false;
  $('#botaoCodigo').textContent = '✅ Entrar';
  $('#erroCodigo').className = 'ok';
  $('#erroCodigo').textContent = `Mandamos o código para o WhatsApp terminado em ${r.final}. 📲`;
  f.codigo.focus();
}
$('#formCodigo').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#erroCodigo').className = 'erro'; $('#erroCodigo').textContent = '';
  try {
    if (!codigoPedido) return await pedirCodigo();
    await api('POST', '/api/motorista/entrar', { telefone: f.telefone.value, codigo: f.codigo.value });
    iniciar();
  } catch (err) { $('#erroCodigo').className = 'erro'; $('#erroCodigo').textContent = err.message; }
};
$('#reenviar').onclick = () => pedirCodigo().catch((err) => { $('#erroCodigo').className = 'erro'; $('#erroCodigo').textContent = err.message; });

$('#tiposVeiculo').onclick = (e) => {
  const b = e.target.closest('[data-tipo]');
  if (!b) return;
  document.querySelectorAll('#tiposVeiculo button').forEach((x) => x.classList.toggle('escolhido', x === b));
  const f = $('#formCadastro');
  f.tipo.value = b.dataset.tipo; f.carro.placeholder = MODELO[b.dataset.tipo]; f.cor.value = '';
  paleta($('#paletaCadastro'), f.cor, b.dataset.tipo);
};
$('#formCadastro').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#erroCadastro').textContent = '';
  try {
    const r = await api('POST', '/api/motorista/cadastro', {
      nome: f.nome.value, telefone: f.telefone.value, tipo: f.tipo.value, carro: f.carro.value, cor: f.cor.value, placa: f.placa.value,
    });
    // já entra no passo do código, com o WhatsApp preenchido
    $('[data-entrar=login]').click();
    $('#formCodigo').telefone.value = f.telefone.value;
    await pedirCodigo();
    $('#erroCodigo').textContent = (r.aprovado ? '✅ Cadastro feito! ' : '✅ Cadastro enviado! A central vai conferir seus dados. ') +
      'Mandamos um código no seu WhatsApp para você entrar.';
  } catch (err) { $('#erroCadastro').textContent = err.message; }
};

// ---------------------------------------------------------------- área

let eu = null, aba = 'inicio';
document.querySelectorAll('header nav button').forEach((b) => b.onclick = () => irPara(b.dataset.aba));
function irPara(nova) {
  aba = nova;
  document.querySelectorAll('header nav button').forEach((x) => x.classList.toggle('ativa', x.dataset.aba === aba));
  document.querySelectorAll('main > section').forEach((s) => s.hidden = s.id !== 'aba-' + aba);
  window.scrollTo(0, 0);
  if (aba === 'relatorio') carregarRelatorio();
  if (aba === 'cadastro') preencherCadastro();
}
$('#sair').onclick = async () => { await api('POST', '/api/motorista/sair'); location.reload(); };

const pontoCorrida=(c,t)=>c[t+'_lat']!=null&&c[t+'_lng']!=null&&Number.isFinite(Number(c[t+'_lat']))&&Number.isFinite(Number(c[t+'_lng']))?[Number(c[t+'_lat']),Number(c[t+'_lng'])]:null;
function linkNavegar(c,t,completa=false){
 const p=pontoCorrida(c,t),q=new URLSearchParams({api:'1',destination:p?p.join(','):c[t+'_texto'],travelmode:'driving'});
 const o=pontoCorrida(c,'origem');if(completa&&o)q.set('origin',o.join(','));else q.set('dir_action','navigate');
 return 'https://www.google.com/maps/dir/?'+q;
}
let mapaCorrida=null,assinaturaCorrida=null;
const rotasMapa=new Map();
async function desenharMapaCorrida(c){
 if(mapaCorrida){mapaCorrida.remove();mapaCorrida=null}
 const el=document.getElementById('mapaCorrida'),o=pontoCorrida(c,'origem'),d=pontoCorrida(c,'destino');
 if(!el||!o||!d||typeof L==='undefined')return;
 const map=L.map(el,{scrollWheelZoom:false});mapaCorrida=map;
 L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
 L.marker(o).addTo(map).bindPopup('Embarque');L.marker(d).addTo(map).bindPopup('Destino');
 map.fitBounds([o,d],{padding:[30,30],maxZoom:16});
 const key=o.join(',')+';'+d.join(',');
 if(!rotasMapa.has(key)){
  if(rotasMapa.size>30)rotasMapa.clear();
  rotasMapa.set(key,fetch('https://router.project-osrm.org/route/v1/driving/'+o[1]+','+o[0]+';'+d[1]+','+d[0]+'?overview=full&geometries=geojson',{signal:AbortSignal.timeout(8000)}).then(r=>{if(!r.ok)throw Error();return r.json()}).then(r=>{if(!r.routes?.[0]?.geometry)throw Error();return r.routes[0].geometry}).catch(()=>null));
 }
 const geometry=await rotasMapa.get(key);
 if(!el.isConnected||mapaCorrida!==map)return;
 if(geometry){const layer=L.geoJSON(geometry,{style:{color:'#097d4c',weight:5}}).addTo(map);map.fitBounds(layer.getBounds(),{padding:[30,30]});}
 else {const aviso=document.createElement('p');aviso.className='dica';aviso.textContent='Trajeto indisponível. Use Ver rota para abrir a navegação.';el.after(aviso)}
}
async function carregar() {
  eu = await api('GET', '/api/motorista/eu');
  const m = eu.motorista;
  document.querySelectorAll('.nome-central').forEach((el) => el.textContent = eu.central.nome);
  $('#ola').textContent = `Olá, ${m.nome.split(' ')[0]}!`;
  $('#aviso').innerHTML = !m.aprovado
    ? '<div class="cartao pendente">⏳ <b>Seu cadastro está em análise.</b> Você recebe uma mensagem no WhatsApp assim que a central aprovar.</div>'
    : eu.central.cobranca && m.saldo <= 0
      ? '<div class="cartao pendente">⚠️ <b>Suas viagens acabaram.</b> Sem saldo você não recebe corridas. <a href="#" data-ir="comprar">Comprar viagens →</a></div>' : '';
  $('#situacao').textContent = !m.aprovado ? '⏳ Em análise' : m.online ? '🟢 Online' : '🔴 Offline';
  $('#situacaoDica').textContent = m.online
    ? 'Recebendo corridas. Mande sua localização em tempo real no WhatsApp para pegar as mais perto.'
    : 'Você não está recebendo corridas.';
  const b = $('#botaoOnline');
  b.hidden = !m.aprovado;
  b.textContent = m.online ? '🔴 Ficar offline' : '🟢 Ficar online';
  b.className = m.online ? 'perigo' : '';
  const {oferta} = await api('GET','/api/motorista/oferta');
  const c = eu.corrida || oferta;
  const acoes = eu.corrida ? (c.status === 'aceita' ? [['cheguei','Cheguei ao local'],['iniciar','Iniciar viagem']] : c.status === 'chegou' ? [['iniciar','Iniciar viagem']] : c.status === 'em_andamento' ? [['finalizar','Finalizar viagem']] : []) : oferta ? [['aceitar','Aceitar corrida']] : [];
  const assinatura=JSON.stringify(c);
  if(assinatura!==assinaturaCorrida){assinaturaCorrida=assinatura;
  $('#corridaAtual').innerHTML = c ? '<div class="cartao corrida-agora"><h3>Corrida #'+esc(c.id)+' · '+esc(c.status || 'Nova oferta')+'</h3><p>📍 '+esc(c.origem_texto)+' → 🏁 '+esc(c.destino_texto)+'</p><p>Estimativa: '+reais(c.valor_estimado)+'</p><div class="botoes">'+acoes.map(([acao,label])=>'<button data-acao="'+acao+'" data-corrida="'+esc(c.id)+'">'+label+'</button>').join(' ')+'</div><p id="erroAcao" role="alert"></p></div>' : '';
if(c){
 const bloco=$('#corridaAtual .corrida-agora'),nav=document.createElement('div');nav.className='botoes';
 const itens=eu.corrida?[[c.status==='em_andamento'?'Ir ao destino':'Ir até o passageiro',c.status==='em_andamento'?'destino':'origem',false],['Ver rota','destino',true]]:[['Ver rota','destino',true]];
 for(const [label,tipo,completa]of itens){const a=document.createElement('a');a.className='botao';a.textContent=label;a.href=linkNavegar(c,tipo,completa);a.target='_blank';a.rel='noopener noreferrer';nav.append(a)}
 bloco.append(nav);
 if(pontoCorrida(c,'origem')&&pontoCorrida(c,'destino')){const el=document.createElement('div');el.id='mapaCorrida';el.style.cssText='height:280px;margin-top:20px;border-radius:14px';bloco.append(el);desenharMapaCorrida(c).catch(()=>{})}
}else if(mapaCorrida){mapaCorrida.remove();mapaCorrida=null}
  }
  const t = eu.mes;
  $('#kpisMes').innerHTML = [
    ['Saldo de viagens', eu.central.cobranca ? m.saldo : '—'], ['Corridas feitas', t.finalizadas], ['Total das corridas', reais(t.ganhos)],
    ['Distância', t.km.toFixed(1).replace('.', ',') + ' km'], ['Nota média', t.nota ? String(t.nota).replace('.', ',') + ' ⭐' : '—'],
  ].map(([n, v]) => `<div class="kpi"><span>${n}</span><b>${v}</b></div>`).join('');
  desenharComprar();
}
$('#aviso').onclick = (e) => { if (e.target.dataset.ir) { e.preventDefault(); irPara(e.target.dataset.ir); } };
$('#botaoOnline').onclick = async () => {
  try { await api('POST', '/api/motorista/online', { online: !eu.motorista.online }); await carregar(); } catch (err) { alert(err.message); }
};

// ---- comprar viagens
let esperandoPix = null;
function desenharComprar() {
  $('#saldoComprar').textContent = eu.motorista.saldo;
  if (!eu.central.cobranca) {
    $('#pacotes').innerHTML = '<p class="vazio">A central não está cobrando por viagem no momento. 🙂</p>';
    $('#compraAberta').innerHTML = '';
    return;
  }
  $('#pacotes').innerHTML = eu.pacotes.map((p) => `
    <div class="pacote${p.desconto >= 20 ? ' destaque' : ''}">
      ${p.desconto > 0 ? `<span class="pacote-off">${p.desconto}% off 🔥</span>` : ''}
      <b>${p.qtd}</b><span>viage${p.qtd === 1 ? 'm' : 'ns'}</span>
      <strong>${reais(p.preco)}</strong>
      <small>${p.qtd > 1 ? reais(p.cada) + ' cada' : '&nbsp;'}</small>
      <button data-comprar="${p.qtd}">Comprar</button>
    </div>`).join('');
  const c = eu.compra;
  if (!c) { $('#compraAberta').innerHTML = ''; return; }
  if (c.pix_copia_cola) {
    $('#compraAberta').innerHTML = `<div class="cartao pix">
      <div class="pix-qr">${c.qr}</div>
      <div><h3>🧾 Pedido #${c.id}: ${c.quantidade} viagens · ${reais(c.valor)}</h3>
        <p>Abra o app do seu banco, escolha <b>Pix › Ler QR Code</b> ou use o <b>copia e cola</b>:</p>
        <div class="copiar"><input readonly value="${esc(c.pix_copia_cola)}"><button class="mini" id="copiarPix">Copiar</button></div>
        <p class="aguardando">⏳ Esperando o pagamento… As viagens entram sozinhas assim que o Pix for aprovado.</p></div></div>`;
    $('#copiarPix').onclick = async (e) => {
      try { await navigator.clipboard.writeText(c.pix_copia_cola); } catch { $('#compraAberta input').select(); document.execCommand('copy'); }
      e.target.textContent = '✅ Copiado!';
    };
    esperarPix(c.id);
  } else {
    $('#compraAberta').innerHTML = `<div class="cartao pix">
      <div><h3>🧾 Pedido #${c.id}: ${c.quantidade} viagens · ${reais(c.valor)}</h3>
        ${eu.central.pix_chave ? `<p>🔑 Chave Pix: <b>${esc(eu.central.pix_chave)}</b>${eu.central.pix_nome ? ` · ${esc(eu.central.pix_nome)}` : ''}</p>` : '<p>🔑 A central vai te passar a chave Pix.</p>'}
        <p>Faça o Pix e <b>mande a foto do comprovante no WhatsApp da central</b>. Quando ela confirmar, as viagens entram no seu saldo.</p>
        <p class="aguardando">${c.comprovante ? '📎 Comprovante recebido, esperando a central confirmar.' : '⏳ Esperando o comprovante.'}</p></div></div>`;
    esperarPix(c.id);
  }
}
$('#pacotes').onclick = async (e) => {
  const qtd = e.target.dataset.comprar;
  if (!qtd) return;
  e.target.disabled = true; e.target.textContent = 'Gerando Pix…';
  try { await api('POST', '/api/motorista/comprar', { qtd: Number(qtd) }); await carregar(); window.scrollTo(0, 0); }
  catch (err) { alert(err.message); e.target.disabled = false; e.target.textContent = 'Comprar'; }
};
function esperarPix(id) {
  if (esperandoPix === id) return;
  esperandoPix = id;
  const tentar = async () => {
    if (esperandoPix !== id) return;
    try {
      const r = await api('GET', `/api/motorista/compra/${id}`);
      if (r.status === 'pago') {
        esperandoPix = null;
        await carregar();
        $('#compraAberta').innerHTML = `<div class="cartao pago">✅ <b>Pagamento confirmado!</b> Seu saldo agora é de <b>${r.saldo} viagens</b>. Boas corridas! 🚀</div>`;
        return;
      }
      if (r.status !== 'pendente') { esperandoPix = null; await carregar(); return; }
    } catch { /* tenta de novo */ }
    setTimeout(tentar, 5000);
  };
  setTimeout(tentar, 4000);
}

// ---- relatório
$('#relDe').onchange = $('#relAte').onchange = () => carregarRelatorio();
$('#imprimir').onclick = () => window.print();
async function carregarRelatorio() {
  if (!$('#relDe').value) { $('#relDe').value = hoje().slice(0, 8) + '01'; $('#relAte').value = hoje(); }
  const de = $('#relDe').value, ate = $('#relAte').value;
  const r = await api('GET', `/api/motorista/relatorio?de=${de}&ate=${ate}`);
  const dataRelatorio = (data) => data.split('-').reverse().join('/');
  $('#identificacaoRelatorio').textContent = 'Motorista: ' + r.motorista.nome +
    ' · Período: ' + dataRelatorio(de) + ' a ' + dataRelatorio(ate);
  const t = r.totais, v = r.viagens;
  $('#kpisRel').innerHTML = [
    ['Corridas feitas', t.finalizadas], ['Canceladas', t.canceladas], ['Total das corridas', reais(t.ganhos)],
    ['Distância', t.km.toFixed(1).replace('.', ',') + ' km'], ['Nota média', t.nota ? String(t.nota).replace('.', ',') + ' ⭐' : '—'],
    ['Viagens compradas', v.compradas], ['Pago por viagens', reais(v.pago)], ['Viagens usadas', v.usadas], ['Saldo atual', r.motorista.saldo],
  ].map(([n, x]) => `<div class="kpi"><span>${n}</span><b>${x}</b></div>`).join('');
  $('#tabelaRel').innerHTML = r.corridas.length ? `<div class="tabela"><table>
    <tr><th>Quando</th><th>Saída → Destino</th><th class="num">Km</th><th class="num">Valor</th><th class="num">Nota</th><th>Situação</th></tr>
    ${r.corridas.map((c) => `<tr><td>${c.quando}</td><td>${esc(c.origem_texto)} → ${esc(c.destino_texto)}</td>
      <td class="num">${c.km ? String(Number(c.km)).replace('.', ',') : '—'}</td><td class="num">${c.status === 'finalizada' ? reais(c.valor_final) : '—'}</td>
      <td class="num">${c.avaliacao ? c.avaliacao + '⭐' : '—'}</td><td>${c.status === 'finalizada' ? 'Finalizada' : 'Cancelada'}</td></tr>`).join('')}
  </table></div>` : `<div class="vazio"><img src="img/manu/manu-joinha.webp" alt=""><b>Nenhuma corrida neste período.</b><span>Fique online para receber corridas!</span></div>`;
}

// ---- meu cadastro
function preencherCadastro() {
  const f = $('#formEu'), m = eu.motorista;
  f.nome.value = m.nome; f.telefone.value = m.telefone; f.tipoNome.value = TIPOS[m.tipo] || m.tipo;
  f.carro.value = m.carro || ''; f.cor.value = m.cor || ''; f.placa.value = m.placa || '';
  $('#okEu').textContent = ''; $('#erroEu').textContent = '';
  paleta($('#paletaEu'), f.cor, m.tipo);
}
$('#formEu').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#okEu').textContent = ''; $('#erroEu').textContent = '';
  try {
    await api('PUT', '/api/motorista/eu', { carro: f.carro.value, cor: f.cor.value, placa: f.placa.value });
    await carregar();
    $('#okEu').textContent = '✅ Salvo!';
  } catch (err) { $('#erroEu').textContent = err.message; }
};

// ---------------------------------------------------------------- início

async function iniciar() {
  try {
    await carregar();
    $('#entrar').hidden = true; $('#area').hidden = false;
    irPara('inicio');
  } catch { /* mostrarEntrar já foi chamado */ }
}
// mantém saldo e situação em dia (ex.: viagem usada pelo WhatsApp)
setInterval(() => { if (!$('#area').hidden && !document.hidden && aba === 'inicio') carregar().catch(() => {}); }, 30000);
iniciar();

let agindo = false;
$('#corridaAtual').onclick = async e => {
  const b = e.target.closest('[data-acao]');
  if (!b || agindo) return;
  if (b.dataset.acao === 'finalizar' && !confirm('Finalizar esta viagem pelo valor estimado?')) return;
  agindo = true; b.disabled = true;
  try { await api('POST','/api/motorista/corrida/'+b.dataset.corrida+'/acao',{acao:b.dataset.acao}); await carregar(); }
  catch(err) { alert(err.message); await carregar().catch(()=>{}); }
  finally { agindo = false; b.disabled = false; }
};
setInterval(()=>{if(!agindo && !$('#area').hidden && !document.hidden && aba === 'inicio') carregar().catch(()=>{});},5000);
