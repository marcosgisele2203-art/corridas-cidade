// Central de corridas · servidor do webhook do WhatsApp e do painel do administrador.
//
// Variáveis de ambiente:
//   PORT                porta HTTP (padrão 3000)
//   DATABASE_URL        postgres://usuario:senha@host:5432/banco
//   EVOLUTION_URL       endereço da Evolution API, ex.: https://api.seudominio.com
//   EVOLUTION_INSTANCE  nome da instância conectada ao número da central
//   EVOLUTION_APIKEY    API key da Evolution
//   WEBHOOK_TOKEN       senha que vai no final do endereço do webhook (?token=...)
//   ADMIN_SENHA         senha do painel /painel

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool, migrar, lerConfig, salvarConfig, moverCreditos, pacotesComDesconto, CONFIG_PADRAO } = require('./lib/db');
const bot = require('./lib/bot');
const whats = require('./lib/whats');
const { TIPOS, ORDEM, rotulo, veiculo, coresDo } = require('./lib/tipos');
const MP = require('./lib/mercadopago');
const relatorio = require('./lib/relatorio');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
// tira espaços e aspas que às vezes vêm junto quando a variável é colada no Easypanel
const limparVar = (v) => String(v || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
const MODO_TESTE_SITE = limparVar(process.env.MODO_TESTE_SITE) === 'true';
const WEBHOOK_TOKEN = limparVar(process.env.WEBHOOK_TOKEN);
const ADMIN_SENHA = limparVar(process.env.ADMIN_SENHA);
const PUBLIC = path.join(__dirname, 'public');

// ---------------------------------------------------------------- utilidades

class Erro extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function lerCorpo(req, limite = 2_000_000) {
  return new Promise((resolve, reject) => {
    const partes = []; let tamanho = 0;
    req.on('data', (c) => {
      tamanho += c.length;
      if (tamanho > limite) { reject(new Erro(413, 'Dados grandes demais')); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => {
      const data = Buffer.concat(partes).toString('utf8');
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Erro(400, 'JSON inválido')); }
    });
    req.on('error', reject);
  });
}

const texto = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const soDigitos = (v) => String(v || '').replace(/\D/g, '');
const numero = (v, padrao) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : padrao);

function telefoneBR(v) {
  let t = soDigitos(v);
  if (t.length < 10 || t.length > 13) throw new Erro(400, 'WhatsApp inválido. Use DDD + número.');
  if (!t.startsWith('55')) t = '55' + t;
  return t;
}

// ---------------------------------------------------------------- login do painel (cookie assinado)

const segredo = crypto.createHash('sha256').update('corridas:' + ADMIN_SENHA).digest();
const assinar = (txt) => crypto.createHmac('sha256', segredo).update(txt).digest('base64url');
const DURACAO = 30 * 24 * 3600 * 1000;

function logado(req) {
  const m = /(?:^|;\s*)cc_sessao=(\d+)\.([\w-]+)/.exec(req.headers.cookie || '');
  if (!m || !ADMIN_SENHA || Number(m[1]) < Date.now()) return false;
  const esperado = assinar(m[1]);
  return m[2].length === esperado.length && crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(esperado));
}

const tentativas = new Map();
function limitar(chave, max, janelaMs) {
  const agora = Date.now();
  const lista = (tentativas.get(chave) || []).filter((t) => agora - t < janelaMs);
  lista.push(agora);
  tentativas.set(chave, lista);
  if (lista.length > max) throw new Erro(429, 'Muitas tentativas seguidas. Espere alguns minutos.');
}
const ipDe = (req) => (String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || '');

// ---------------------------------------------------------------- webhook da Evolution

const jaVistas = new Set(); // a Evolution às vezes repete a mesma mensagem

// transforma o aviso da Evolution em { telefone, contato, nome, texto, local }
function lerMensagem(b) {
  if (String(b.event || '').toLowerCase().replace('_', '.') !== 'messages.upsert') return null;
  const d = Array.isArray(b.data) ? b.data[0] : b.data || {};
  const key = d.key || {};
  if (key.fromMe) return null;
  if (key.id) {
    if (jaVistas.has(key.id)) return null;
    jaVistas.add(key.id);
    if (jaVistas.size > 2000) jaVistas.delete(jaVistas.values().next().value);
  }
  // número de verdade: o WhatsApp às vezes manda um "@lid" e o número vem em outro campo
  const jids = [key.remoteJid, key.remoteJidAlt, key.senderPn, d.senderPn].filter(Boolean);
  if (jids.some((j) => j.endsWith('@g.us') || j.endsWith('@broadcast') || j.endsWith('@newsletter'))) return null;
  const pessoal = jids.find((j) => j.endsWith('@s.whatsapp.net'));
  const contato = pessoal || key.remoteJid;
  if (!contato) return null;
  const telefone = (pessoal || contato).split('@')[0].split(':')[0];

  const m = d.message || {};
  const loc = m.locationMessage || m.liveLocationMessage;
  const local = loc && Number.isFinite(Number(loc.degreesLatitude)) ? {
    lat: Number(loc.degreesLatitude), lng: Number(loc.degreesLongitude),
    nome: loc.name || '', endereco: loc.address || '', aoVivo: !!m.liveLocationMessage,
  } : null;
  const arquivo = m.imageMessage || m.documentMessage || m.documentWithCaptionMessage;
  const txt = m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '';
  if (!txt && !local && !arquivo) return null;
  return { telefone, contato: pessoal ? telefone : contato, nome: d.pushName || '', texto: txt, local, midia: !!arquivo };
}

// ---------------------------------------------------------------- rotas

const rotas = [];
const rota = (metodo, caminho, protegida, fn) => rotas.push({ metodo, re: new RegExp('^' + caminho.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), protegida, fn });

// com "Webhook by Events" ligado na Evolution o endereço ganha o evento no fim (/webhook/evolution/messages-upsert)
let avisouSemMensagem = false;
async function webhookEvolution({ req, url }) {
  if (WEBHOOK_TOKEN && url.searchParams.get('token') !== WEBHOOK_TOKEN) {
    console.log('Webhook da Evolution recusado: o token no endereço não é igual ao WEBHOOK_TOKEN.');
    throw new Erro(401, 'Token inválido');
  }
  const b = await lerCorpo(req);
  const msg = lerMensagem(b);
  if (msg) {
    console.log(`Mensagem recebida de ${msg.telefone}: ${msg.local ? '[localização]' : msg.midia ? '[arquivo]' : JSON.stringify(msg.texto.slice(0, 60))}`);
    bot.receber(msg).catch((e) => console.error('Erro ao tratar mensagem:', e));
  } else if (!avisouSemMensagem && b.event && !/messages[._]upsert/i.test(b.event)) {
    avisouSemMensagem = true;
    console.log(`Webhook recebeu o evento "${b.event}". Só o MESSAGES_UPSERT é usado; os outros podem ser desmarcados na Evolution.`);
  }
  return { ok: true };
}
rota('POST', '/webhook/evolution', false, webhookEvolution);
rota('POST', '/webhook/evolution/:evento', false, webhookEvolution);

