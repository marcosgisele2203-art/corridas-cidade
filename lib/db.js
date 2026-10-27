// Banco: conexão, criação/atualização das tabelas e configurações.
const { Pool } = require('pg');
const { ORDEM, PRECOS_PADRAO } = require('./tipos');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

const CONFIG_PADRAO = {
  nome: 'Central de Corridas',
  cidade: '',              // ex.: "Bonito, MS" (ajuda a achar endereços digitados)
  numero_admin: '',        // recebe aviso quando não há motorista
  numero_central: '',      // WhatsApp da central (vai nos links e QR codes de divulgação)
  precos: PRECOS_PADRAO,    // por tipo de veículo: taxa base + R$/km, valor mínimo, se está oferecido
  aprovar_automatico: false, // motorista que se cadastra pelo WhatsApp já começa a trabalhar
  fator_rota: 1.3,         // linha reta × fator ≈ distância pelas ruas
  oferta_segundos: 40,     // tempo que cada motorista tem para aceitar
  comissao_pct: 0,         // % da central sobre cada corrida (só controle; a cobrança é pelas viagens)
  aceitando: true,         // central aberta para pedidos
  // motorista compra viagens antes (créditos): cada corrida aceita gasta 1
  cobranca_ativa: true,
  // pacotes à venda: quantidade de viagens e preço do pacote (pacote maior pode ter desconto)
  pacotes: [{ qtd: 1, preco: 1 }, { qtd: 5, preco: 5 }, { qtd: 10, preco: 9.5 }, { qtd: 25, preco: 22.5 },
    { qtd: 50, preco: 42.5 }, { qtd: 100, preco: 80 }],
  creditos_boas_vindas: 3, // viagens grátis quando o motorista é aprovado
  pix_chave: '',           // Pix manual (quando o Mercado Pago não está ligado)
  pix_nome: '',
  mp_ativo: true,
  arte_boas_vindas: 'auto', // arte enviada junto com o "Bem-vindo": auto (conforme os veículos ligados), um arquivo de public/artes ou '' (nenhuma)          // usa o Pix automático do Mercado Pago quando o MP_ACCESS_TOKEN existe
};

