// Robô das corridas: conversa com passageiros e motoristas e distribui as chamadas.
//
// Tudo passa por uma fila única (rodar), então duas mensagens nunca mexem na mesma corrida ao
// mesmo tempo (ex.: dois motoristas aceitando juntos). Para cidade pequena isso sobra.
const { pool, lerConfig, tiposAtivos, moverCreditos, pacotesComDesconto } = require('./db');
const whats = require('./whats');
const geo = require('./geo');
const { TIPOS, ORDEM, rotulo, lerTipo, veiculo, coresDo, lerCor } = require('./tipos');
const MP = require('./mercadopago');
const relatorio = require('./relatorio');
const fs = require('fs');
const path = require('path');

let fila = Promise.resolve();
function rodar(fn) {
  const p = fila.then(fn);
  fila = p.catch((e) => console.error('Erro no robô:', e));
  return p;
}

const ATIVAS = ['procurando', 'aceita', 'chegou', 'em_andamento'];
const ESPERA_MAX_MIN = 5;   // procura motorista por até 5 min quando todos estão ocupados
const CONVERSA_EXPIRA_MIN = 30;

const normalizar = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
const primeiroNome = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const ponto = (lat, lng) => (lat == null ? null : { lat: Number(lat), lng: Number(lng) });
const emoji = (tipo) => (TIPOS[tipo] || TIPOS.carro).emoji;
const PEDE_CADASTRO = /^(CADASTRO|CADASTRAR|SOU MOTORISTA|QUERO SER MOTORISTA|MOTORISTA|QUERO TRABALHAR)$/;

// ---------------------------------------------------------------- consultas

async function motoristaPorTelefone(tel) {
  if (String(tel).length < 8) return null;
  const { rows } = await pool.query(
    'SELECT * FROM motoristas WHERE right(telefone, 8) = right($1, 8) ORDER BY ativo DESC, id LIMIT 1', [tel]);
  return rows[0] || null;
}

async function corridaAtivaDoPassageiro(tel) {
  const { rows } = await pool.query(
    'SELECT * FROM corridas WHERE passageiro_tel = $1 AND status = ANY($2) ORDER BY id DESC LIMIT 1', [tel, ATIVAS]);
  return rows[0] || null;
}

async function corridaAtivaDoMotorista(id) {
  const { rows } = await pool.query(
    "SELECT * FROM corridas WHERE motorista_id = $1 AND status IN ('aceita', 'chegou', 'em_andamento') ORDER BY id DESC LIMIT 1", [id]);
  return rows[0] || null;
}

async function salvarConversa(tel, etapa, dados = {}) {
  await pool.query('UPDATE conversas SET etapa = $2, dados = $3, atualizado_em = now() WHERE telefone = $1', [tel, etapa, JSON.stringify(dados)]);
}

// ---------------------------------------------------------------- entrada

// ---- proteção contra loop: outro robô (ex.: atendimento automático de uma loja) respondendo o nosso sem parar.
// Número que manda mensagens demais em pouco tempo fica sem resposta por um tempo.
const LIMITE_MSGS = 12, JANELA_MS = 30_000, SILENCIO_MS = 30 * 60_000;
const recentes = new Map();   // telefone → horários das últimas mensagens
const silenciados = new Map(); // telefone → até quando fica sem resposta

function parecaRobo(msg) {
  if (msg.local && msg.local.aoVivo) return false; // localização em tempo real chega toda hora, é normal
  const agora = Date.now(), tel = msg.telefone;
  if ((silenciados.get(tel) || 0) > agora) return true;
  const lista = (recentes.get(tel) || []).filter((t) => agora - t < JANELA_MS);
  lista.push(agora);
  recentes.set(tel, lista);
  if (lista.length <= LIMITE_MSGS) return false;
  silenciados.set(tel, agora + SILENCIO_MS);
  recentes.delete(tel);
  console.log(`Proteção contra loop: ${tel} mandou ${lista.length} mensagens em ${JANELA_MS / 1000}s. Sem resposta por ${SILENCIO_MS / 60_000} min.`);
  lerConfig().then((cfg) => {
    if (cfg.numero_admin && cfg.numero_admin !== tel) {
      whats.texto(cfg.numero_admin, `⚠️ *Proteção contra loop*\nO número wa.me/${tel} mandou muitas mensagens seguidas (parece outro robô respondendo o nosso).\n` +
        `A central parou de responder a ele por ${SILENCIO_MS / 60_000} minutos.`);
    }
  }).catch(() => {});
  return true;
}
setInterval(() => {
  const agora = Date.now();
  for (const [t, ate] of silenciados) if (ate < agora) silenciados.delete(t);
  for (const [t, l] of recentes) if (!l.some((x) => agora - x < JANELA_MS)) recentes.delete(t);
}, 5 * 60_000).unref();

// msg = { telefone, contato, nome, texto, local: { lat, lng, nome, endereco, aoVivo } | null }
function receber(msg) {
  if (parecaRobo(msg)) return Promise.resolve();
  return rodar(async () => {
    const m = await motoristaPorTelefone(msg.telefone);
    if (m && m.ativo && m.aprovado) return tratarMotorista(m, msg);
    if (msg.midia && !msg.texto) return; // foto ou arquivo de passageiro: o robô não sabe o que fazer
    if (m && m.ativo && !m.aprovado) {
      return whats.texto(msg.contato, `⏳ Olá ${primeiroNome(m.nome)}! Seu cadastro de motorista está *em análise*.
Você recebe uma mensagem aqui assim que for aprovado.`);
    }
    return tratarPassageiro(msg); // quem não é motorista (ou foi desativado) é passageiro
  });
}

// ---------------------------------------------------------------- passageiro

