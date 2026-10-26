// Robô das corridas: conversa com passageiros e motoristas e distribui as chamadas.
//
// Tudo passa por uma fila única (rodar), então duas mensagens nunca mexem na mesma corrida ao
// mesmo tempo (ex.: dois motoristas aceitando juntos). Para cidade pequena isso sobra.
const { pool, lerConfig } = require('./db');
const whats = require('./whats');
const geo = require('./geo');

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

// ---------------------------------------------------------------- consultas

async function motoristaPorTelefone(tel) {
  if (String(tel).length < 8) return null;
  const { rows } = await pool.query(
    'SELECT * FROM motoristas WHERE ativo AND right(telefone, 8) = right($1, 8) ORDER BY id LIMIT 1', [tel]);
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

// msg = { telefone, contato, nome, texto, local: { lat, lng, nome, endereco, aoVivo } | null }
function receber(msg) {
  return rodar(async () => {
    const m = await motoristaPorTelefone(msg.telefone);
    if (m) return tratarMotorista(m, msg);
    return tratarPassageiro(msg);
  });
}

// ---------------------------------------------------------------- passageiro

async function tratarPassageiro(msg) {
  const cfg = await lerConfig();
  const { telefone, contato } = msg;
  const cmd = normalizar(msg.texto);

  const { rows } = await pool.query(
    `INSERT INTO conversas (telefone, contato, nome) VALUES ($1, $2, $3)
     ON CONFLICT (telefone) DO UPDATE SET contato = EXCLUDED.contato, nome = COALESCE(NULLIF(EXCLUDED.nome, ''), conversas.nome)
     RETURNING *, extract(epoch FROM now() - atualizado_em) / 60 AS minutos`, [telefone, contato, msg.nome || '']);
  const conv = rows[0];
  let etapa = conv.etapa;
  if (['origem', 'destino', 'confirmar'].includes(etapa) && conv.minutos > CONVERSA_EXPIRA_MIN) etapa = 'inicio';

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
    return whats.texto(contato, 'Pedido cancelado. Quando precisar é só mandar *oi*. 👋');
  }

  if (etapa === 'inicio') {
    if (!cfg.aceitando) return whats.texto(contato, `🚫 A ${cfg.nome} não está aceitando corridas agora. Tente mais tarde.`);
    if (!msg.local) {
      await salvarConversa(telefone, 'origem');
      const nome = primeiroNome(msg.nome || conv.nome);
      return whats.texto(contato,
        `Olá${nome ? ' ' + nome : ''}! 🚗 Bem-vindo à *${cfg.nome}*.\n\n` +
        'Para pedir um carro, envie sua *localização* 📍\n(toque no clipe 📎 › *Localização* › *Enviar localização atual*)\n\n' +
        'Ou digite o endereço de onde você está.');
    }
    etapa = 'origem'; // já mandou a localização de cara
  }

  if (etapa === 'origem') {
    const origem = await lerPonto(msg, cfg);
    if (!origem) return whats.texto(contato, 'Não entendi. 🤔 Envie sua *localização* 📍 ou digite o endereço (rua e número, ou um ponto conhecido).');
    await salvarConversa(telefone, 'destino', { origem });
    return whats.texto(contato, '✅ Local de saída anotado.\n\n🏁 *Para onde você vai?*\nDigite o endereço ou envie a localização do destino.');
  }

  if (etapa === 'destino') {
    const destino = await lerPonto(msg, cfg);
    if (!destino) return whats.texto(contato, 'Não entendi. 🤔 Digite o endereço de destino ou envie a localização.');
    const dados = { ...conv.dados, destino };
    dados.km = geo.kmRota(dados.origem, destino, cfg);
    dados.valor = geo.preco(dados.km, cfg);
    await salvarConversa(telefone, 'confirmar', dados);
    return whats.texto(contato, resumoPedido(dados, cfg) + '\n\n*Confirma a corrida?*\n1️⃣ Sim\n2️⃣ Não');
  }

  if (etapa === 'confirmar') {
    if (['1', 'SIM', 'S', 'CONFIRMAR', 'OK'].includes(cmd)) return criarCorrida(conv, msg);
    if (['2', 'NAO', 'N'].includes(cmd)) {
      await salvarConversa(telefone, 'inicio');
      return whats.texto(contato, 'Tudo bem, pedido cancelado. Quando precisar é só mandar *oi*. 👋');
    }
    return whats.texto(contato, 'Responda *1* para confirmar ou *2* para cancelar.');
  }
}