// aviso do Mercado Pago: só traz o número do pagamento; a situação é sempre conferida na API deles
rota('POST', '/api/mp/webhook', false, async ({ req, url }) => {
  limitar('mp:' + ipDe(req), 120, 60_000);
  const b = await lerCorpo(req).catch(() => ({}));
  const id = String((b.data && b.data.id) || url.searchParams.get('data.id') || url.searchParams.get('id') || '').replace(/[^\w-]/g, '').slice(0, 64);
  const tipo = b.type || b.topic || url.searchParams.get('type') || url.searchParams.get('topic') || '';
  if (id && /order/.test(tipo) && MP.configurado()) await bot.processarPagamentoMP(id).catch((e) => console.error('mp webhook', e.message));
  return { ok: true };
});

// nome da central para a tela de login (não é segredo)
rota('GET', '/api/marca', false, async () => ({ nome: (await lerConfig()).nome }));

rota('GET', '/api/saude', false, async () => {
  await pool.query('SELECT 1');
  return { ok: true, whatsapp: !!whats.EVO.url, painel: !!ADMIN_SENHA, mercado_pago: MP.configurado() };
});

rota('POST', '/api/login', false, async ({ req, res }) => {
  limitar('login:' + ipDe(req), 10, 15 * 60_000);
  if (!ADMIN_SENHA) throw new Erro(503, 'Defina a variável ADMIN_SENHA no Easypanel para usar o painel.');
  const b = await lerCorpo(req);
  const a = crypto.createHash('sha256').update(String(b.senha || '').trim()).digest();
  const e = crypto.createHash('sha256').update(ADMIN_SENHA).digest();
  if (!crypto.timingSafeEqual(a, e)) throw new Erro(401, 'Senha errada.');
  const exp = String(Date.now() + DURACAO);
  const seguro = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `cc_sessao=${exp}.${assinar(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DURACAO / 1000}${seguro}`);
  return { ok: true };
});