async function tratarPassageiro(msg) {
  const cfg = await lerConfig();
  const { telefone, contato } = msg;
  const cmd = normalizar(msg.texto);

  const { rows } = await pool.query(
    `INSERT INTO conversas (telefone, contato, nome) VALUES ($1, $2, $3)
     ON CONFLICT (telefone) DO UPDATE SET contato = EXCLUDED.contato, nome = COALESCE(NULLIF(conversas.nome, ''), EXCLUDED.nome)
     RETURNING *, extract(epoch FROM now() - atualizado_em) / 60 AS minutos`, [telefone, contato, msg.nome || '']);
  const conv = rows[0];
  let etapa = conv.etapa;
  if (etapa !== 'inicio' && etapa !== 'avaliar' && conv.minutos > CONVERSA_EXPIRA_MIN) etapa = 'inicio';

  const ativa = await corridaAtivaDoPassageiro(telefone);
  if (ativa) {
    if (cmd === 'CANCELAR') return cancelarPeloPassageiro(ativa);
    return whats.texto(contato, situacaoParaPassageiro(ativa, await motoristaDa(ativa)));
  }

  if (etapa === 'avaliar') {
    const nota = Number(cmd);
    if (Number.isInteger(nota) && nota >= 1 && nota <= 5) {
      await pool.query('UPDATE corridas SET avaliacao = $2 WHERE id = $1', [conv.dados.corrida_id, nota]);
      await salvarConversa(telefone, 'inicio');
      return whats.texto(contato, `Obrigado pela avaliação! ${'⭐'.repeat(nota)}\nQuando precisar de outra corrida é só mandar *oi*.`);
    }
    etapa = 'inicio';
  }

  if (cmd === 'CANCELAR' && etapa !== 'inicio') {
    await salvarConversa(telefone, 'inicio');
    return whats.texto(contato, (etapa.startsWith('cad_') ? 'Cadastro cancelado.' : 'Pedido cancelado.') + ' Quando precisar é só mandar *oi*. 👋');
  }

  if (PEDE_CADASTRO.test(cmd)) {
    await salvarConversa(telefone, 'cad_nome');
    return whats.texto(contato, `🚘 *Cadastro de motorista · ${cfg.nome}*

Vamos lá! São 5 perguntas rápidas.
(Para desistir, envie *CANCELAR*.)

1/5 · Qual é o seu *nome completo*?`);
  }
  if (etapa.startsWith('cad_')) return tratarCadastro(conv, msg, etapa, cfg);

  const pedirVeiculo = async (dados = {}) => {
    await salvarConversa(telefone, 'veiculo', dados);
    return whats.texto(contato, 'Vamos organizar sua viagem.\n\n' + menuVeiculos(cfg));
  };
  const confirmarResumo = async (dados) => {
    dados.km = geo.kmRota(dados.origem, dados.destino, cfg);
    dados.valor = geo.preco(dados.km, cfg.precos[dados.tipo]);
    await salvarConversa(telefone, 'confirmar', dados);
    return whats.texto(contato, resumoPedido(dados, cfg) + '\n\nEnvie *CONFIRMAR* para pedir a corrida, *ALTERAR* para corrigir ou *CANCELAR* para desistir.');
  };
  if (etapa === 'inicio') {
    if (!cfg.aceitando) return whats.texto(contato, 'A central não está aceitando corridas agora. Tente mais tarde.');
    if (!conv.nome || !conv.nome.trim()) {
      await salvarConversa(telefone, 'pass_nome', msg.local ? { origemInicial: { ...msg.local, texto: msg.local.endereco || msg.local.nome || 'Localização enviada' } } : {});
      return whats.texto(contato, 'Olá! Sou a Manu, da ' + cfg.nome + '. Para começar, como posso chamar você?');
    }
    return pedirVeiculo(msg.local ? { origemInicial: { ...msg.local, texto: msg.local.endereco || msg.local.nome || 'Localização enviada' } } : {});
  }
  if (etapa === 'pass_nome') {
    const nome = String(msg.texto || '').trim().slice(0,80);
    if (nome.length < 2 || ehConversa(nome) || msg.local) return whats.texto(contato,'Qual é o seu nome, por favor?');
    await pool.query('UPDATE conversas SET nome=$2 WHERE telefone=$1',[telefone,nome]);
    return pedirVeiculo(conv.dados);
  }
  if (etapa === 'veiculo') {
    const tipo = lerTipo(cmd, tiposAtivos(cfg));
    if (!tipo || !cfg.precos[tipo].ativo) return whats.texto(contato,'Escolha pelo nome ou número:\n\n'+menuVeiculos(cfg));
    const dados = { ...conv.dados, tipo };
    delete dados.pendente;
    if(dados.origem && dados.destino) return confirmarResumo(dados);
    if(dados.origemInicial){
      dados.origem=dados.origemInicial;delete dados.origemInicial;
      await salvarConversa(telefone,'destino',dados);
      return whats.texto(contato,'Local de embarque anotado. Para onde vamos? Envie o endereço ou a localização do destino.');
    }
    await salvarConversa(telefone,'origem',dados);
    return whats.texto(contato,'Onde vamos buscar você? Envie sua localização (clipe › Localização) ou escreva rua, número e bairro.');
  }
  if (etapa === 'origem') {
    const origem = await pontoConferido(conv,msg,cmd,cfg,'origem');if(!origem)return;
    await salvarConversa(telefone,'destino',{...conv.dados,origem,pendente:null});
    return whats.texto(contato,'Embarque anotado. Para onde vamos? Envie o endereço ou a localização do destino.');
  }
  if (etapa === 'destino') {
    const destino=await pontoConferido(conv,msg,cmd,cfg,'destino');if(!destino)return;
    const dados={...conv.dados,destino,pendente:null};
    // Conversas abertas na versão anterior ainda precisam escolher o veículo.
    if(!dados.tipo)return pedirVeiculo(dados);
    await salvarConversa(telefone,'complemento',dados);
    return whats.texto(contato,'Tem algum complemento para o embarque? Número, portão ou ponto de referência. Se não precisar, envie *PULAR*.');
  }
  if (etapa === 'complemento') {
    if(msg.local || !String(msg.texto||'').trim()) return whats.texto(contato,'Escreva a referência do embarque ou envie *PULAR*.');
    const dados={...conv.dados};
    if(!['PULAR','NAO','SEM','SEM COMPLEMENTO','NENHUM'].includes(cmd)){
      dados.origem={...dados.origem,texto:dados.origem.texto+' · '+String(msg.texto).trim().slice(0,80)};
    }
    return confirmarResumo(dados);
  }
  if (etapa === 'confirmar') {
    if(['ALTERAR','2'].includes(cmd)){
      await salvarConversa(telefone,'alterar',conv.dados);
      return whats.texto(contato,'O que deseja alterar? Envie *VEICULO*, *ORIGEM* ou *DESTINO*.');
    }
    if(['1','SIM','S','CONFIRMAR','OK'].includes(cmd)){
      if(!cfg.aceitando)return whats.texto(contato,'A central não está aceitando corridas agora.');
      const d=conv.dados;
      if(!d.tipo||!cfg.precos[d.tipo]?.ativo)return pedirVeiculo(d);
      const valor=geo.preco(geo.kmRota(d.origem,d.destino,cfg),cfg.precos[d.tipo]);
      if(valor!==d.valor)return confirmarResumo({...d});
      return criarCorrida(conv,msg);
    }
    return whats.texto(contato,'Envie *CONFIRMAR*, *ALTERAR* ou *CANCELAR*.');
  }
  if(etapa==='alterar'){
    const etapas={VEICULO:'veiculo',ORIGEM:'origem',DESTINO:'destino'};
    if(!etapas[cmd])return whats.texto(contato,'Escolha *VEICULO*, *ORIGEM* ou *DESTINO*.');
    if(cmd==='VEICULO')return pedirVeiculo(conv.dados);
    await salvarConversa(telefone,etapas[cmd],{...conv.dados,pendente:null});
    return whats.texto(contato,cmd==='ORIGEM'?'Envie o novo local de embarque.':'Envie o novo destino.');
  }
}

