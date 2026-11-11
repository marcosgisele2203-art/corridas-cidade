// Bairros cadastrados pela própria central (painel › Bairros).
// O administrador desenha o contorno de cada bairro no mapa uma vez; depois o sistema descobre sozinho
// em qual bairro está cada ponto, sem depender do OpenStreetMap (que não tem os bairros da cidade).

const { pool } = require('./db');

// contorno = [[lat, lng], ...] com pelo menos 3 pontos
function contornoValido(c) {
  return Array.isArray(c) && c.length >= 3 && c.length <= 300 &&
    c.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
      Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
}

// o ponto está dentro do contorno? (raio que cruza as bordas: número ímpar de cruzamentos = dentro)
function dentro(p, contorno) {
  let sim = false;
  for (let i = 0, j = contorno.length - 1; i < contorno.length; j = i++) {
    const [ai, oi] = contorno[i], [aj, oj] = contorno[j];
    if ((oi > p.lng) !== (oj > p.lng) && p.lat < ((aj - ai) * (p.lng - oi)) / (oj - oi) + ai) sim = !sim;
  }
  return sim;
}

// área aproximada (para escolher o menor quando um bairro foi desenhado por cima de outro)
function area(contorno) {
  let s = 0;
  for (let i = 0, j = contorno.length - 1; i < contorno.length; j = i++) s += (contorno[j][1] + contorno[i][1]) * (contorno[j][0] - contorno[i][0]);
  return Math.abs(s / 2);
}

// nome do bairro do ponto, ou '' se o ponto não está em nenhum bairro cadastrado
function bairroDoPonto(p, lista) {
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return '';
  const achados = lista.filter((b) => dentro(p, b.contorno));
  if (!achados.length) return '';
  return achados.reduce((menor, b) => (area(b.contorno) < area(menor.contorno) ? b : menor)).nome;
}

// ---- lista guardada em memória (muda pouco; recarrega quando o painel salva ou exclui)
let cache = null;
async function listar() {
  if (!cache) {
    const { rows } = await pool.query('SELECT id, nome, contorno FROM bairros ORDER BY nome');
    cache = rows;
  }
  return cache;
}
const limparCache = () => { cache = null; };

async function doPonto(p) {
  try { return bairroDoPonto(p, await listar()); }
  catch (e) { console.log('Bairros cadastrados indisponíveis:', e.message); return ''; }
}

module.exports = { contornoValido, dentro, bairroDoPonto, listar, limparCache, doPonto };