rota('POST', '/api/sair', false, async ({ res }) => {
  res.setHeader('Set-Cookie', 'cc_sessao=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  return { ok: true };
});

rota('GET', '/api/cores', true, async () => Object.fromEntries(ORDEM.map((t) => [t, coresDo(t)])));
rota('GET', '/api/config', true, async () => ({ ...(await lerConfig()), mp_configurado: MP.configurado() }));
rota('PUT', '/api/config', true, async ({ req }) => {
  const b = await lerCorpo(req), atual = await lerConfig();
  const novo = { ...atual };
  for (const k of Object.keys(CONFIG_PADRAO)) {
    if (b[k] === undefined || k === 'precos' || k === 'pacotes') continue;
    if (typeof CONFIG_PADRAO[k] === 'number') novo[k] = Math.max(0, numero(b[k], atual[k]));
    else if (typeof CONFIG_PADRAO[k] === 'boolean') novo[k] = !!b[k];
    else novo[k] = texto(b[k], 120);
  }
  if (novo.numero_admin) novo.numero_admin = telefoneBR(novo.numero_admin);
  if (!['auto', '', 'carro-e-moto', 'todos-os-veiculos', 'moto', 'frete'].includes(novo.arte_boas_vindas)) novo.arte_boas_vindas = 'auto';
  if (novo.numero_central) novo.numero_central = telefoneBR(novo.numero_central);
  // "Miranda -MS", "Miranda/MS" ou "Miranda MS" → "Miranda, MS" (o mapa acha melhor com vírgula)
  novo.cidade = String(novo.cidade || '').trim().replace(/\s*[-–/,]?\s*\b([A-Za-z]{2})$/, (m, uf) => ', ' + uf.toUpperCase()).replace(/^,\s*/, '');
  if (b.pacotes !== undefined) {
    // [{ qtd: 10, preco: 9.5 }, ...]: uma quantidade só aparece uma vez, do menor para o maior
    const vistos = new Set();
    novo.pacotes = (Array.isArray(b.pacotes) ? b.pacotes : [])
      .map((p) => ({ qtd: Math.trunc(numero(p.qtd, 0)), preco: Math.round(numero(String(p.preco).replace(',', '.'), 0) * 100) / 100 }))
      .filter((p) => p.qtd > 0 && p.qtd <= 10000 && p.preco > 0 && p.preco <= 100000 && !vistos.has(p.qtd) && vistos.add(p.qtd))
      .sort((x, y) => x.qtd - y.qtd).slice(0, 12);
    if (!novo.pacotes.length) throw new Erro(400, 'Cadastre pelo menos um pacote de viagens com quantidade e preço.');
  }
  if (b.precos) {
    novo.precos = {};
    for (const t of ORDEM) {
      const v = b.precos[t] || {}, a = atual.precos[t];
      novo.precos[t] = {
        ativo: v.ativo === undefined ? a.ativo : !!v.ativo,
        taxa_base: Math.max(0, numero(v.taxa_base, a.taxa_base)),
        por_km: Math.max(0, numero(v.por_km, a.por_km)),
        minimo: Math.max(0, numero(v.minimo, a.minimo)),
      };
    }
    if (!ORDEM.some((t) => novo.precos[t].ativo)) throw new Erro(400, 'Deixe pelo menos um tipo de veículo ligado.');
  }
  await salvarConfig(novo);
  return novo;
});

rota('GET', '/api/motoristas', true, async () => {
  const { rows } = await pool.query(`
    SELECT m.*,
      (SELECT count(*)::int FROM corridas c WHERE c.motorista_id = m.id AND c.status = 'finalizada') AS corridas,
      (SELECT round(avg(avaliacao), 1) FROM corridas c WHERE c.motorista_id = m.id AND avaliacao IS NOT NULL) AS nota,
      (SELECT c.id FROM corridas c WHERE c.motorista_id = m.id AND c.status IN ('aceita', 'chegou', 'em_andamento') LIMIT 1) AS corrida_atual
    FROM motoristas m ORDER BY m.aprovado, m.ativo DESC, m.nome`);
  return rows;
});

function dadosMotorista(b) {
  const nome = texto(b.nome, 80);
  if (!nome) throw new Erro(400, 'Informe o nome do motorista.');
  const tipo = TIPOS[b.tipo] ? b.tipo : 'carro';
  return [nome, telefoneBR(b.telefone), texto(b.carro, 60), texto(b.placa, 10).toUpperCase(), b.ativo !== false, tipo, texto(b.cor, 30).toLowerCase()];
}
async function gravarMotorista(sql, params) {
  try { return (await pool.query(sql, params)).rows[0]; }
  catch (e) { if (e.code === '23505') throw new Erro(400, 'Já existe um motorista com esse WhatsApp.'); throw e; }
}
rota('POST', '/api/motoristas', true, async ({ req }) => {
  const m = await gravarMotorista(
    'INSERT INTO motoristas (nome, telefone, carro, placa, ativo, tipo, cor) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *', dadosMotorista(await lerCorpo(req)));
  await darBoasVindas(m, await lerConfig());
  return m;
});
rota('PUT', '/api/motoristas/:id', true, async ({ req, p }) => {
  const d = dadosMotorista(await lerCorpo(req));
  const m = await gravarMotorista(
    `UPDATE motoristas SET nome = $2, telefone = $3, carro = $4, placa = $5, ativo = $6, tipo = $7, cor = $8,
            online = online AND $6, contato = CASE WHEN telefone = $3 THEN contato ELSE '' END WHERE id = $1 RETURNING *`, [Number(p.id), ...d]);
  if (!m) throw new Erro(404, 'Motorista não encontrado.');
  return m;
});
// viagens grátis uma única vez por motorista
async function darBoasVindas(m, cfg) {
  const n = Number(cfg.creditos_boas_vindas) || 0;
  if (!cfg.cobranca_ativa || n <= 0) return 0;
  const { rows } = await pool.query("SELECT 1 FROM creditos_mov WHERE motorista_id = $1 AND motivo = 'bonus'", [m.id]);
  if (rows.length) return 0;
  await moverCreditos(m.id, n, 'bonus');
  return n;
}

// cadastro feito pelo próprio motorista no WhatsApp: aprovar ou recusar
rota('POST', '/api/motoristas/:id/aprovar', true, async ({ p }) => {
  const { rows: [m] } = await pool.query('UPDATE motoristas SET aprovado = true, ativo = true WHERE id = $1 RETURNING *', [Number(p.id)]);
  if (!m) throw new Erro(404, 'Motorista não encontrado.');
  const cfg = await lerConfig();
  const bonus = await darBoasVindas(m, cfg);
  whats.texto(m.contato || m.telefone, `🎉 *Cadastro aprovado!* Bem-vindo à ${cfg.nome}, ${m.nome.split(' ')[0]}!\n` +
    `${rotulo(m.tipo)} · ${veiculo(m)} · ${m.placa}\n` + (bonus ? `\n🎁 Você ganhou *${bonus} viagens grátis* para começar!\n` : '') + '\n' + bot.AJUDA_MOTORISTA);
  return m;
});
rota('POST', '/api/motoristas/:id/recusar', true, async ({ p }) => {
  const { rows: [m] } = await pool.query('SELECT * FROM motoristas WHERE id = $1 AND NOT aprovado', [Number(p.id)]);
  if (!m) throw new Erro(400, 'Só dá para recusar cadastro que ainda está aguardando aprovação.');
  await pool.query('DELETE FROM motoristas WHERE id = $1', [m.id]);
  const cfg = await lerConfig();
  whats.texto(m.contato || m.telefone, `Olá ${m.nome.split(' ')[0]}. Seu cadastro de motorista na ${cfg.nome} não foi aprovado. Para saber mais, fale com a central.`);
  return { ok: true };
});
// a central dá ou tira viagens na mão (ex.: pagou em dinheiro, cortesia, correção)
rota('POST', '/api/motoristas/:id/creditos', true, async ({ req, p }) => {
  const b = await lerCorpo(req);
  const qtd = Math.trunc(Number(b.quantidade));
  if (!qtd || Math.abs(qtd) > 10000) throw new Erro(400, 'Informe quantas viagens dar (ex.: 10) ou tirar (ex.: -2).');
  return bot.rodar(async () => {
    const { rows: [m] } = await pool.query('SELECT * FROM motoristas WHERE id = $1', [Number(p.id)]);
    if (!m) throw new Erro(404, 'Motorista não encontrado.');
    const saldo = await moverCreditos(m.id, qtd, 'ajuste');
    whats.texto(m.contato || m.telefone, qtd > 0
      ? `🎟️ A central adicionou *${qtd} viage${qtd === 1 ? 'm' : 'ns'}* para você. Saldo: *${saldo}*`
      : `🎟️ A central retirou ${-qtd} viage${qtd === -1 ? 'm' : 'ns'} do seu saldo. Saldo: *${saldo}*`);
    return { saldo };
  });
});

rota('GET', '/api/compras', true, async () => {
  const { rows } = await pool.query(`
    SELECT c.*, m.nome AS motorista_nome, m.telefone AS motorista_tel, m.tipo AS motorista_tipo FROM compras c JOIN motoristas m ON m.id = c.motorista_id
     WHERE c.status = 'pendente' ORDER BY c.id`);
  return rows;
});
rota('POST', '/api/compras/:id/confirmar', true, async ({ p }) => bot.rodar(async () => {
  const c = await bot.confirmarCompra(Number(p.id), 'central');
  if (!c) throw new Erro(400, 'Essa compra já foi confirmada ou cancelada.');
  return { ok: true, saldo: c.saldo };
}));
rota('POST', '/api/compras/:id/cancelar', true, async ({ p }) => {
  const { rows: [c] } = await pool.query(
    "UPDATE compras SET status = 'cancelado' WHERE id = $1 AND status = 'pendente' RETURNING *", [Number(p.id)]);
  if (!c) throw new Erro(400, 'Essa compra já foi confirmada ou cancelada.');
  if (c.mp_id && MP.configurado()) MP.cancelar(c.mp_id).catch((e) => console.error('mp cancelar', e.message));
  const { rows: [m] } = await pool.query('SELECT telefone, contato FROM motoristas WHERE id = $1', [c.motorista_id]);
  whats.texto(m.contato || m.telefone, `O pedido de compra #${c.id} (${c.quantidade} viagens) foi cancelado pela central. Dúvidas? Fale com a central.`);
  return { ok: true };
});

rota('POST', '/api/motoristas/:id/online', true, async ({ req, p }) => {
  const b = await lerCorpo(req);
  // tirado do ar pela central: a localização dele também é apagada
  await pool.query(`UPDATE motoristas SET online = $2, lat = CASE WHEN $2 THEN lat END, lng = CASE WHEN $2 THEN lng END,
                    local_em = CASE WHEN $2 THEN local_em END WHERE id = $1 AND ativo`, [Number(p.id), !!b.online]);
  return { ok: true };
});

rota('GET', '/api/corridas', true, async ({ url }) => {
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('dia') || '') ? url.searchParams.get('dia') : null;
  const { rows } = await pool.query(`
    SELECT c.*, m.nome AS motorista_nome FROM corridas c LEFT JOIN motoristas m ON m.id = c.motorista_id
     WHERE ($1::date IS NULL AND (c.criado_em > now() - interval '24 hours' OR c.status IN ('procurando', 'aceita', 'chegou', 'em_andamento')))
        OR (c.criado_em AT TIME ZONE 'America/Campo_Grande')::date = $1::date
     ORDER BY c.id DESC LIMIT 300`, [dia]);
  return rows;
});
// ---- painel de viagens: ao vivo, histórico e detalhe de cada viagem
const SQL_VIAGEM = `
  SELECT c.id, c.status, c.tipo, c.passageiro_nome, c.passageiro_tel, c.origem_texto, c.destino_texto, c.km,
         c.valor_estimado, c.valor_final, c.avaliacao, c.cancelado_por,
         c.criado_em, c.aceita_em, c.chegou_em, c.iniciada_em, c.finalizada_em, c.cancelada_em,
         m.id AS motorista_id, m.nome AS motorista_nome, m.telefone AS motorista_tel, m.carro, m.cor, m.placa,
         o.nome AS oferta_nome, greatest(0, extract(epoch FROM c.oferta_expira - now()))::int AS oferta_resta,
         (SELECT array_agg(x.nome ORDER BY array_position(c.ja_ofertados, x.id)) FROM motoristas x WHERE x.id = ANY(c.ja_ofertados)) AS chamados
    FROM corridas c
    LEFT JOIN motoristas m ON m.id = c.motorista_id
    LEFT JOIN motoristas o ON o.id = c.oferta_motorista AND c.status = 'procurando'`;