// Lê a saída ou o destino. Endereço digitado que o mapa não achou: avisa o cliente e pede a localização
// (ou outro jeito de escrever); se ele responder OK, segue sem o ponto no mapa e o motorista combina o valor.
async function pontoConferido(conv, msg, cmd, cfg, campo) {
  const pendente = conv.dados.pendente;
  if (pendente && pendente.campo === campo && !msg.local && ['OK', 'SEGUIR', 'SIM', 'S', 'PODE'].includes(cmd)) {
    return { texto: pendente.texto };
  }
  const ponto = await lerPonto(msg, cfg);
  if (!ponto) {
    await whats.texto(msg.contato, campo === 'origem'
      ? 'Não entendi. 🤔 Envie sua *localização* 📍 ou digite o endereço (rua e número, ou um ponto conhecido).'
      : 'Não entendi. 🤔 Digite o endereço de destino ou envie a localização.');
    return null;
  }
  if (geo.temPonto(ponto) || !cfg.cidade) return ponto; // sem cidade configurada nem tenta achar no mapa
  await salvarConversa(conv.telefone, campo, { ...conv.dados, pendente: { campo, texto: ponto.texto } });
  await whats.texto(msg.contato, `🤔 Não encontrei *"${ponto.texto}"* no mapa.\n\n` +
    'Para o preço sair certinho:\n' +
    (campo === 'origem'
      ? '📍 envie sua *localização* (clipe 📎 › Localização), ou\n'
      : '📍 envie a *localização do destino* (clipe 📎 › Localização › arraste o mapa até o lugar e toque nele), ou\n') +
    '✍️ escreva de outro jeito: rua e número, bairro, ou um lugar conhecido perto.\n\n' +
    'Se preferir seguir assim mesmo, responda *OK* (o valor fica para combinar com o motorista).');
  return null;
}

// arte de divulgação (public/artes) em base64; "auto" escolhe pela lista de veículos ligados
const PASTA_ARTES = path.join(__dirname, '..', 'public', 'artes');
const cacheArtes = new Map();
function arteBoasVindas(cfg) {
  let nome = cfg.arte_boas_vindas;
  if (nome === 'auto') {
    const t = tiposAtivos(cfg);
    nome = t.includes('van') || t.includes('caminhao') ? 'todos-os-veiculos' : t.includes('carro') ? 'carro-e-moto' : 'moto';
  }
  if (!nome || !/^[a-z0-9-]+$/.test(nome)) return null;
  if (!cacheArtes.has(nome)) {
    try { cacheArtes.set(nome, fs.readFileSync(path.join(PASTA_ARTES, nome + '.jpg')).toString('base64')); } catch { cacheArtes.set(nome, null); }
  }
  return cacheArtes.get(nome);
}

// "Boa noite", "oi tudo bem?", "obrigado"... é conversa, não endereço
const CONVERSA = /^(oi+|ol[aá]|opa|e[ai]+|bo[am] (dia|tarde|noite)|tudo (bem|bom)|blz|beleza|ok|okay|obrigad[oa]|valeu|vlw|sim|n[aã]o|tchau|al[oô]|quero (uma )?(corrida|carro|moto)|preciso de (uma )?(corrida|carro|moto))\b[\s!?.,]*(tudo (bem|bom))?[\s!?.,]*$/i;
const ehConversa = (txt) => CONVERSA.test(txt.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim());

// localização enviada ou endereço digitado
async function lerPonto(msg, cfg) {
  if (msg.local) {
    return { lat: msg.local.lat, lng: msg.local.lng, texto: [msg.local.nome, msg.local.endereco].filter(Boolean).join(' - ') || 'Localização enviada 📍' };
  }
  const txt = String(msg.texto || '').trim().slice(0, 200);
  if (txt.length < 3 || ehConversa(txt)) return null;
  const achou = await geo.buscarEndereco(txt, cfg);
  return { ...(achou || {}), texto: txt };
}

function resumoPedido(d, cfg) {
  const linhas = [`📍 *Saída:* ${d.origem.texto}`, `🏁 *Destino:* ${d.destino.texto}`];
  if (d.km != null) linhas.push(`📏 Cerca de ${String(d.km).replace('.', ',')} km`);
  if (d.tipo) {
    linhas.push(`${rotulo(d.tipo)}`);
    linhas.push(d.valor != null ? `💰 *Valor: ${geo.reais(d.valor)}*` : `💰 Valor calculado pelo motorista no fim (mínimo ${geo.reais(cfg.precos[d.tipo].minimo)})`);
  }
  return linhas.join('\n');
}

// "1️⃣ 🏍️ Moto · R$ 7,00" para cada tipo de veículo oferecido
// só os veículos; o preço aparece depois que o cliente escolhe
function menuVeiculos(cfg) {
  const numeros = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
  const linhas = tiposAtivos(cfg).map((t, i) => `${numeros[i]} ${rotulo(t)}`);
  return '*Qual veículo você quer?* (envie o nome ou número)\n' + linhas.join('\n') + '\n0️⃣ Cancelar';
}

// ---------------------------------------------------------------- cadastro de motorista pelo WhatsApp

const BOLINHA = { '#ffffff': '⚪', '#1b1b1b': '⚫', '#c62828': '🔴', '#1e5bb8': '🔵', '#2e7d32': '🟢', '#f2c200': '🟡',
  '#ef6c00': '🟠', '#6d4c2f': '🟤', '#6a3fa0': '🟣' };
// "1 ⚪ Branco · 2 Prata · ..." em colunas curtas, cabe na tela do celular
const menuCores = (tipo) => coresDo(tipo).map((c, i) => `*${i + 1}* ${BOLINHA[c.hex] || '▫️'} ${c.nome[0].toUpperCase() + c.nome.slice(1)}`).join('\n') +
  '\n_Outra cor? Digite o nome._';