// localização enviada ou endereço digitado
async function lerPonto(msg, cfg) {
  if (msg.local) {
    return { lat: msg.local.lat, lng: msg.local.lng, texto: [msg.local.nome, msg.local.endereco].filter(Boolean).join(' - ') || 'Localização enviada 📍' };
  }
  const txt = String(msg.texto || '').trim().slice(0, 200);
  if (txt.length < 3) return null;
  const achou = await geo.buscarEndereco(txt, cfg);
  return { ...(achou || {}), texto: txt };
}

function resumoPedido(d, cfg) {
  const linhas = [`📍 *Saída:* ${d.origem.texto}`, `🏁 *Destino:* ${d.destino.texto}`];
  if (d.valor != null) linhas.push(`📏 Cerca de ${String(d.km).replace('.', ',')} km`, `💰 *Valor: ${geo.reais(d.valor)}*`);
  else linhas.push(`💰 Valor calculado pelo motorista no fim (mínimo ${geo.reais(cfg.minimo)})`);
  return linhas.join('\n');
}

async function criarCorrida(conv, msg) {
  const d = conv.dados;
  const { rows } = await pool.query(
    `INSERT INTO corridas (passageiro_tel, passageiro_contato, passageiro_nome, origem_texto, origem_lat, origem_lng,
                           destino_texto, destino_lat, destino_lng, km, valor_estimado)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [conv.telefone, msg.contato, msg.nome || conv.nome, d.origem.texto, d.origem.lat ?? null, d.origem.lng ?? null,
      d.destino.texto, d.destino.lat ?? null, d.destino.lng ?? null, d.km, d.valor]);
  await salvarConversa(conv.telefone, 'inicio');
  await whats.texto(msg.contato, '🔎 Procurando um motorista para você... ⏳\nPara cancelar, envie *CANCELAR*.');
  await despachar(rows[0].id);
}

async function motoristaDa(c) {
  if (!c.motorista_id) return null;
  const { rows } = await pool.query('SELECT * FROM motoristas WHERE id = $1', [c.motorista_id]);
  return rows[0] || null;
}

function situacaoParaPassageiro(c, m) {
  if (c.status === 'procurando') return '🔎 Ainda procurando um motorista para você... ⏳\nPara cancelar, envie *CANCELAR*.';
  const carro = m ? `${m.nome} · ${m.carro} ${m.placa}`.trim() : '';
  if (c.status === 'aceita') return `🚗 ${carro} está a caminho.\nPara cancelar, envie *CANCELAR*.`;
  if (c.status === 'chegou') return `📍 ${carro} já está te esperando no local!`;
  return `🛣️ Corrida em andamento com ${carro}. Boa viagem!`;
}

async function cancelarPeloPassageiro(c) {
  if (c.status === 'em_andamento') return whats.texto(c.passageiro_contato, 'A corrida já começou e não pode mais ser cancelada por aqui. Fale com o motorista.');
  await pool.query("UPDATE corridas SET status = 'cancelada', cancelado_por = 'passageiro', oferta_motorista = NULL WHERE id = $1", [c.id]);
  await whats.texto(c.passageiro_contato, '❌ Corrida cancelada. Quando precisar é só mandar *oi*.');
  const avisar = c.motorista_id || c.oferta_motorista;
  if (avisar) {
    const { rows } = await pool.query('SELECT * FROM motoristas WHERE id = $1', [avisar]);
    if (rows[0]) await whats.texto(contatoMotorista(rows[0]), `❌ O passageiro cancelou a corrida #${c.id}. Você continua disponível.`);
  }
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
     WHERE m.ativo AND m.online AND NOT (m.id = ANY($1))
       AND NOT EXISTS (SELECT 1 FROM corridas o WHERE o.id <> $2 AND (
             (o.motorista_id = m.id AND o.status IN ('aceita', 'chegou', 'em_andamento'))
          OR (o.oferta_motorista = m.id AND o.status = 'procurando')))`, [c.ja_ofertados, c.id]);

  const origem = ponto(c.origem_lat, c.origem_lng);
  const recente = (m) => m.lat != null && m.local_em && Date.now() - new Date(m.local_em) < 3 * 3600_000;
  const dist = (m) => (origem && recente(m) ? geo.kmLinhaReta(origem, ponto(m.lat, m.lng)) : Infinity);
  livres.sort((a, b) => dist(a) - dist(b) || Math.random() - 0.5);
  const m = livres[0];

  if (!m) {
    const minutos = (Date.now() - new Date(c.criado_em)) / 60_000;
    const { rows: [ocupados] } = await pool.query(
      'SELECT count(*)::int AS n FROM motoristas WHERE ativo AND online AND NOT (id = ANY($1))', [c.ja_ofertados]);
    if (ocupados.n > 0 && minutos < ESPERA_MAX_MIN) {
      // todos ocupados agora: tenta de novo daqui a pouco
      await pool.query("UPDATE corridas SET oferta_motorista = NULL, oferta_expira = now() + interval '15 seconds' WHERE id = $1", [c.id]);
      return;
    }
    await pool.query("UPDATE corridas SET status = 'sem_motorista', oferta_motorista = NULL, oferta_expira = NULL WHERE id = $1", [c.id]);
    await whats.texto(c.passageiro_contato, '😕 Desculpe, nenhum motorista disponível agora.\nTente de novo em alguns minutos mandando *oi*.');
    if (cfg.numero_admin) await whats.texto(cfg.numero_admin, `⚠️ Corrida #${c.id} ficou sem motorista.\nPassageiro: ${c.passageiro_nome} (wa.me/${c.passageiro_tel})\nSaída: ${c.origem_texto}`);
    return;
  }

  const seg = Math.max(15, Number(cfg.oferta_segundos) || 40);
  await pool.query(
    `UPDATE corridas SET oferta_motorista = $2, oferta_expira = now() + make_interval(secs => $3),
            ja_ofertados = array_append(ja_ofertados, $2) WHERE id = $1`, [c.id, m.id, seg]);

  const km = dist(m);
  const linhas = [
    `🔔 *NOVA CORRIDA #${c.id}*`,
    `📍 Saída: ${c.origem_texto}` + (Number.isFinite(km) ? ` (a ${km.toFixed(1).replace('.', ',')} km de você)` : ''),
    `🏁 Destino: ${c.destino_texto}`,
    c.valor_estimado != null ? `💰 ${geo.reais(c.valor_estimado)} (${String(Number(c.km)).replace('.', ',')} km)` : '💰 Valor no taxímetro',
    '',
    `Responda *1* para ACEITAR ou *2* para recusar.\n⏱️ Você tem ${seg} segundos.`,
  ];
  await whats.texto(contatoMotorista(m), linhas.join('\n'));
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
  '🚗 *CHEGUEI* · avisa o passageiro que você chegou',
  '▶️ *INICIAR* · passageiro embarcou',
  '🏁 *FINALIZAR* · encerra (ou *FINALIZAR 15* para informar o valor)',
  '❌ *CANCELAR* · desiste da corrida aceita',
].join('\n');

