// Banco: conexão, criação/atualização das tabelas e configurações.
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

const CONFIG_PADRAO = {
  nome: 'Central de Corridas',
  cidade: '',              // ex.: "Bonito, MS" (ajuda a achar endereços digitados)
  numero_admin: '',        // recebe aviso quando não há motorista
  taxa_base: 5,            // R$ fixo de toda corrida
  por_km: 2,               // R$ por km
  minimo: 8,               // valor mínimo da corrida
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
    CREATE INDEX IF NOT EXISTS corridas_status ON corridas (status);
    CREATE INDEX IF NOT EXISTS corridas_criado ON corridas (criado_em);
  `);
}

async function lerConfig() {
  const { rows } = await pool.query("SELECT valor FROM config WHERE chave = 'central'");
  return { ...CONFIG_PADRAO, ...(rows[0] ? rows[0].valor : {}) };
}

async function salvarConfig(valor) {
  await pool.query(
    `INSERT INTO config (chave, valor) VALUES ('central', $1)
     ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`, [JSON.stringify(valor)]);
}

module.exports = { pool, migrar, lerConfig, salvarConfig, CONFIG_PADRAO };