const DIA_LOCAL = "(c.criado_em AT TIME ZONE 'America/Campo_Grande')::date";

rota('GET', '/api/viagens/ao-vivo', true, async () => {
  const { rows: ativas } = await pool.query(`${SQL_VIAGEM}
    WHERE c.status IN ('procurando', 'aceita', 'chegou', 'em_andamento') ORDER BY c.id`);
  const { rows: [hoje] } = await pool.query(`
    SELECT count(*) FILTER (WHERE status = 'finalizada')::int AS finalizadas,
           count(*) FILTER (WHERE status IN ('cancelada', 'sem_motorista'))::int AS perdidas,
           coalesce(sum(valor_final) FILTER (WHERE status = 'finalizada'), 0)::float AS faturamento,
           (SELECT count(*)::int FROM motoristas WHERE ativo AND aprovado AND online) AS online,
           to_char(now() AT TIME ZONE 'America/Campo_Grande', 'YYYY-MM-DD') AS dia
      FROM corridas c WHERE ${DIA_LOCAL} = (now() AT TIME ZONE 'America/Campo_Grande')::date`);
  return { ativas, hoje };
});

rota('GET', '/api/viagens', true, async ({ url }) => {
  const q = url.searchParams;
  const de = q.get('de'), ate = q.get('ate');
  if (![de, ate].every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || ''))) throw new Erro(400, 'Período inválido.');
  const status = ['finalizada', 'cancelada', 'sem_motorista'].includes(q.get('status')) ? [q.get('status')] : ['finalizada', 'cancelada', 'sem_motorista'];
  const motorista = Number(q.get('motorista')) || null;
  const busca = texto(q.get('busca'), 60);
  const { rows } = await pool.query(`${SQL_VIAGEM}
    WHERE ${DIA_LOCAL} BETWEEN $1 AND $2 AND c.status = ANY($3)
      AND ($4::int IS NULL OR c.motorista_id = $4)
      AND ($5 = '' OR c.passageiro_nome ILIKE '%' || $5 || '%' OR (regexp_replace($5, '\\D', '', 'g') <> '' AND c.passageiro_tel LIKE '%' || regexp_replace($5, '\\D', '', 'g') || '%')
           OR c.origem_texto ILIKE '%' || $5 || '%' OR c.destino_texto ILIKE '%' || $5 || '%' OR c.id::text = $5)
    ORDER BY c.id DESC LIMIT 500`, [de, ate, status, motorista, busca]);
  return rows;
});

rota('GET', '/api/viagens/:id', true, async ({ p }) => {
  const { rows: [v] } = await pool.query(`${SQL_VIAGEM} WHERE c.id = $1`, [Number(p.id)]);
  if (!v) throw new Erro(404, 'Viagem não encontrada.');
  return v;
});

rota('POST', '/api/corridas/:id/cancelar', true, async ({ p }) => bot.rodar(async () => {
  const { rows: [c] } = await pool.query(
    "SELECT * FROM corridas WHERE id = $1 AND status IN ('procurando', 'aceita', 'chegou', 'em_andamento')", [Number(p.id)]);
  if (!c) throw new Erro(400, 'Essa corrida já terminou.');
  await pool.query("UPDATE corridas SET status = 'cancelada', cancelada_em = now(), cancelado_por = 'central', oferta_motorista = NULL WHERE id = $1", [c.id]);
  await bot.devolverCredito(c);
  whats.texto(c.passageiro_contato, `❌ Sua corrida #${c.id} foi cancelada pela central. Se precisar, mande *oi* para pedir outra.`);
  const avisar = c.motorista_id || c.oferta_motorista;
  if (avisar) {
    const { rows: [m] } = await pool.query('SELECT telefone, contato FROM motoristas WHERE id = $1', [avisar]);
    if (m) whats.texto(m.contato || m.telefone, `❌ A corrida #${c.id} foi cancelada pela central. Você continua disponível.`);
  }
  return { ok: true };
}));

rota('GET', '/api/resumo', true, async ({ url }) => {
  const de = url.searchParams.get('de'), ate = url.searchParams.get('ate');
  if (![de, ate].every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || ''))) throw new Erro(400, 'Período inválido.');
  const filtro = "(c.criado_em AT TIME ZONE 'America/Campo_Grande')::date BETWEEN $1 AND $2";
  const { rows: [total] } = await pool.query(`
    SELECT count(*) FILTER (WHERE status = 'finalizada')::int AS finalizadas,
           count(*) FILTER (WHERE status = 'cancelada')::int AS canceladas,
           count(*) FILTER (WHERE status = 'sem_motorista')::int AS sem_motorista,
           coalesce(sum(valor_final), 0)::float AS faturamento,
           coalesce(sum(comissao), 0)::float AS comissao
      FROM corridas c WHERE ${filtro}`, [de, ate]);
  // todos os motoristas aprovados, mesmo sem corrida no período (para mandar o relatório a cada um)
  const { rows: motoristas } = await pool.query(`
    SELECT m.id, m.nome, m.tipo, m.creditos AS saldo, count(c.id)::int AS corridas,
           coalesce(sum(c.valor_final), 0)::float AS faturamento, coalesce(sum(c.comissao), 0)::float AS comissao,
           round(avg(c.avaliacao), 1)::float AS nota
      FROM motoristas m
      LEFT JOIN corridas c ON c.motorista_id = m.id AND c.status = 'finalizada' AND ${filtro}
     WHERE m.aprovado
     GROUP BY m.id ORDER BY count(c.id) DESC, m.nome`, [de, ate]);
  const { rows: [vendas] } = await pool.query(`
    SELECT count(*)::int AS compras, coalesce(sum(quantidade), 0)::int AS viagens, coalesce(sum(valor), 0)::float AS valor
      FROM compras WHERE status = 'pago' AND (pago_em AT TIME ZONE 'America/Campo_Grande')::date BETWEEN $1 AND $2`, [de, ate]);
  return { total, motoristas, vendas };
});