async function migrar() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config (
      chave TEXT PRIMARY KEY,
      valor JSONB NOT NULL,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS motoristas (
      id           SERIAL PRIMARY KEY,
      nome         TEXT NOT NULL,
      telefone     TEXT NOT NULL UNIQUE,
      carro        TEXT NOT NULL DEFAULT '',
      placa        TEXT NOT NULL DEFAULT '',
      ativo        BOOLEAN NOT NULL DEFAULT true,
      online       BOOLEAN NOT NULL DEFAULT false,
      contato      TEXT NOT NULL DEFAULT '',      -- jid para onde o bot responde
      lat          DOUBLE PRECISION,
      lng          DOUBLE PRECISION,
      local_em     TIMESTAMPTZ,
      criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS conversas (
      telefone      TEXT PRIMARY KEY,
      contato       TEXT NOT NULL,
      nome          TEXT NOT NULL DEFAULT '',
      etapa         TEXT NOT NULL DEFAULT 'inicio',
      dados         JSONB NOT NULL DEFAULT '{}',
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS corridas (
      id               SERIAL PRIMARY KEY,
      passageiro_tel   TEXT NOT NULL,
      passageiro_contato TEXT NOT NULL,
      passageiro_nome  TEXT NOT NULL DEFAULT '',
      origem_texto     TEXT NOT NULL DEFAULT '',
      origem_lat       DOUBLE PRECISION,
      origem_lng       DOUBLE PRECISION,
      destino_texto    TEXT NOT NULL DEFAULT '',
      destino_lat      DOUBLE PRECISION,
      destino_lng      DOUBLE PRECISION,
      km               NUMERIC(8,2),
      valor_estimado   NUMERIC(10,2),
      valor_final      NUMERIC(10,2),
      comissao         NUMERIC(10,2),
      status           TEXT NOT NULL DEFAULT 'procurando',
        -- procurando → aceita → chegou → em_andamento → finalizada | cancelada | sem_motorista
      motorista_id     INT REFERENCES motoristas(id),
      oferta_motorista INT,               -- motorista que está recebendo a chamada agora
      oferta_expira    TIMESTAMPTZ,
      ja_ofertados     INT[] NOT NULL DEFAULT '{}',
      avaliacao        INT,
      cancelado_por    TEXT,
      criado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
      aceita_em        TIMESTAMPTZ,
      finalizada_em    TIMESTAMPTZ
    );
    ALTER TABLE motoristas ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'carro';
    ALTER TABLE motoristas ADD COLUMN IF NOT EXISTS aprovado BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE corridas ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'carro';
    ALTER TABLE motoristas ADD COLUMN IF NOT EXISTS creditos INT NOT NULL DEFAULT 0;
    ALTER TABLE motoristas ADD COLUMN IF NOT EXISTS cor TEXT NOT NULL DEFAULT ''; -- carro = modelo
    ALTER TABLE conversas ADD COLUMN IF NOT EXISTS arte_em TIMESTAMPTZ; -- última vez que recebeu a arte de boas-vindas
    ALTER TABLE corridas ADD COLUMN IF NOT EXISTS credito_usado BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE corridas ADD COLUMN IF NOT EXISTS chegou_em TIMESTAMPTZ;   -- motorista avisou que chegou
    ALTER TABLE corridas ADD COLUMN IF NOT EXISTS iniciada_em TIMESTAMPTZ; -- passageiro embarcou
    ALTER TABLE corridas ADD COLUMN IF NOT EXISTS cancelada_em TIMESTAMPTZ;

    -- pedidos de compra de viagens (o motorista paga por Pix e a central confirma)
    CREATE TABLE IF NOT EXISTS compras (
      id           SERIAL PRIMARY KEY,
      motorista_id INT NOT NULL REFERENCES motoristas(id) ON DELETE CASCADE,
      quantidade   INT NOT NULL,
      valor        NUMERIC(10,2) NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pendente', -- pendente | pago | cancelado
      comprovante  BOOLEAN NOT NULL DEFAULT false,
      criado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
      pago_em      TIMESTAMPTZ
    );

    ALTER TABLE compras ADD COLUMN IF NOT EXISTS mp_id TEXT;
    ALTER TABLE compras ADD COLUMN IF NOT EXISTS pix_copia_cola TEXT;
    ALTER TABLE compras ADD COLUMN IF NOT EXISTS pix_expira TIMESTAMPTZ;
    ALTER TABLE compras ADD COLUMN IF NOT EXISTS mp_checado_em TIMESTAMPTZ;
    ALTER TABLE compras ADD COLUMN IF NOT EXISTS pago_por TEXT; -- mercado_pago | central

    -- código de 6 números mandado no WhatsApp para o motorista entrar na área dele no site
    CREATE TABLE IF NOT EXISTS motorista_codigos (
      motorista_id INT PRIMARY KEY REFERENCES motoristas(id) ON DELETE CASCADE,
      codigo_hash  TEXT NOT NULL,
      expira_em    TIMESTAMPTZ NOT NULL,
      tentativas   INT NOT NULL DEFAULT 0
    );

    -- extrato de viagens de cada motorista
    CREATE TABLE IF NOT EXISTS creditos_mov (
      id           SERIAL PRIMARY KEY,
      motorista_id INT NOT NULL REFERENCES motoristas(id) ON DELETE CASCADE,
      quantidade   INT NOT NULL,          -- + entrou, - saiu
      motivo       TEXT NOT NULL,         -- compra | corrida | estorno | bonus | ajuste
      corrida_id   INT,
      compra_id    INT,
      criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS corridas_status ON corridas (status);
    CREATE INDEX IF NOT EXISTS corridas_criado ON corridas (criado_em);
  `);
}

async function lerConfig() {
  const { rows } = await pool.query("SELECT valor FROM config WHERE chave = 'central'");
  const salvo = rows[0] ? rows[0].valor : {};
  const precos = {};
  for (const t of ORDEM) precos[t] = { ...PRECOS_PADRAO[t], ...((salvo.precos || {})[t] || {}) };
  // versão antiga tinha um preço só: vale para o carro
  if (!salvo.precos && salvo.taxa_base != null) Object.assign(precos.carro, { taxa_base: salvo.taxa_base, por_km: salvo.por_km, minimo: salvo.minimo });
  const cfg = { ...CONFIG_PADRAO, ...salvo, precos };
  delete cfg.taxa_base; delete cfg.por_km; delete cfg.minimo;
  // versão antiga: pacotes eram só quantidades, todas a "valor_viagem" cada
  if ((cfg.pacotes || []).some((p) => typeof p === 'number')) {
    cfg.pacotes = cfg.pacotes.map((p) => (typeof p === 'number' ? { qtd: p, preco: Math.round(p * Number(salvo.valor_viagem || 1) * 100) / 100 } : p));
  }
  delete cfg.valor_viagem;
  return cfg;
}

const tiposAtivos = (cfg) => ORDEM.filter((t) => cfg.precos[t].ativo);

// pacotes com o preço de cada viagem e o desconto em relação ao pacote de preço por viagem mais alto
function pacotesComDesconto(cfg) {
  const lista = (cfg.pacotes || []).filter((p) => p.qtd > 0 && p.preco > 0).sort((a, b) => a.qtd - b.qtd);
  const cheio = Math.max(...lista.map((p) => p.preco / p.qtd), 0);
  return lista.map((p) => {
    const cada = p.preco / p.qtd;
    return { ...p, cada, desconto: cheio ? Math.round((1 - cada / cheio) * 100) : 0 };
  });
}

// soma (ou tira) viagens do motorista e anota no extrato; devolve o saldo novo
async function moverCreditos(motoristaId, quantidade, motivo, ref = {}) {
  const { rows: [m] } = await pool.query('UPDATE motoristas SET creditos = creditos + $2 WHERE id = $1 RETURNING creditos', [motoristaId, quantidade]);
  await pool.query('INSERT INTO creditos_mov (motorista_id, quantidade, motivo, corrida_id, compra_id) VALUES ($1, $2, $3, $4, $5)',
    [motoristaId, quantidade, motivo, ref.corrida || null, ref.compra || null]);
  return m ? m.creditos : 0;
}

async function salvarConfig(valor) {
  await pool.query(
    `INSERT INTO config (chave, valor) VALUES ('central', $1)
     ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`, [JSON.stringify(valor)]);
}

module.exports = { pool, migrar, lerConfig, salvarConfig, tiposAtivos, moverCreditos, pacotesComDesconto, CONFIG_PADRAO };