async function tratarCadastro(conv, msg, etapa, cfg) {
  const { telefone, contato } = msg;
  const txt = String(msg.texto || '').trim();
  const d = conv.dados || {};

  if (etapa === 'cad_nome') {
    if (txt.replace(/[^a-zA-ZÀ-ÿ]/g, '').length < 3) return whats.texto(contato, 'Digite o seu *nome completo*, por favor.');
    await salvarConversa(telefone, 'cad_tipo', { nome: txt.slice(0, 80) });
    return whats.texto(contato, '2/5 · Qual é o seu *veículo*? Responda com o número:\n' +
      ORDEM.map((t, i) => `${i + 1}️⃣ ${rotulo(t)}`).join('\n'));
  }
  if (etapa === 'cad_tipo') {
    const tipo = lerTipo(txt, ORDEM);
    if (!tipo) return whats.texto(contato, 'Responda com o número: ' + ORDEM.map((t, i) => `*${i + 1}* ${TIPOS[t].nome}`).join(', ') + '.');
    await salvarConversa(telefone, 'cad_veiculo', { ...d, tipo });
    const exemplo = { moto: 'Honda Titan 160', carro: 'VW Gol', van: 'Sprinter', caminhao: 'Mercedes 710 baú' }[tipo];
    return whats.texto(contato, `3/5 · Qual o *modelo* do veículo?\n(ex.: ${exemplo})`);
  }
  if (etapa === 'cad_veiculo') {
    if (txt.length < 2) return whats.texto(contato, 'Digite o *modelo* do veículo.');
    await salvarConversa(telefone, 'cad_cor', { ...d, veiculo: txt.slice(0, 60) });
    return whats.texto(contato, '4/5 · Qual a *cor*? Responda com o número:\n' + menuCores(d.tipo));
  }
  if (etapa === 'cad_cor') {
    const cor = lerCor(txt, d.tipo);
    if (!cor) return whats.texto(contato, 'Responda com o *número* da cor, ou digite o nome dela:\n' + menuCores(d.tipo));
    await salvarConversa(telefone, 'cad_placa', { ...d, cor });
    return whats.texto(contato, '5/5 · Qual a *placa*? (ex.: ABC1D23)');
  }
  if (etapa === 'cad_placa') {
    const placa = normalizar(txt).replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(placa)) return whats.texto(contato, 'Placa inválida. Digite no formato *ABC1D23* ou *ABC1234*.');
    const aprovado = !!cfg.aprovar_automatico;
    await pool.query(
      `INSERT INTO motoristas (nome, telefone, tipo, carro, cor, placa, contato, aprovado, ativo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       ON CONFLICT (telefone) DO UPDATE SET nome = EXCLUDED.nome, tipo = EXCLUDED.tipo, carro = EXCLUDED.carro, cor = EXCLUDED.cor,
             placa = EXCLUDED.placa, contato = EXCLUDED.contato, aprovado = EXCLUDED.aprovado, ativo = true, online = false`,
      [d.nome, telefone, d.tipo, d.veiculo, d.cor || '', placa, contato, aprovado]);
    await salvarConversa(telefone, 'inicio');
    const ficha = `👤 ${d.nome}\n${rotulo(d.tipo)} · ${d.veiculo}${d.cor ? ' ' + d.cor : ''} · ${placa}`;
    if (cfg.numero_admin) {
      await whats.texto(cfg.numero_admin, `🆕 *Novo motorista ${aprovado ? 'cadastrado' : 'aguardando aprovação'}*\n${ficha}\n📞 wa.me/${telefone}` +
        (aprovado ? '' : '\n\nAprove no painel, em *Motoristas*.'));
    }
    if (aprovado) return whats.texto(contato, `✅ *Cadastro feito!*\n${ficha}\n\nBem-vindo à ${cfg.nome}! 🎉\n\n` + AJUDA_MOTORISTA);
    return whats.texto(contato, `✅ *Cadastro enviado!*\n${ficha}\n\nA ${cfg.nome} vai conferir seus dados. Você recebe uma mensagem aqui assim que for aprovado. 🙌`);
  }
}

async function criarCorrida(conv, msg) {
  const d = conv.dados;
  const { rows } = await pool.query(
    `INSERT INTO corridas (passageiro_tel, passageiro_contato, passageiro_nome, origem_texto, origem_lat, origem_lng,
                           destino_texto, destino_lat, destino_lng, km, valor_estimado, tipo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [conv.telefone, msg.contato, conv.nome || msg.nome, d.origem.texto, d.origem.lat ?? null, d.origem.lng ?? null,
      d.destino.texto, d.destino.lat ?? null, d.destino.lng ?? null, d.km, d.valor, d.tipo]);
  await salvarConversa(conv.telefone, 'inicio');
  const valor = d.valor != null ? ` · ${geo.reais(d.valor)}` : '';
  await whats.texto(msg.contato, `${rotulo(d.tipo)}${valor}\n🔎 Procurando um motorista para você... ⏳\nPara cancelar, envie *CANCELAR*.`);
  await despachar(rows[0].id);
}

async function motoristaDa(c) {
  if (!c.motorista_id) return null;
  const { rows } = await pool.query('SELECT * FROM motoristas WHERE id = $1', [c.motorista_id]);
  return rows[0] || null;
}

function situacaoParaPassageiro(c, m) {
  if (c.status === 'procurando') return '🔎 Ainda procurando um motorista para você... ⏳\nPara cancelar, envie *CANCELAR*.';
  const carro = m ? `${m.nome} · ${veiculo(m)} ${m.placa}`.trim() : '';
  if (c.status === 'aceita') return `${emoji(c.tipo)} ${carro} está a caminho.\nPara cancelar, envie *CANCELAR*.`;
  if (c.status === 'chegou') return `📍 ${carro} já está te esperando no local!`;
  return `🛣️ Corrida em andamento com ${carro}. Boa viagem!`;
}

async function cancelarPeloPassageiro(c) {
  if (c.status === 'em_andamento') return whats.texto(c.passageiro_contato, 'A corrida já começou e não pode mais ser cancelada por aqui. Fale com o motorista.');
  await pool.query("UPDATE corridas SET status = 'cancelada', cancelada_em = now(), cancelado_por = 'passageiro', oferta_motorista = NULL WHERE id = $1", [c.id]);
  await whats.texto(c.passageiro_contato, '❌ Corrida cancelada. Quando precisar é só mandar *oi*.');
  const avisar = c.motorista_id || c.oferta_motorista;
  if (avisar) {
    const { rows } = await pool.query('SELECT * FROM motoristas WHERE id = $1', [avisar]);
    const saldo = await devolverCredito(c);
    if (rows[0]) await whats.texto(contatoMotorista(rows[0]), `❌ O passageiro cancelou a corrida #${c.id}. Você continua disponível.` +
      (saldo != null ? `\n🎟️ A viagem foi devolvida. Saldo: *${saldo}*` : ''));
  }
}

// corrida aceita que foi cancelada antes de começar: a viagem volta para o motorista
async function devolverCredito(c) {
  if (!c.credito_usado || !c.motorista_id) return null;
  await pool.query('UPDATE corridas SET credito_usado = false WHERE id = $1', [c.id]);
  return moverCreditos(c.motorista_id, 1, 'estorno', { corrida: c.id });
}

// ---------------------------------------------------------------- distribuição das chamadas

const contatoMotorista = (m) => m.contato || m.telefone;