// relatório individual do motorista (ver no painel, imprimir ou mandar no WhatsApp dele)
function periodo(url, b = {}) {
  const de = b.de || url.searchParams.get('de'), ate = b.ate || url.searchParams.get('ate');
  if (![de, ate].every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '')) || de > ate) throw new Erro(400, 'Período inválido.');
  return { de, ate };
}
rota('GET', '/api/motoristas/:id/relatorio', true, async ({ url, p }) => {
  const { de, ate } = periodo(url);
  const r = await relatorio.montar(Number(p.id), de, ate);
  if (!r) throw new Erro(404, 'Motorista não encontrado.');
  const cfg = await lerConfig();
  return { ...r, texto: relatorio.texto(r, cfg.nome, cfg.cobranca_ativa) };
});
rota('POST', '/api/relatorios/enviar', true, async ({ req, url }) => {
  const b = await lerCorpo(req);
  const { de, ate } = periodo(url, b);
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => n > 0).slice(0, 500);
  if (!ids.length) throw new Erro(400, 'Escolha pelo menos um motorista.');
  const cfg = await lerConfig();
  // um de cada vez, com intervalo: muitas mensagens juntas parecem disparo em massa para o WhatsApp
  (async () => {
    for (const [i, id] of ids.entries()) {
      if (i) await new Promise((ok) => setTimeout(ok, 3000));
      const r = await relatorio.montar(id, de, ate).catch((e) => console.error('relatório', id, e.message));
      if (r) whats.texto(r.motorista.contato || r.motorista.telefone, relatorio.texto(r, cfg.nome, cfg.cobranca_ativa));
    }
  })();
  return { enviados: ids.length, segundos: (ids.length - 1) * 3 };
});

// divulgação: links e QR codes que abrem o WhatsApp da central já com a mensagem escrita
async function numeroCentral(cfg) {
  if (cfg.numero_central) return cfg.numero_central;
  const numero = await whats.numeroDaInstancia();
  if (numero) await salvarConfig({ ...cfg, numero_central: numero });
  return numero;
}
const linkWhats = (numero, txt) => `https://wa.me/${numero}?text=${encodeURIComponent(txt)}`;

rota('GET', '/api/divulgar', true, async () => {
  const cfg = await lerConfig();
  const numero = await numeroCentral(cfg);
  if (!numero) return { numero: '', nome: cfg.nome };
  const link = (txt) => linkWhats(numero, txt);
  const qr = (url) => QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  const passageiro = link('Oi! Quero uma corrida');
  const motorista = link('CADASTRO');
  return { numero, nome: cfg.nome, passageiro, motorista, qr_passageiro: await qr(passageiro), qr_motorista: await qr(motorista) };
});

// ---------------------------------------------------------------- página inicial pública

rota('GET', '/api/publico/inicio', false, async () => {
  const cfg = await lerConfig();
  const numero = await numeroCentral(cfg).catch(() => '');
  return { nome: cfg.nome, cidade: cfg.cidade, aceitando: cfg.aceitando, numero,
    passageiro: numero ? linkWhats(numero, 'Oi! Quero uma corrida') : '', tipos: ORDEM.filter((t) => cfg.precos[t].ativo) };
});
rota('GET', '/api/publico/cores', false, async () => Object.fromEntries(ORDEM.map((t) => [t, coresDo(t)])));

// ---------------------------------------------------------------- área do motorista (entra com código no WhatsApp)

let segredoMotorista = null; // gerado uma vez e guardado no banco
async function prepararSegredoMotorista() {
  const { rows } = await pool.query("SELECT valor FROM config WHERE chave = 'segredo_motorista'");
  if (rows[0]) { segredoMotorista = rows[0].valor; return; }
  segredoMotorista = crypto.randomBytes(32).toString('hex');
  await pool.query("INSERT INTO config (chave, valor) VALUES ('segredo_motorista', $1) ON CONFLICT (chave) DO NOTHING", [JSON.stringify(segredoMotorista)]);
}
const assinarMotorista = (txt) => crypto.createHmac('sha256', 'motorista:' + segredoMotorista).update(txt).digest('base64url');
const DURACAO_MOTORISTA = 60 * 24 * 3600 * 1000;

async function motoristaLogado(req) {
  const m = /(?:^|;\s*)cm_sessao=(\d+)\.(\d+)\.([\w-]+)/.exec(req.headers.cookie || '');
  if (!m || Number(m[2]) < Date.now()) return null;
  const esperado = assinarMotorista(m[1] + '.' + m[2]);
  if (m[3].length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(m[3]), Buffer.from(esperado))) return null;
  const { rows: [mot] } = await pool.query('SELECT * FROM motoristas WHERE id = $1 AND ativo', [Number(m[1])]);
  return mot || null;
}
async function exigirMotorista(req) {
  const m = await motoristaLogado(req);
  if (!m) throw new Erro(401, 'Entre com o código que chega no seu WhatsApp.');
  return m;
}
const hashCodigo = (id, c) => crypto.createHmac('sha256', 'codigo:' + segredoMotorista).update(id + ':' + c).digest('hex');
async function motoristaPeloTelefone(v) {
  const dig = soDigitos(v);
  if (dig.length < 10) throw new Erro(400, 'Digite seu WhatsApp com DDD.');
  const { rows: [m] } = await pool.query('SELECT * FROM motoristas WHERE ativo AND right(telefone, 8) = right($1, 8) ORDER BY id LIMIT 1', [dig]);
  return m || null;
}

rota('POST', '/api/motorista/codigo', false, async ({ req }) => {
  limitar('codigo:' + ipDe(req), 6, 15 * 60_000);
  const b = await lerCorpo(req);
  const m = await motoristaPeloTelefone(b.telefone);
  if (!m) throw new Erro(404, 'Não achamos motorista com esse WhatsApp. Faça seu cadastro na aba ao lado.');
  limitar('codigo-m:' + m.id, 3, 15 * 60_000);
  const codigo = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await pool.query(`INSERT INTO motorista_codigos (motorista_id, codigo_hash, expira_em) VALUES ($1, $2, now() + interval '10 minutes')
                    ON CONFLICT (motorista_id) DO UPDATE SET codigo_hash = EXCLUDED.codigo_hash, expira_em = EXCLUDED.expira_em, tentativas = 0`,
    [m.id, hashCodigo(m.id, codigo)]);
  const cfg = await lerConfig();
  whats.texto(m.contato || m.telefone, `🔐 Seu código para entrar na área do motorista da ${cfg.nome}: *${codigo}*\n\nVale 10 minutos. Não passe para ninguém.`);
  return { ok: true, final: m.telefone.slice(-4) };
});

rota('POST', '/api/motorista/entrar', false, async ({ req, res }) => {
  limitar('entrar:' + ipDe(req), 15, 15 * 60_000);
  const b = await lerCorpo(req);
  const m = await motoristaPeloTelefone(b.telefone);
  const codigo = soDigitos(b.codigo);
  if (!m || codigo.length !== 6) throw new Erro(400, 'Código errado.');
  const { rows: [c] } = await pool.query(
    'UPDATE motorista_codigos SET tentativas = tentativas + 1 WHERE motorista_id = $1 RETURNING *, expira_em > now() AS valido', [m.id]);
  if (!c || !c.valido || c.tentativas > 5) throw new Erro(400, 'O código venceu. Peça um novo.');
  const a = Buffer.from(hashCodigo(m.id, codigo)), e = Buffer.from(c.codigo_hash);
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) throw new Erro(400, 'Código errado. Confira no seu WhatsApp.');
  await pool.query('DELETE FROM motorista_codigos WHERE motorista_id = $1', [m.id]);
  const corpo = m.id + '.' + (Date.now() + DURACAO_MOTORISTA);
  const seguro = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `cm_sessao=${corpo}.${assinarMotorista(corpo)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DURACAO_MOTORISTA / 1000}${seguro}`);
  return { ok: true };
});

