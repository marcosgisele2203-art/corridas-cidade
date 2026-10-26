// Tipos de veículo e a tabela de preço de cada um.
const TIPOS = {
  moto: { nome: 'Moto', emoji: '🏍️' },
  carro: { nome: 'Carro', emoji: '🚗' },
  van: { nome: 'Van', emoji: '🚐' },
  caminhao: { nome: 'Caminhão (frete)', emoji: '🚚' },
};
const ORDEM = ['moto', 'carro', 'van', 'caminhao'];

const PRECOS_PADRAO = {
  moto: { ativo: true, taxa_base: 4, por_km: 1.5, minimo: 6 },
  carro: { ativo: true, taxa_base: 5, por_km: 2, minimo: 8 },
  van: { ativo: true, taxa_base: 8, por_km: 3, minimo: 15 },
  caminhao: { ativo: true, taxa_base: 30, por_km: 5, minimo: 60 },
};

const rotulo = (tipo) => (TIPOS[tipo] ? `${TIPOS[tipo].emoji} ${TIPOS[tipo].nome}` : tipo);

// "1", "moto", "MOTO", "🏍" → 'moto'
function lerTipo(txt, ativos = ORDEM) {
  const t = String(txt || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= ativos.length) return ativos[n - 1];
  if (/moto/.test(t)) return 'moto';
  if (/carro|auto/.test(t)) return 'carro';
  if (/van|kombi|micro/.test(t)) return 'van';
  if (/caminh|frete|carga/.test(t)) return 'caminhao';
  return null;
}

// "Gol prata" (modelo e cor do veículo do motorista)
const veiculo = (m) => [m.carro, m.cor].filter(Boolean).join(' ');

module.exports = { TIPOS, ORDEM, PRECOS_PADRAO, rotulo, lerTipo, veiculo };