// Oferece a corrida ao motorista livre mais próximo que ainda não recebeu essa chamada.
async function despachar(corridaId) {
  const cfg = await lerConfig();
  const { rows: [c] } = await pool.query("SELECT * FROM corridas WHERE id = $1 AND status = 'procurando'", [corridaId]);
  if (!c) return;

  const { rows: livres } = await pool.query(`
    SELECT m.* FROM motoristas m
     WHERE m.ativo AND m.aprovado AND m.online AND m.tipo = $3 AND NOT (m.id = ANY($1)) AND (NOT $4 OR m.creditos > 0)
       AND NOT EXISTS (SELECT 1 FROM corridas o WHERE o.id <> $2 AND (
             (o.motorista_id = m.id AND o.status IN ('aceita', 'chegou', 'em_andamento'))
          OR (o.oferta_motorista = m.id AND o.status = 'procurando')))`, [c.ja_ofertados, c.id, c.tipo, !!cfg.cobranca_ativa]);

  const origem = ponto(c.origem_lat, c.origem_lng);
  const recente = (m) => m.lat != null && m.local_em && Date.now() - new Date(m.local_em) < 3 * 3600_000;
  const dist = (m) => (origem && recente(m) ? geo.kmLinhaReta(origem, ponto(m.lat, m.lng)) : Infinity);
  livres.sort((a, b) => dist(a) - dist(b) || Math.random() - 0.5);
  const m = livres[0];

  if (!m) {
    const minutos = (Date.now() - new Date(c.criado_em)) / 60_000;
    const { rows: [ocupados] } = await pool.query(
      'SELECT count(*)::int AS n FROM motoristas WHERE ativo AND aprovado AND online AND tipo = $2 AND NOT (id = ANY($1)) AND (NOT $3 OR creditos > 0)',
      [c.ja_ofertados, c.tipo, !!cfg.cobranca_ativa]);
    if (ocupados.n > 0 && minutos < ESPERA_MAX_MIN) {
      // todos ocupados agora: tenta de novo daqui a pouco
      await pool.query("UPDATE corridas SET oferta_motorista = NULL, oferta_expira = now() + interval '15 seconds' WHERE id = $1", [c.id]);
      return;
    }
    await pool.query("UPDATE corridas SET status = 'sem_motorista', cancelada_em = now(), oferta_motorista = NULL, oferta_expira = NULL WHERE id = $1", [c.id]);
    await whats.texto(c.passageiro_contato, `😕 Desculpe, nenhum motorista de *${TIPOS[c.tipo].nome.toLowerCase()}* disponível agora.\nTente de novo em alguns minutos mandando *oi*.`);
    if (cfg.numero_admin) await whats.texto(cfg.numero_admin, `⚠️ Corrida #${c.id} (${rotulo(c.tipo)}) ficou sem motorista.\nPassageiro: ${c.passageiro_nome} (wa.me/${c.passageiro_tel})\nSaída: ${c.origem_texto}`);
    return;
  }

  const seg = Math.max(15, Number(cfg.oferta_segundos) || 40);
  await pool.query(
    `UPDATE corridas SET oferta_motorista = $2, oferta_expira = now() + make_interval(secs => $3),
            ja_ofertados = array_append(ja_ofertados, $2) WHERE id = $1`, [c.id, m.id, seg]);

  const km = dist(m);
  const linhas = [
    `🔔 *NOVA CORRIDA #${c.id}* · ${rotulo(c.tipo)}`,
    `📍 Saída: ${c.origem_texto}` + (Number.isFinite(km) ? ` (a ${km.toFixed(1).replace('.', ',')} km de você)` : ''),
    `🏁 Destino: ${c.destino_texto}`,
    c.valor_estimado != null ? `💰 ${geo.reais(c.valor_estimado)} (${String(Number(c.km)).replace('.', ',')} km)` : '💰 Valor no taxímetro',
    '',
    `Responda *1* para ACEITAR ou *2* para recusar.\n⏱️ Você tem ${seg} segundos.`,
  ];
  await whats.texto(contatoMotorista(m), linhas.join('\n'));
}

// Privacidade: a localização exata do cliente só serve enquanto a corrida acontece.
// Corrida encerrada perde as coordenadas (ficam o nome do lugar, os km e o valor para os relatórios);
// pedido abandonado no meio (mandou a localização e não confirmou) é apagado depois de 1 hora.
async function limparLocalizacoes() {
  const { rowCount: corridas } = await pool.query(`
    UPDATE corridas SET origem_lat = NULL, origem_lng = NULL, destino_lat = NULL, destino_lng = NULL
     WHERE status IN ('finalizada', 'cancelada', 'sem_motorista')
       AND (origem_lat IS NOT NULL OR destino_lat IS NOT NULL)`);
  const { rowCount: conversas } = await pool.query(`
    UPDATE conversas SET etapa = 'inicio', dados = '{}'
     WHERE dados <> '{}' AND atualizado_em < now() - interval '1 hour'`);
  if (corridas || conversas) console.log(`Privacidade: localização apagada de ${corridas} corrida(s) encerrada(s) e ${conversas} pedido(s) abandonado(s).`);
}

// Chamadas que passaram do tempo vão para o próximo motorista.
async function varrer() {
  return rodar(async () => {
    const { rows } = await pool.query(
      "SELECT c.id, c.oferta_motorista FROM corridas c WHERE c.status = 'procurando' AND (c.oferta_expira IS NULL OR c.oferta_expira < now()) ORDER BY c.id");
    for (const c of rows) {
      if (c.oferta_motorista) {
        const { rows: [m] } = await pool.query('SELECT * FROM motoristas WHERE id = $1', [c.oferta_motorista]);
        if (m) await whats.texto(contatoMotorista(m), `⏰ Tempo esgotado: a corrida #${c.id} foi passada para outro motorista.`);
      }
      await despachar(c.id);
    }
  });
}

// ---------------------------------------------------------------- motorista

const AJUDA_MOTORISTA = [
  '*Comandos do motorista*',
  '🟢 *ONLINE* · começar a receber corridas',
  '🔴 *OFFLINE* · parar de receber',
  '📍 Envie sua *localização* (de preferência *em tempo real*) para receber as corridas mais perto',
  '1️⃣ *ACEITAR* · 2️⃣ *RECUSAR* uma chamada',
  '📍 *CHEGUEI* · avisa o passageiro que você chegou',
  '▶️ *INICIAR* · passageiro embarcou',
  '🏁 *FINALIZAR* · encerra (ou *FINALIZAR 15* para informar o valor)',
  '❌ *CANCELAR* · desiste da corrida aceita',
  '🎟️ *SALDO* · quantas viagens você tem · *COMPRAR* · comprar mais',
  '📊 *RELATORIO* · suas corridas e ganhos do mês',
].join('\n');