rota('POST', '/api/motorista/sair', false, async ({ res }) => {
  res.setHeader('Set-Cookie', 'cm_sessao=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  return { ok: true };
});

// cadastro pelo site (o mesmo do CADASTRO no WhatsApp)
rota('POST', '/api/motorista/cadastro', false, async ({ req }) => {
  limitar('cadastro:' + ipDe(req), 5, 60 * 60_000);
  const b = await lerCorpo(req);
  const nome = texto(b.nome, 80);
  if (nome.replace(/[^a-zA-ZÀ-ÿ]/g, '').length < 3) throw new Erro(400, 'Digite seu nome completo.');
  const telefone = telefoneBR(b.telefone);
  if (!TIPOS[b.tipo]) throw new Erro(400, 'Escolha o tipo de veículo.');
  const carro = texto(b.carro, 60), cor = texto(b.cor, 30).toLowerCase();
  if (carro.length < 2) throw new Erro(400, 'Digite o modelo do veículo.');
  if (cor.length < 3) throw new Erro(400, 'Escolha a cor do veículo.');
  const placa = texto(b.placa, 10).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(placa)) throw new Erro(400, 'Placa inválida. Use o formato ABC1D23 ou ABC1234.');
  if (await motoristaPeloTelefone(telefone)) throw new Erro(400, 'Esse WhatsApp já tem cadastro. Use a aba "Já sou motorista" para entrar.');
  const cfg = await lerConfig();
  const aprovado = !!cfg.aprovar_automatico;
  const { rows: [m] } = await pool.query(
    `INSERT INTO motoristas (nome, telefone, tipo, carro, cor, placa, aprovado, ativo) VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING *`,
    [nome, telefone, b.tipo, carro, cor, placa, aprovado]);
  const ficha = `👤 ${nome}\n${rotulo(b.tipo)} · ${carro} ${cor} · ${placa}`;
  if (cfg.numero_admin) {
    whats.texto(cfg.numero_admin, `🆕 *Novo motorista ${aprovado ? 'cadastrado' : 'aguardando aprovação'}* (pelo site)\n${ficha}\n📞 wa.me/${telefone}` +
      (aprovado ? '' : '\n\nAprove no painel, em *Motoristas*.'));
  }
  whats.texto(telefone, aprovado
    ? `✅ *Cadastro feito na ${cfg.nome}!*\n${ficha}\n\n` + bot.AJUDA_MOTORISTA
    : `✅ *Cadastro enviado!*\n${ficha}\n\nA ${cfg.nome} vai conferir seus dados. Você recebe uma mensagem aqui assim que for aprovado. 🙌`);
  return { ok: true, aprovado, id: m.id };
});

rota('GET', '/api/motorista/eu', false, async ({ req }) => {
  const m = await exigirMotorista(req);
  const cfg = await lerConfig();
  const { rows: [compra] } = await pool.query(
    "SELECT id, quantidade, valor, mp_id, pix_copia_cola, pix_expira, comprovante, criado_em FROM compras WHERE motorista_id = $1 AND status = 'pendente' ORDER BY id DESC LIMIT 1", [m.id]);
  const { rows: [atual] } = await pool.query(
    "SELECT id, status, origem_texto, destino_texto, passageiro_nome, valor_estimado FROM corridas WHERE motorista_id = $1 AND status IN ('aceita', 'chegou', 'em_andamento') LIMIT 1", [m.id]);
  const { de, ate } = relatorio.mesAtual();
  const mes = await relatorio.montar(m.id, de, ate);
  return {
    motorista: { id: m.id, nome: m.nome, telefone: m.telefone, tipo: m.tipo, carro: m.carro, cor: m.cor, placa: m.placa,
      aprovado: m.aprovado, online: m.online, saldo: m.creditos, veiculo: veiculo(m) },
    central: { nome: cfg.nome, cobranca: !!cfg.cobranca_ativa, mp: MP.configurado() && cfg.mp_ativo !== false, pix_chave: cfg.pix_chave, pix_nome: cfg.pix_nome },
    pacotes: pacotesComDesconto(cfg),
    compra: compra ? { ...compra, qr: compra.pix_copia_cola ? await QRCode.toString(compra.pix_copia_cola, { type: 'svg', margin: 1 }) : '' } : null,
    corrida: atual || null,
    mes: mes.totais,
  };
});

rota('POST', '/api/motorista/online', false, async ({ req }) => {
  const m = await exigirMotorista(req);
  if (!m.aprovado) throw new Erro(400, 'Seu cadastro ainda está em análise.');
  const b = await lerCorpo(req);
  return bot.rodar(async () => {
    if (b.online) await pool.query('UPDATE motoristas SET online = true WHERE id = $1', [m.id]);
    else {
      // privacidade: fora do ar, a central não guarda onde o motorista está
      await pool.query('UPDATE motoristas SET online = false, lat = NULL, lng = NULL, local_em = NULL WHERE id = $1', [m.id]);
      const { rows: [c] } = await pool.query("SELECT id FROM corridas WHERE status = 'procurando' AND oferta_motorista = $1", [m.id]);
      if (c) { await pool.query('UPDATE corridas SET oferta_motorista = NULL, oferta_expira = NULL WHERE id = $1', [c.id]); await bot.despachar(c.id); }
    }
    return { online: !!b.online };
  });
});

rota('PUT', '/api/motorista/eu', false, async ({ req }) => {
  const m = await exigirMotorista(req);
  const b = await lerCorpo(req);
  const carro = texto(b.carro, 60), cor = texto(b.cor, 30).toLowerCase();
  const placa = texto(b.placa, 10).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (carro.length < 2) throw new Erro(400, 'Digite o modelo do veículo.');
  if (cor.length < 3) throw new Erro(400, 'Escolha a cor do veículo.');
  if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(placa)) throw new Erro(400, 'Placa inválida. Use o formato ABC1D23 ou ABC1234.');
  await pool.query('UPDATE motoristas SET carro = $2, cor = $3, placa = $4 WHERE id = $1', [m.id, carro, cor, placa]);
  const mudou = [m.carro !== carro && `modelo: ${m.carro} → ${carro}`, m.cor !== cor && `cor: ${m.cor || '—'} → ${cor}`, m.placa !== placa && `placa: ${m.placa} → ${placa}`].filter(Boolean);
  const cfg = await lerConfig();
  if (mudou.length && cfg.numero_admin) whats.texto(cfg.numero_admin, `✏️ ${m.nome} mudou o cadastro pelo site:\n${mudou.join('\n')}`);
  return { ok: true };
});