async function tratarMotorista(m, msg) {
  const contato = msg.contato;
  if (contato && contato !== m.contato) await pool.query('UPDATE motoristas SET contato = $2 WHERE id = $1', [m.id, contato]);
  m.contato = contato || m.contato;

  if (msg.local) {
    await pool.query('UPDATE motoristas SET lat = $2, lng = $3, local_em = now() WHERE id = $1', [m.id, msg.local.lat, msg.local.lng]);
    if (msg.local.aoVivo) return; // localização em tempo real chega toda hora: não responde
    return whats.texto(contato, '📍 Localização atualizada.' + (m.online ? '' : '\nVocê está *OFFLINE*. Envie *ONLINE* para receber corridas.'));
  }

  const [cmd, ...resto] = normalizar(msg.texto).split(/\s+/);
  const cfg = await lerConfig();

  if (['ONLINE', 'ON', 'LIGAR'].includes(cmd)) {
    await pool.query('UPDATE motoristas SET online = true WHERE id = $1', [m.id]);
    return whats.texto(contato, `🟢 Você está *ONLINE* na ${cfg.nome}, ${primeiroNome(m.nome)}!\n` +
      'Envie sua *localização em tempo real* 📍 para receber as corridas mais perto de você.');
  }
  if (['OFFLINE', 'OFF', 'DESLIGAR'].includes(cmd)) {
    await pool.query('UPDATE motoristas SET online = false WHERE id = $1', [m.id]);
    const { rows: [c] } = await pool.query("SELECT id FROM corridas WHERE status = 'procurando' AND oferta_motorista = $1", [m.id]);
    if (c) await passarAdiante(c.id);
    return whats.texto(contato, '🔴 Você está *OFFLINE*. Não vai receber corridas. Envie *ONLINE* para voltar.');
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
    await pool.query("UPDATE corridas SET status = 'chegou' WHERE id = $1", [c.id]);
    await whats.texto(c.passageiro_contato, `📍 *${primeiroNome(m.nome)} chegou!* ${m.carro} ${m.placa} está te esperando.`);
    return whats.texto(contato, '✅ Passageiro avisado. Quando ele embarcar, envie *INICIAR*.');
  }
  if (cmd === 'INICIAR') {
    if (!c || !['aceita', 'chegou'].includes(c.status)) return whats.texto(contato, 'Você não tem corrida para iniciar.');
    await pool.query("UPDATE corridas SET status = 'em_andamento' WHERE id = $1", [c.id]);
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
      "UPDATE corridas SET status = 'procurando', motorista_id = NULL, aceita_em = NULL, oferta_motorista = NULL, oferta_expira = NULL WHERE id = $1", [c.id]);
    await whats.texto(contato, `❌ Você desistiu da corrida #${c.id}.`);
    await whats.texto(c.passageiro_contato, '⚠️ O motorista precisou cancelar. Já estamos procurando outro para você... ⏳');
    return despachar(c.id);
  }

  const situacao = c ? `\n\nVocê está na corrida *#${c.id}* (${c.status.replace('_', ' ')}).` : `\n\nVocê está *${m.online ? 'ONLINE 🟢' : 'OFFLINE 🔴'}*.`;
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

  const origem = ponto(c.origem_lat, c.origem_lng);
  const pertoDe = origem && m.lat != null ? geo.kmLinhaReta(origem, ponto(m.lat, m.lng)) : null;
  const minutos = pertoDe != null ? Math.max(2, Math.round((pertoDe * 1.3 / 25) * 60)) : null; // ~25 km/h na cidade

  const avisoPassageiro = ['✅ *Motorista a caminho!*', `👤 ${m.nome}`, `🚗 ${[m.carro, m.placa].filter(Boolean).join(' · ')}`, `📞 wa.me/${m.telefone}`];
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
  ].join('\n'));
  if (origem) await whats.local(contato, origem.lat, origem.lng, 'Buscar passageiro', c.origem_texto);
}

async function finalizar(m, c, valorTxt, cfg) {
  const informado = Number(String(valorTxt).replace(/[^\d,.]/g, '').replace(',', '.'));
  const valor = informado > 0 ? informado : Number(c.valor_estimado ?? cfg.minimo);
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

module.exports = { receber, varrer, despachar, rodar };