async function tratarMotorista(m, msg) {
  const contato = msg.contato;
  if (contato && contato !== m.contato) await pool.query('UPDATE motoristas SET contato = $2 WHERE id = $1', [m.id, contato]);
  m.contato = contato || m.contato;

  if (msg.local) {
    // privacidade: a posição só é guardada enquanto o motorista está ONLINE
    if (!m.online) {
      if (msg.local.aoVivo) return; // esqueceu a localização em tempo real ligada: ignora sem responder
      return whats.texto(contato, '🔴 Você está *OFFLINE*, então a central não guarda sua localização.\nEnvie *ONLINE* e depois a localização.');
    }
    await pool.query('UPDATE motoristas SET lat = $2, lng = $3, local_em = now() WHERE id = $1', [m.id, msg.local.lat, msg.local.lng]);
    if (msg.local.aoVivo) return; // localização em tempo real chega toda hora: não responde
    return whats.texto(contato, '📍 Localização atualizada.');
  }

  const [cmd, ...resto] = normalizar(msg.texto).split(/\s+/);
  const cfg = await lerConfig();

  if (msg.midia) return receberComprovante(m, contato, cfg);
  if (['SALDO', 'CREDITOS', 'CREDITO', 'VIAGENS'].includes(cmd)) return mostrarSaldo(m, contato, cfg);
  if (['RELATORIO', 'EXTRATO', 'RESUMO'].includes(cmd)) {
    const { de, ate } = relatorio.mesAtual();
    return whats.texto(contato, relatorio.texto(await relatorio.montar(m.id, de, ate), cfg.nome, cfg.cobranca_ativa));
  }
  if (['COMPRAR', 'RECARGA', 'RECARREGAR', 'PACOTE'].includes(cmd)) return comprar(m, contato, cfg, resto[0]);

  if (['ONLINE', 'ON', 'LIGAR'].includes(cmd)) {
    await pool.query('UPDATE motoristas SET online = true WHERE id = $1', [m.id]);
    const semSaldo = cfg.cobranca_ativa && m.creditos <= 0;
    return whats.texto(contato, `🟢 Você está *ONLINE* na ${cfg.nome}, ${primeiroNome(m.nome)}!\n` +
      'Envie sua *localização em tempo real* 📍 para receber as corridas mais perto de você.' +
      (cfg.cobranca_ativa ? `\n\n🎟️ Saldo: *${m.creditos} viage${m.creditos === 1 ? 'm' : 'ns'}*` : '') +
      (semSaldo ? '\n⚠️ *Sem viagens você não recebe corridas.* Envie *COMPRAR*.' : ''));
  }
  if (['OFFLINE', 'OFF', 'DESLIGAR'].includes(cmd)) {
    // privacidade: fora do ar, a central não guarda onde o motorista está
    await pool.query('UPDATE motoristas SET online = false, lat = NULL, lng = NULL, local_em = NULL WHERE id = $1', [m.id]);
    const { rows: [c] } = await pool.query("SELECT id FROM corridas WHERE status = 'procurando' AND oferta_motorista = $1", [m.id]);
    if (c) await passarAdiante(c.id);
    return whats.texto(contato, '🔴 Você está *OFFLINE*. Não vai receber corridas e sua localização foi apagada da central.\nPara voltar, envie *ONLINE* e a localização.');
  }
  if (['1', 'ACEITAR', 'ACEITO', 'SIM'].includes(cmd)) return aceitar(m);
  if (['2', 'RECUSAR', 'RECUSO', 'NAO'].includes(cmd)) {
    const { rows: [c] } = await pool.query("SELECT id FROM corridas WHERE status = 'procurando' AND oferta_motorista = $1", [m.id]);
    if (!c) return whats.texto(contato, 'Você não tem nenhuma chamada aberta agora.');
    await whats.texto(contato, `👍 Corrida #${c.id} recusada.`);
    return passarAdiante(c.id);
  }

  const c = await corridaAtivaDoMotorista(m.id);
  if (cmd === 'CHEGUEI') {
    if (!c || c.status !== 'aceita') return whats.texto(contato, 'Você não tem corrida aguardando chegada.');
    await pool.query("UPDATE corridas SET status = 'chegou', chegou_em = now() WHERE id = $1", [c.id]);
    await whats.texto(c.passageiro_contato, `📍 *${primeiroNome(m.nome)} chegou!* ${veiculo(m)} ${m.placa} está te esperando.`);
    return whats.texto(contato, '✅ Passageiro avisado. Quando ele embarcar, envie *INICIAR*.');
  }
  if (cmd === 'INICIAR') {
    if (!c || !['aceita', 'chegou'].includes(c.status)) return whats.texto(contato, 'Você não tem corrida para iniciar.');
    await pool.query("UPDATE corridas SET status = 'em_andamento', iniciada_em = now() WHERE id = $1", [c.id]);
    return whats.texto(contato, '▶️ Corrida iniciada. Ao chegar no destino, envie *FINALIZAR*.');
  }
  if (cmd === 'FINALIZAR') {
    if (!c) return whats.texto(contato, 'Você não tem corrida em andamento.');
    return finalizar(m, c, resto.join(' '), cfg);
  }
  if (cmd === 'CANCELAR') {
    if (!c) return whats.texto(contato, 'Você não tem corrida para cancelar.');
    if (c.status === 'em_andamento') return whats.texto(contato, 'A corrida já começou. Para encerrar, envie *FINALIZAR*.');
    await pool.query(
      "UPDATE corridas SET status = 'procurando', motorista_id = NULL, aceita_em = NULL, oferta_motorista = NULL, oferta_expira = NULL, credito_usado = false WHERE id = $1", [c.id]);
    await whats.texto(contato, `❌ Você desistiu da corrida #${c.id}.`);
    await whats.texto(c.passageiro_contato, '⚠️ O motorista precisou cancelar. Já estamos procurando outro para você... ⏳');
    return despachar(c.id);
  }

  const situacao = (c ? `\n\nVocê está na corrida *#${c.id}* (${c.status.replace('_', ' ')}).` : `\n\nVocê está *${m.online ? 'ONLINE 🟢' : 'OFFLINE 🔴'}*.`) +
    (cfg.cobranca_ativa ? `\n🎟️ Saldo: *${m.creditos}* viagens.` : '');
  return whats.texto(contato, AJUDA_MOTORISTA + situacao);
}

async function passarAdiante(corridaId) {
  await pool.query('UPDATE corridas SET oferta_motorista = NULL, oferta_expira = NULL WHERE id = $1', [corridaId]);
  await despachar(corridaId);
}

async function aceitar(m) {
  const { rows: [c] } = await pool.query(
    `UPDATE corridas SET status = 'aceita', motorista_id = $1, aceita_em = now(), oferta_motorista = NULL, oferta_expira = NULL
      WHERE status = 'procurando' AND oferta_motorista = $1 RETURNING *`, [m.id]);
  if (!c) return whats.texto(contatoMotorista(m), '⚠️ Essa corrida não está mais disponível (o tempo acabou ou o passageiro cancelou).');
  const cfg = await lerConfig();
  let saldo = null;
  if (cfg.cobranca_ativa) {
    await pool.query('UPDATE corridas SET credito_usado = true WHERE id = $1', [c.id]);
    saldo = await moverCreditos(m.id, -1, 'corrida', { corrida: c.id });
  }

  const origem = ponto(c.origem_lat, c.origem_lng);
  const pertoDe = origem && m.lat != null ? geo.kmLinhaReta(origem, ponto(m.lat, m.lng)) : null;
  const minutos = pertoDe != null ? Math.max(2, Math.round((pertoDe * 1.3 / 25) * 60)) : null; // ~25 km/h na cidade

  const avisoPassageiro = ['✅ *Motorista a caminho!*', `👤 ${m.nome}`, `${emoji(m.tipo)} ${[veiculo(m), m.placa].filter(Boolean).join(' · ')}`, `📞 wa.me/${m.telefone}`];
  if (minutos) avisoPassageiro.push(`⏱️ Chega em cerca de ${minutos} min`);
  avisoPassageiro.push('', 'Para cancelar, envie *CANCELAR*.');
  await whats.texto(c.passageiro_contato, avisoPassageiro.join('\n'));

  const contato = contatoMotorista(m);
  await whats.texto(contato, [
    `✅ *Corrida #${c.id} é sua!*`,
    `👤 ${c.passageiro_nome || 'Passageiro'} · wa.me/${c.passageiro_tel}`,
    `📍 Buscar em: ${c.origem_texto}` + (origem ? `\n${geo.linkMapa(origem)}` : ''),
    `🏁 Levar para: ${c.destino_texto}` + (c.destino_lat != null ? `\n${geo.linkMapa(ponto(c.destino_lat, c.destino_lng))}` : ''),
    c.valor_estimado != null ? `💰 ${geo.reais(c.valor_estimado)}` : '💰 Valor no taxímetro (informe no FINALIZAR)',
    '',
    'Ao chegar envie *CHEGUEI*. Quando embarcar, *INICIAR*. No fim, *FINALIZAR*.',
  ].join('\n') + (saldo != null ? `\n\n🎟️ 1 viagem usada · saldo: *${saldo}*` +
    (saldo === 0 ? '\n⚠️ Suas viagens acabaram! Envie *COMPRAR* para continuar recebendo corridas.' : saldo <= 2 ? ' (está acabando, envie *COMPRAR*)' : '') : ''));
  if (origem) await whats.local(contato, origem.lat, origem.lng, 'Buscar passageiro', c.origem_texto);
}