rota('POST', '/api/motorista/comprar', false, async ({ req }) => {
  const m = await exigirMotorista(req);
  limitar('comprar-m:' + m.id, 6, 15 * 60_000);
  const b = await lerCorpo(req);
  const cfg = await lerConfig();
  if (!cfg.cobranca_ativa) throw new Erro(400, 'A central não está cobrando por viagem no momento.');
  const pacote = pacotesComDesconto(cfg).find((p) => p.qtd === Number(b.qtd));
  if (!pacote) throw new Erro(400, 'Pacote não encontrado.');
  const { compra } = await bot.rodar(() => bot.criarCompra(m, pacote, cfg));
  return { ok: true, compra: compra.id };
});

// a página fica perguntando enquanto o Pix não cai; de vez em quando confere direto no Mercado Pago
rota('GET', '/api/motorista/compra/:id', false, async ({ req, p }) => {
  const m = await exigirMotorista(req);
  const { rows: [c] } = await pool.query(
    'SELECT id, status, quantidade, mp_id, mp_checado_em < now() - interval \'8 seconds\' OR mp_checado_em IS NULL AS conferir FROM compras WHERE id = $1 AND motorista_id = $2',
    [Number(p.id), m.id]);
  if (!c) throw new Erro(404, 'Compra não encontrada.');
  if (c.status === 'pendente' && c.mp_id && c.conferir && MP.configurado()) {
    await bot.processarPagamentoMP(c.mp_id).catch((e) => console.error('mp consulta', e.message));
  }
  const { rows: [agora] } = await pool.query('SELECT status FROM compras WHERE id = $1', [c.id]);
  const { rows: [mot] } = await pool.query('SELECT creditos FROM motoristas WHERE id = $1', [m.id]);
  return { status: agora.status, saldo: mot.creditos };
});

rota('GET', '/api/motorista/relatorio', false, async ({ req, url }) => {
  const m = await exigirMotorista(req);
  const { de, ate } = periodo(url);
  return relatorio.montar(m.id, de, ate);
});

rota('GET', '/api/mensagens', true, async () => whats.enviados.slice(-50).reverse());


