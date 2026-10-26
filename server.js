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
const { pool, migrar, lerConfig, salvarConfig, moverCreditos, CONFIG_PADRAO } = require('./lib/db');
const bot = require('./lib/bot');
const whats = require('./lib/whats');
const { TIPOS, ORDEM, rotulo, veiculo, coresDo } = require('./lib/tipos');
const MP = require('./lib/mercadopago');
const relatorio = require('./lib/relatorio');

const PORT = Number(process.env.PORT) || 3000;
// tira espaços e aspas que às vezes vêm junto quando a variável é colada no Easypanel
const limparVar = (v) => String(v || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
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

rota('POST', '/webhook/evolution', false, async ({ req, url }) => {
  if (WEBHOOK_TOKEN && url.searchParams.get('token') !== WEBHOOK_TOKEN) throw new Erro(401, 'Token inválido');
  const b = await lerCorpo(req);
  const msg = lerMensagem(b);
  if (msg) bot.receber(msg).catch((e) => console.error('Erro ao tratar mensagem:', e));
  return { ok: true };
});

// aviso do Mercado Pago: só traz o número do pagamento; a situação é sempre conferida na API deles
rota('POST', '/api/mp/webhook', false, async ({ req, url }) => {
  limitar('mp:' + ipDe(req), 120, 60_000);
  const b = await lerCorpo(req).catch(() => ({}));
  const id = String((b.data && b.data.id) || url.searchParams.get('data.id') || url.searchParams.get('id') || '').replace(/[^\w-]/g, '').slice(0, 64);
  const tipo = b.type || b.topic || url.searchParams.get('type') || url.searchParams.get('topic') || '';
  if (id && /order/.test(tipo) && MP.configurado()) await bot.processarPagamentoMP(id).catch((e) => console.error('mp webhook', e.message));
  return { ok: true };
});

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
  if (b.pacotes !== undefined) {
    // "10, 20, 50" → [10, 20, 50]
    novo.pacotes = [...new Set(String(b.pacotes).split(/[^\d]+/).map(Number).filter((n) => n > 0 && n <= 1000))].sort((x, y) => x - y).slice(0, 6);
    if (!novo.pacotes.length) throw new Erro(400, 'Informe pelo menos um pacote de viagens (ex.: 10, 20, 50).');
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
  await pool.query('UPDATE motoristas SET online = $2 WHERE id = $1 AND ativo', [Number(p.id), !!b.online]);
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
rota('POST', '/api/corridas/:id/cancelar', true, async ({ p }) => bot.rodar(async () => {
  const { rows: [c] } = await pool.query(
    "SELECT * FROM corridas WHERE id = $1 AND status IN ('procurando', 'aceita', 'chegou', 'em_andamento')", [Number(p.id)]);
  if (!c) throw new Erro(400, 'Essa corrida já terminou.');
  await pool.query("UPDATE corridas SET status = 'cancelada', cancelado_por = 'central', oferta_motorista = NULL WHERE id = $1", [c.id]);
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

rota('GET', '/api/mensagens', true, async () => whats.enviados.slice(-50).reverse());

// ---------------------------------------------------------------- arquivos do painel

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
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
      if (url.pathname === '/' || url.pathname === '/painel') return arquivo(res, 'index.html') || json(res, 404, { erro: 'Não encontrado' });
      if (arquivo(res, url.pathname.slice(1))) return;
    }
    json(res, 404, { erro: 'Não encontrado' });
  } catch (e) {
    if (!(e instanceof Erro)) console.error(e);
    json(res, e.status || 500, { erro: e instanceof Erro ? e.message : 'Erro no servidor' });
  }
});

(async () => {
  await migrar();
  setInterval(() => bot.varrer().catch((e) => console.error('Erro ao varrer chamadas:', e)), 3000).unref();
  setInterval(() => bot.rondaMP().catch((e) => console.error('Erro na ronda do Mercado Pago:', e.message)), 30_000).unref();
  server.listen(PORT, () => {
    console.log(`Central de corridas no ar na porta ${PORT}`);
    if (!whats.EVO.url) console.log('Aviso: EVOLUTION_URL não definida, as mensagens só aparecem no log.');
    if (!WEBHOOK_TOKEN) console.log('Aviso: WEBHOOK_TOKEN não definido, qualquer um pode chamar o webhook.');
    console.log(MP.configurado() ? 'Mercado Pago ligado: Pix automático na compra de viagens.' : 'Mercado Pago desligado (sem MP_ACCESS_TOKEN): compra de viagens com Pix manual.');
    if (!ADMIN_SENHA) console.log('Aviso: ADMIN_SENHA não definida, o painel fica bloqueado.');
    else console.log(`Senha do painel configurada (${ADMIN_SENHA.length} caracteres, começa com "${ADMIN_SENHA[0]}")`);
  });
})().catch((e) => { console.error('Falha ao iniciar:', e); process.exit(1); });

module.exports = { lerMensagem };