async function finalizar(m, c, valorTxt, cfg) {
  const informado = Number(String(valorTxt).replace(/[^\d,.]/g, '').replace(',', '.'));
  const valor = informado > 0 ? informado : Number(c.valor_estimado ?? (cfg.precos[c.tipo] || cfg.precos.carro).minimo);
  const comissao = Math.round(valor * Number(cfg.comissao_pct || 0)) / 100;
  await pool.query(
    "UPDATE corridas SET status = 'finalizada', valor_final = $2, comissao = $3, finalizada_em = now() WHERE id = $1", [c.id, valor, comissao]);
  await pool.query("UPDATE conversas SET etapa = 'avaliar', dados = $2, atualizado_em = now() WHERE telefone = $1",
    [c.passageiro_tel, JSON.stringify({ corrida_id: c.id })]);
  await whats.texto(c.passageiro_contato,
    `🏁 *Corrida finalizada!*\n💰 Valor: *${geo.reais(valor)}*\n\nObrigado por viajar com a ${cfg.nome}! 💙\n` +
    `Como foi a corrida com ${primeiroNome(m.nome)}? Responda de *1* a *5* ⭐`);
  return whats.texto(contatoMotorista(m),
    `✅ Corrida #${c.id} finalizada: ${geo.reais(valor)}` + (comissao ? ` (comissão da central ${geo.reais(comissao)})` : '') +
    `\nVocê continua *${m.online ? 'ONLINE 🟢' : 'OFFLINE 🔴'}*.`);
}

// ---------------------------------------------------------------- viagens (créditos) do motorista

async function mostrarSaldo(m, contato, cfg) {
  if (!cfg.cobranca_ativa) return whats.texto(contato, 'A central não está cobrando por viagem no momento. 🙂');
  const { rows: [usadas] } = await pool.query(
    "SELECT count(*)::int AS n FROM creditos_mov WHERE motorista_id = $1 AND motivo = 'corrida' AND criado_em > now() - interval '30 days'", [m.id]);
  return whats.texto(contato, `🎟️ *Seu saldo: ${m.creditos} viage${m.creditos === 1 ? 'm' : 'ns'}*\n` +
    `Corridas nos últimos 30 dias: ${usadas.n}\n\nCada corrida aceita usa 1 viagem. Para comprar mais, envie *COMPRAR*.`);
}

async function comprar(m, contato, cfg, qtdTxt) {
  if (!cfg.cobranca_ativa) return whats.texto(contato, 'A central não está cobrando por viagem no momento. 🙂');
  const pacotes = pacotesComDesconto(cfg);
  const qtd = Number(qtdTxt);
  const pacote = pacotes.find((p) => p.qtd === qtd);
  if (!pacote) {
    const plural = (n) => `${n} viage${n === 1 ? 'm' : 'ns'}`;
    return whats.texto(contato, '🎟️ *Comprar viagens*\n\n' +
      pacotes.map((p) => `• *${plural(p.qtd)}* · *${geo.reais(p.preco)}*` +
        (p.qtd > 1 ? ` (${geo.reais(p.cada)} cada${p.desconto > 0 ? ` · ${p.desconto}% off 🔥` : ''})` : '') +
        `\n   → envie *COMPRAR ${p.qtd}*`).join('\n') +
      `\n\nSeu saldo agora: *${m.creditos}*`);
  }
  const { compra, pix } = await criarCompra(m, pacote, cfg);
  if (pix) {
    await whats.texto(contato, `🧾 *Pedido #${compra.id}: ${qtd} viagens*\n💰 Valor: *${geo.reais(compra.valor)}*\n\n` +
      `Pague com o *Pix copia e cola* da próxima mensagem (vale ${MP.VALIDADE_MIN} minutos).\n` +
      '✅ As viagens entram *na hora* em que o pagamento for aprovado. Não precisa mandar comprovante.');
    if (pix.qr_base64) whats.imagem(contato, pix.qr_base64, 'QR Code do Pix');
    return whats.texto(contato, pix.copia_cola);
  }
  const chave = cfg.pix_chave ? `🔑 Chave Pix: *${cfg.pix_chave}*` + (cfg.pix_nome ? `\n👤 ${cfg.pix_nome}` : '') : '🔑 A central vai te passar a chave Pix.';
  return whats.texto(contato, `🧾 *Pedido #${compra.id}: ${qtd} viagens*\n💰 Valor: *${geo.reais(compra.valor)}*\n\n${chave}\n\n` +
    'Faça o Pix e *mande a foto do comprovante aqui*. Assim que a central confirmar, as viagens entram no seu saldo. ✅');
}

// Cria o pedido de compra de um pacote (usado pelo WhatsApp e pela área do motorista no site).
// Com Mercado Pago devolve o Pix (copia e cola); sem ele, avisa a central para conferir o Pix manual.
async function criarCompra(m, pacote, cfg) {
  const valor = Math.round(pacote.preco * 100) / 100;
  // pedido anterior sem pagar perde a validade (e o Pix dele é cancelado no Mercado Pago)
  const { rows: velhas } = await pool.query(
    "UPDATE compras SET status = 'cancelado' WHERE motorista_id = $1 AND status = 'pendente' RETURNING mp_id", [m.id]);
  for (const v of velhas) if (v.mp_id && MP.configurado()) MP.cancelar(v.mp_id).catch((e) => console.error('mp cancelar', e.message));
  const { rows: [compra] } = await pool.query(
    'INSERT INTO compras (motorista_id, quantidade, valor) VALUES ($1, $2, $3) RETURNING *', [m.id, pacote.qtd, valor]);

  if (MP.configurado() && cfg.mp_ativo !== false && valor >= 1) {
    try {
      const pix = await MP.criarPix(compra, { nome: m.nome, descricao: `${cfg.nome} - ${pacote.qtd} viagens (motorista #${m.id})` });
      await pool.query('UPDATE compras SET mp_id = $2, pix_copia_cola = $3, pix_expira = $4 WHERE id = $1', [compra.id, pix.id, pix.copia_cola, pix.expira]);
      Object.assign(compra, { mp_id: pix.id, pix_copia_cola: pix.copia_cola, pix_expira: pix.expira });
      return { compra, pix };
    } catch (e) {
      console.error('mercado pago', compra.id, e.message); // segue com a chave Pix manual
    }
  }
  if (cfg.numero_admin) {
    await whats.texto(cfg.numero_admin, `💰 *Pedido de compra #${compra.id}*\n👤 ${m.nome} (${rotulo(m.tipo)})\n🎟️ ${pacote.qtd} viagens · *${geo.reais(valor)}*\n\n` +
      'Quando o Pix cair, confirme no painel em *Motoristas*.');
  }
  return { compra, pix: null };
}

