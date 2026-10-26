// Envio de mensagens pelo WhatsApp, direto na Evolution API.
//
// Cada número tem sua própria fila: as mensagens chegam na ordem certa e o robô não fica
// esperando a Evolution responder para atender a próxima pessoa.
const EVO = {
  url: (process.env.EVOLUTION_URL || '').replace(/\/+$/, ''),
  instancia: process.env.EVOLUTION_INSTANCE || '',
  chave: process.env.EVOLUTION_APIKEY || '',
};

const enviados = []; // últimas mensagens (aparecem no painel e ajudam nos testes)
const filas = new Map();

async function chamar(caminho, corpo) {
  enviados.push({ em: new Date().toISOString(), caminho, ...corpo });
  if (enviados.length > 200) enviados.shift();
  if (!EVO.url) { console.log('[WhatsApp desligado]', caminho, JSON.stringify(corpo)); return; }
  const r = await fetch(`${EVO.url}${caminho}/${encodeURIComponent(EVO.instancia)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: EVO.chave },
    body: JSON.stringify(corpo), signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error('Evolution respondeu ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

// nunca deixa um erro de envio derrubar o fluxo da corrida
function enfileirar(numero, caminho, corpo) {
  const anterior = filas.get(numero) || Promise.resolve();
  const p = anterior.then(() => chamar(caminho, corpo)).catch((e) => console.error('Falha ao enviar WhatsApp para', numero, e.message));
  filas.set(numero, p);
  p.then(() => { if (filas.get(numero) === p) filas.delete(numero); });
}

const texto = (numero, msg) => enfileirar(numero, '/message/sendText', { number: numero, text: msg });
const local = (numero, lat, lng, nome = '', endereco = '') =>
  enfileirar(numero, '/message/sendLocation', { number: numero, latitude: lat, longitude: lng, name: nome, address: endereco });

module.exports = { EVO, texto, local, enviados };