/* Solicitação de viagem pelo site, com telefone confirmado por código. */
const geoPassageiro = require('./lib/geo');
const hashPassageiro = (t,c) => crypto.createHmac('sha256','passageiro:'+segredoMotorista).update(t+':'+c).digest('hex');
function sessaoPassageiro(req) {
  const m=/(?:^|;\s*)cp_sessao=(\d+)\.(\d+)\.([\w-]+)/.exec(req.headers.cookie||'');
  if(!m || Number(m[2])<Date.now()) throw new Erro(401,'Confirme seu WhatsApp novamente.');
  const sig=hashPassageiro(m[1],m[2]);
  if(m[3].length!==sig.length || !crypto.timingSafeEqual(Buffer.from(m[3]),Buffer.from(sig))) throw new Erro(401,'Sessão inválida.');
  return m[1];
}
rota('GET','/api/passageiro/modo',false,async()=>({teste:MODO_TESTE_SITE}));
rota('POST','/api/passageiro/codigo',false,async({req})=>{
  limitar('pc-ip:'+ipDe(req),6,15*60_000);
  const b=await lerCorpo(req), tel=telefoneBR(b.telefone);
  limitar('pc-tel:'+tel,3,15*60_000);
  if(MODO_TESTE_SITE && tel !== '5500000000000') throw new Erro(400,'No teste, use o número fictício indicado na tela.');
  if(!MODO_TESTE_SITE && (!whats.EVO.url || !whats.EVO.instancia || !whats.EVO.chave)) throw new Erro(503,'O WhatsApp da central está indisponível.');
  const code=MODO_TESTE_SITE ? '123456' : String(crypto.randomInt(0,1000000)).padStart(6,'0');
  await pool.query(`INSERT INTO passageiro_codigos(telefone,codigo_hash,expira_em) VALUES($1,$2,now()+interval '10 minutes')
    ON CONFLICT(telefone) DO UPDATE SET codigo_hash=excluded.codigo_hash,expira_em=excluded.expira_em,tentativas=0`,[tel,hashPassageiro(tel,code)]);
  if(!MODO_TESTE_SITE) whats.texto(tel,`🔐 Seu código de acesso à Vai com Manu: *${code}*. Válido por 10 minutos. Não compartilhe.`);
  return {ok:true};
});
rota('POST','/api/passageiro/entrar',false,async({req,res})=>{
  limitar('pe-ip:'+ipDe(req),15,15*60_000);
  const b=await lerCorpo(req),tel=telefoneBR(b.telefone), code=soDigitos(b.codigo);
  const {rows:[c]}=await pool.query("UPDATE passageiro_codigos SET tentativas=tentativas+1 WHERE telefone=$1 AND expira_em>now() AND tentativas<5 RETURNING codigo_hash",[tel]);
  if(!c||code.length!==6) throw new Erro(400,'Código inválido ou expirado.');
  const a=Buffer.from(hashPassageiro(tel,code)),z=Buffer.from(c.codigo_hash);
  if(a.length!==z.length||!crypto.timingSafeEqual(a,z)) throw new Erro(400,'Código inválido.');
  await pool.query('DELETE FROM passageiro_codigos WHERE telefone=$1',[tel]);
  const expiry=String(Date.now()+24*3600_000), sig=hashPassageiro(tel,expiry);
  const secure=String(req.headers['x-forwarded-proto']||'').includes('https')?'; Secure':'';
  res.setHeader('Set-Cookie',`cp_sessao=${tel}.${expiry}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`);
  return {ok:true};
});
rota('POST','/api/passageiro/cotacao',false,async({req})=>{
  limitar('cotacao:'+ipDe(req),12,15*60_000);
  const tel=sessaoPassageiro(req), b=await lerCorpo(req),cfg=await lerConfig();
  const nome=texto(b.nome,100),origem=texto(b.origem,180),destino=texto(b.destino,180),tipo=texto(b.tipo,20);
  if(!cfg.aceitando) throw new Erro(400,'A central não está aceitando corridas agora.');
  if(nome.length<2||origem.length<4||destino.length<4||!ORDEM.includes(tipo)||!cfg.precos[tipo].ativo) throw new Erro(400,'Confira nome, endereços e veículo.');
  function ponto(v) {
    if (!v || typeof v.lat !== 'number' || typeof v.lng !== 'number' || !Number.isFinite(v.lat) || !Number.isFinite(v.lng) || Math.abs(v.lat)>90 || Math.abs(v.lng)>180) return null;
    return {lat:v.lat,lng:v.lng};
  }
  if ((b.origemPonto && !ponto(b.origemPonto)) || (b.destinoPonto && !ponto(b.destinoPonto))) throw new Erro(400,'Ponto do mapa inválido.');
  const [o,d]=await Promise.all([b.origemPonto ? ponto(b.origemPonto) : geoPassageiro.buscarEndereco(origem,cfg),b.destinoPonto ? ponto(b.destinoPonto) : geoPassageiro.buscarEndereco(destino,cfg)]);
  if(!o || !d) throw new Erro(400, !o && !d ? 'Não encontramos a origem nem o destino. Marque os pontos no mapa.' : !o ? 'Não encontramos a origem. Marque o ponto no mapa.' : 'Não encontramos o destino. Marque o ponto no mapa.');
  const km=geoPassageiro.kmRota(o,d,cfg),valor=geoPassageiro.preco(km,cfg.precos[tipo]);
  const payload={tel,nome,origem,destino,o,d,tipo,km,valor,exp:Date.now()+5*60_000,nonce:crypto.randomBytes(16).toString('hex')};
  const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');
  return {km,valor,token:encoded+'.'+hashPassageiro(tel,encoded),aviso:'Distância e valor estimados.'};
});
rota('POST','/api/passageiro/pedir',false,async({req})=>bot.rodar(async()=>{
  limitar('pedir:'+ipDe(req),10,15*60_000);
  const tel=sessaoPassageiro(req),b=await lerCorpo(req),parts=String(b.token||'').split('.');
  if(parts.length!==2||parts[0].length>5000) throw new Erro(400,'Faça uma nova cotação.');
  const sig=hashPassageiro(tel,parts[0]);
  if(sig.length!==parts[1].length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(parts[1]))) throw new Erro(400,'Cotação inválida.');
  let q;try{q=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'))}catch{throw new Erro(400,'Cotação inválida.')}
  if(q.tel!==tel||q.exp<Date.now()) throw new Erro(400,'Cotação expirada. Faça outra.');
  const cfg=await lerConfig();if(!cfg.aceitando||!cfg.precos[q.tipo]?.ativo) throw new Erro(400,'Veículo indisponível.');
  const precoAtual=geoPassageiro.preco(q.km,cfg.precos[q.tipo]);if(precoAtual!==q.valor) throw new Erro(400,'O preço mudou. Faça outra cotação.');
  const {rows:[existing]}=await pool.query('SELECT corrida_id FROM passageiro_pedidos WHERE token=$1',[q.nonce]);
  if(existing) return {id:existing.corrida_id};
  const {rows:[active]}=await pool.query("SELECT id FROM corridas WHERE passageiro_tel=$1 AND status IN ('procurando','aceita','chegou','em_andamento') LIMIT 1",[tel]);
  if(active) throw new Erro(409,'Você já tem uma corrida em andamento.');
  const client=await pool.connect();let ride;
  try{
    await client.query('BEGIN');
    const result=await client.query(`INSERT INTO corridas(passageiro_tel,passageiro_contato,passageiro_nome,origem_texto,origem_lat,origem_lng,destino_texto,destino_lat,destino_lng,km,valor_estimado,tipo)
    VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,[tel,q.nome,q.origem,q.o.lat,q.o.lng,q.destino,q.d.lat,q.d.lng,q.km,q.valor,q.tipo]);
    ride=result.rows[0];await client.query('INSERT INTO passageiro_pedidos(token,corrida_id) VALUES($1,$2)',[q.nonce,ride.id]);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  whats.texto(tel,`🔎 Corrida #${ride.id} solicitada pelo site. Procurando motorista. Para cancelar, envie CANCELAR.`);
  await bot.despachar(ride.id);
  return {id:ride.id};
}));
rota('GET','/api/passageiro/viagem/:id',false,async({req,p})=>{
  const tel=sessaoPassageiro(req),id=Number(p.id);
  const {rows:[c]}=await pool.query(`SELECT c.id,c.status,c.origem_texto,c.destino_texto,c.valor_estimado,c.valor_final,c.tipo,m.nome AS motorista_nome,m.carro,m.cor,m.placa
    FROM corridas c LEFT JOIN motoristas m ON m.id=c.motorista_id WHERE c.id=$1 AND c.passageiro_tel=$2`,[id,tel]);
  if(!c) throw new Erro(404,'Viagem não encontrada.');return c;
});

// ---------------------------------------------------------------- arquivos do painel

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
function arquivo(res, nome) {
  const caminho = path.join(PUBLIC, nome);
  if (!caminho.startsWith(PUBLIC + path.sep)) return false;
  try {
    const conteudo = fs.readFileSync(caminho);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(caminho)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(conteudo);
    return true;
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    for (const r of rotas) {
      const m = r.metodo === req.method && r.re.exec(url.pathname);
      if (!m) continue;
      if (r.protegida && !logado(req)) throw new Erro(401, 'Entre com a senha do painel.');
      const resultado = await r.fn({ req, res, url, p: m.groups || {} });
      return json(res, 200, resultado);
    }
    if (req.method === 'GET') {
      const pagina = { '/': 'inicio.html', '/painel': 'index.html', '/motorista': 'motorista.html', '/passageiro': 'passageiro.html' }[url.pathname.replace(/\/+$/, '') || '/'];
      if (pagina) return arquivo(res, pagina) || json(res, 404, { erro: 'Não encontrado' });
      if (arquivo(res, url.pathname.slice(1))) return;
    }
    json(res, 404, { erro: 'Não encontrado' });
  } catch (e) {
    if (!(e instanceof Erro)) console.error(e);
    json(res, e.status || 500, { erro: e instanceof Erro ? e.message : 'Erro no servidor' });
  }
});

(async () => {
  if (MODO_TESTE_SITE && (whats.EVO.url || whats.EVO.instancia || whats.EVO.chave || MP.configurado())) throw new Error('Modo de teste exige Evolution e Mercado Pago desativados.');
  await migrar();
  await prepararSegredoMotorista();
  setInterval(() => bot.varrer().catch((e) => console.error('Erro ao varrer chamadas:', e)), 3000).unref();
  setInterval(() => bot.limparLocalizacoes().catch((e) => console.error('Erro ao apagar localizações:', e.message)), 5 * 60_000).unref();
  bot.limparLocalizacoes().catch(() => {});
  setInterval(() => bot.rondaMP().catch((e) => console.error('Erro na ronda do Mercado Pago:', e.message)), 30_000).unref();
  server.listen(PORT, () => {
    console.log(`Central de corridas no ar na porta ${PORT}`);
    if (!whats.EVO.url) console.log('Aviso: EVOLUTION_URL não definida, as mensagens só aparecem no log.');
    else whats.conferir().then((r) => console.log(r)).catch(() => {});
    if (!WEBHOOK_TOKEN) console.log('Aviso: WEBHOOK_TOKEN não definido, qualquer um pode chamar o webhook.');
    console.log(MP.configurado() ? 'Mercado Pago ligado: Pix automático na compra de viagens.' : 'Mercado Pago desligado (sem MP_ACCESS_TOKEN): compra de viagens com Pix manual.');
    if (!ADMIN_SENHA) console.log('Aviso: ADMIN_SENHA não definida, o painel fica bloqueado.');
    else console.log(`Senha do painel configurada (${ADMIN_SENHA.length} caracteres, começa com "${ADMIN_SENHA[0]}")`);
  });
})().catch((e) => { console.error('Falha ao iniciar:', e); process.exit(1); });

module.exports = { lerMensagem };