async function receberComprovante(m, contato, cfg) {
  const { rows: [compra] } = await pool.query(
    "SELECT * FROM compras WHERE motorista_id = $1 AND status = 'pendente' ORDER BY id DESC LIMIT 1", [m.id]);
  if (!compra) return whats.texto(contato, 'Recebi o arquivo, mas você não tem compra em aberto. Para comprar viagens, envie *COMPRAR*.');
  if (compra.mp_id) {
    // Pix do Mercado Pago: confere agora mesmo em vez de esperar
    // já estamos dentro da fila do robô: usa a versão que não entra nela de novo
    await MP.consultar(compra.mp_id).then(aplicarPagamentoMP).catch((e) => console.error('mp consulta', e.message));
    const { rows: [atual] } = await pool.query('SELECT status FROM compras WHERE id = $1', [compra.id]);
    if (atual.status === 'pago') return;
    return whats.texto(contato, '⏳ O Mercado Pago ainda não confirmou esse Pix. Assim que confirmar, as viagens entram sozinhas (às vezes leva 1 ou 2 minutos).');
  }
  await pool.query('UPDATE compras SET comprovante = true WHERE id = $1', [compra.id]);
  if (cfg.numero_admin) {
    await whats.texto(cfg.numero_admin, `📎 ${m.nome} mandou o comprovante da compra #${compra.id} (${compra.quantidade} viagens · ${geo.reais(compra.valor)}).\n` +
      `Confira o Pix e confirme no painel. Comprovante: wa.me/${m.telefone}`);
  }
  return whats.texto(contato, '📎 Comprovante recebido! Assim que a central confirmar, suas viagens entram no saldo. 🙌');
}

// libera as viagens de uma compra paga (pelo Mercado Pago ou confirmada pela central)
async function confirmarCompra(compraId, pagoPor) {
  const { rows: [c] } = await pool.query(
    "UPDATE compras SET status = 'pago', pago_em = now(), pago_por = $2 WHERE id = $1 AND status = 'pendente' RETURNING *", [compraId, pagoPor]);
  if (!c) return null;
  const saldo = await moverCreditos(c.motorista_id, c.quantidade, 'compra', { compra: c.id });
  const { rows: [m] } = await pool.query('SELECT nome, telefone, contato, online FROM motoristas WHERE id = $1', [c.motorista_id]);
  await whats.texto(contatoMotorista(m), `✅ *Pagamento confirmado!*\n🎟️ +${c.quantidade} viagens · saldo: *${saldo}*\n\n` +
    (m.online ? 'Boas corridas! 🚀' : 'Envie *ONLINE* para começar a receber corridas.'));
  const cfg = await lerConfig();
  if (pagoPor === 'mercado_pago' && cfg.numero_admin) {
    await whats.texto(cfg.numero_admin, `💰 ${m.nome} comprou ${c.quantidade} viagens · ${geo.reais(c.valor)} (Pix Mercado Pago, já liberado).`);
  }
  return { ...c, saldo };
}

// confere o Pix no Mercado Pago (vem do webhook ou da ronda) e libera se pagou
async function processarPagamentoMP(mpId) {
  const pg = await MP.consultar(mpId);
  return rodar(() => aplicarPagamentoMP(pg));
}

async function aplicarPagamentoMP(pg) {
  // o pagamento tem que ser o mesmo que guardamos na compra que ele diz pagar
  const { rows: [c] } = await pool.query('SELECT * FROM compras WHERE mp_id = $1 AND id = $2', [pg.id, pg.compra || 0]);
  await pool.query('UPDATE compras SET mp_checado_em = now() WHERE mp_id = $1', [pg.id]);
  if (!c) return;
  if (pg.status === 'approved' && pg.valor + 0.009 >= Number(c.valor)) {
    if (c.status === 'pendente') return confirmarCompra(c.id, 'mercado_pago');
    if (c.status === 'cancelado') {
      // pagou um Pix que já tinha sido trocado por outro: libera do mesmo jeito, o dinheiro entrou
      await pool.query("UPDATE compras SET status = 'pendente' WHERE id = $1 AND status = 'cancelado'", [c.id]);
      return confirmarCompra(c.id, 'mercado_pago');
    }
  } else if (pg.status === 'expired' && c.status === 'pendente') {
    await pool.query("UPDATE compras SET status = 'cancelado' WHERE id = $1", [c.id]);
    const { rows: [m] } = await pool.query('SELECT telefone, contato FROM motoristas WHERE id = $1', [c.motorista_id]);
    await whats.texto(contatoMotorista(m), `⌛ O Pix do pedido #${c.id} (${c.quantidade} viagens) venceu sem pagamento. Para comprar, envie *COMPRAR* de novo.`);
  }
}

// rede de segurança caso o aviso do Mercado Pago não chegue: confere os Pix em aberto
async function rondaMP() {
  if (!MP.configurado()) return;
  const { rows } = await pool.query(`SELECT mp_id FROM compras
     WHERE mp_id IS NOT NULL AND status IN ('pendente', 'cancelado') AND pago_em IS NULL AND criado_em > now() - interval '2 days'
       AND (mp_checado_em IS NULL OR mp_checado_em < now() - CASE WHEN criado_em > now() - interval '40 minutes' THEN interval '40 seconds' ELSE interval '15 minutes' END)
     ORDER BY criado_em DESC LIMIT 20`);
  for (const r of rows) await processarPagamentoMP(r.mp_id).catch((e) => console.error('mp consulta', e.message));
}


function acaoSite(motoristaId, corridaId, acao) {
  return rodar(async () => {
    const falhar = (msg) => { const e = new Error(msg); e.status = 409; throw e; };
    if (!['aceitar','cheguei','iniciar','finalizar'].includes(acao)) return falhar('Ação inválida.');
    const { rows: [m] } = await pool.query('SELECT * FROM motoristas WHERE id = $1 AND ativo AND aprovado', [motoristaId]);
    if (!m) return falhar('Motorista indisponível.');
    const { rows: [c] } = await pool.query('SELECT *, oferta_expira > now() AS oferta_valida FROM corridas WHERE id = $1', [corridaId]);
    if (!c) return falhar('Corrida não encontrada.');
    if (acao === 'aceitar') {
      if (!m.online || c.status !== 'procurando' || c.oferta_motorista !== m.id || !c.oferta_valida) return falhar('Essa oferta não está mais disponível.');
      if (await corridaAtivaDoMotorista(m.id)) return falhar('Você já tem uma corrida em andamento.');
      const cfg = await lerConfig();
      if (cfg.cobranca_ativa && m.creditos <= 0) return falhar('Saldo de viagens insuficiente.');
    } else {
      const estados = {cheguei:['aceita'], iniciar:['aceita','chegou'], finalizar:['em_andamento']};
      if (c.motorista_id !== m.id || !estados[acao].includes(c.status)) return falhar('A corrida mudou. Atualize a tela.');
    }
    await tratarMotorista(m, {contato:m.contato || m.telefone, texto:acao.toUpperCase()});
    return {ok:true};
  });
}

module.exports = { cancelarPeloPassageiro, acaoSite, receber, varrer, despachar, rodar, devolverCredito, limparLocalizacoes, criarCompra, confirmarCompra, processarPagamentoMP, rondaMP, AJUDA_MOTORISTA };
