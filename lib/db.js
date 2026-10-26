// Banco: conexão, criação/atualização das tabelas e configurações.
const { Pool } = require('pg');
const { ORDEM, PRECOS_PADRAO } = require('./tipos');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

const CONFIG_PADRAO = {
  nome: 'Central de Corridas',
  cidade: '',              // ex.: "Bonito, MS" (ajuda a achar endereços digitados)
  numero_admin: '',        // recebe aviso quando não há motorista
  precos: PRECOS_PADRAO,    // por tipo de veículo: taxa base + R$/km, valor mínimo, se está oferecido
  aprovar_automatico: false, // motorista que se cadastra pelo WhatsApp já começa a trabalhar
  fator_rota: 1.3,         // linha reta × fator ≈ distância pelas ruas
  oferta_segundos: 40,     // tempo que cada motorista tem para aceitar
  comissao_pct: 10,        // % da central sobre cada corrida
  aceitando: true,         // central aberta para pedidos
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
  return cfg;
}

const tiposAtivos = (cfg) => ORDEM.filter((t) => cfg.precos[t].ativo);

async function salvarConfig(valor) {
  await pool.query(
    `INSERT INTO config (chave, valor) VALUES ('central', $1)
     ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`, [JSON.stringify(valor)]);
}

module.exports = { pool, migrar, lerConfig, salvarConfig, tiposAtivos, CONFIG_PADRAO };
