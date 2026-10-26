// Pix pelo Mercado Pago (API de Orders): gera o QR Code com o valor da compra e confirma sozinho quando o dinheiro cai.
// A confirmação sempre é conferida direto na API do Mercado Pago (o aviso que chega no webhook não é confiável sozinho).
//
//   MP_ACCESS_TOKEN   Access Token de PRODUÇÃO da aplicação no Mercado Pago (APP_USR-...)
//   MP_EMAIL          e-mail do pagador que vai no Pix (opcional; o Mercado Pago exige um)

const TOKEN = (process.env.MP_ACCESS_TOKEN || '').trim();
const BASE = process.env.MP_BASE || 'https://api.mercadopago.com'; // trocado só em teste
const EMAIL = process.env.MP_EMAIL || 'pagamentos@centraldecorridas.com.br';
const VALIDADE_MIN = 30;

const configurado = () => !!TOKEN;

async function chamar(metodo, caminho, corpo, idempotencia) {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(idempotencia ? { 'X-Idempotency-Key': idempotencia } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detalhe = (d.errors && d.errors.map((e) => e.message || e.code).join('; ')) || d.message || d.error || '';
    throw new Error('Mercado Pago ' + r.status + ': ' + detalhe);
  }
  return d;
}

const pagamentoDa = (d) => (d.transactions && d.transactions.payments && d.transactions.payments[0]) || {};

// cria o Pix da compra de viagens; devolve o copia e cola, a imagem do QR e quando vence
async function criarPix(compra, { nome, descricao }) {
  const expira = new Date(Date.now() + VALIDADE_MIN * 60_000);
  const valor = Number(compra.valor).toFixed(2);
  const partes = String(nome || 'Motorista').trim().split(/\s+/);
  const d = await chamar('POST', '/v1/orders', {
    type: 'online',
    processing_mode: 'automatic',
    total_amount: valor,
    external_reference: String(compra.id),
    description: descricao,
    payer: { email: EMAIL, first_name: partes[0], ...(partes.length > 1 ? { last_name: partes.slice(1).join(' ') } : {}) },
    transactions: { payments: [{ amount: valor, payment_method: { id: 'pix', type: 'bank_transfer' }, expiration_time: `PT${VALIDADE_MIN}M` }] },
  }, 'compra-' + compra.id);
  const pm = pagamentoDa(d).payment_method || {};
  if (!pm.qr_code) throw new Error('Mercado Pago não devolveu o QR Code');
  return { id: String(d.id), copia_cola: pm.qr_code, qr_base64: pm.qr_code_base64 || '', expira };
}

// situação do pagamento direto no Mercado Pago: 'approved' (pago), 'expired' (não pagou) ou 'pending'
async function consultar(id) {
  const d = await chamar('GET', '/v1/orders/' + encodeURIComponent(id));
  const pg = pagamentoDa(d);
  const st = String(d.status || ''), det = String(d.status_detail || pg.status_detail || '');
  const status = st === 'processed' || det === 'accredited' ? 'approved'
    : ['expired', 'canceled', 'cancelled', 'failed', 'refunded'].includes(st) ? 'expired' : 'pending';
  return { id: String(d.id), status, compra: Number(d.external_reference), valor: Number(pg.paid_amount || d.total_paid_amount || d.total_amount) };
}

// compra cancelada: o código Pix para de valer
const cancelar = (id) => chamar('POST', '/v1/orders/' + encodeURIComponent(id) + '/cancel', null, 'cancelar-' + id);

module.exports = { configurado, criarPix, consultar, cancelar, VALIDADE_MIN };
