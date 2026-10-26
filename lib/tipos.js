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

// Cores mais comuns de cada tipo de veículo. Carro e caminhão: "branco"; moto e van: "branca".
const COR = {
  branco: { m: 'branco', f: 'branca', hex: '#ffffff' },
  prata: { m: 'prata', f: 'prata', hex: '#c0c4c8' },
  preto: { m: 'preto', f: 'preta', hex: '#1b1b1b' },
  cinza: { m: 'cinza', f: 'cinza', hex: '#8a8f94' },
  grafite: { m: 'grafite', f: 'grafite', hex: '#4a4f55' },
  vermelho: { m: 'vermelho', f: 'vermelha', hex: '#c62828' },
  vinho: { m: 'vinho', f: 'vinho', hex: '#6d1a2a' },
  azul: { m: 'azul', f: 'azul', hex: '#1e5bb8' },
  azul_marinho: { m: 'azul-marinho', f: 'azul-marinho', hex: '#1a2a4f' },
  verde: { m: 'verde', f: 'verde', hex: '#2e7d32' },
  amarelo: { m: 'amarelo', f: 'amarela', hex: '#f2c200' },
  laranja: { m: 'laranja', f: 'laranja', hex: '#ef6c00' },
  marrom: { m: 'marrom', f: 'marrom', hex: '#6d4c2f' },
  bege: { m: 'bege', f: 'bege', hex: '#d8c7a5' },
  dourado: { m: 'dourado', f: 'dourada', hex: '#c9a227' },
  rosa: { m: 'rosa', f: 'rosa', hex: '#e86aa6' },
  roxo: { m: 'roxo', f: 'roxa', hex: '#6a3fa0' },
};
const PALETA = {
  carro: ['branco', 'prata', 'preto', 'cinza', 'grafite', 'vermelho', 'azul', 'vinho', 'marrom', 'bege', 'verde', 'amarelo', 'laranja', 'dourado'],
  moto: ['preto', 'vermelho', 'branco', 'azul', 'prata', 'cinza', 'grafite', 'verde', 'amarelo', 'laranja', 'rosa', 'roxo'],
  van: ['branco', 'prata', 'preto', 'cinza', 'azul', 'vermelho', 'amarelo', 'bege'],
  caminhao: ['branco', 'vermelho', 'azul', 'prata', 'preto', 'cinza', 'amarelo', 'verde', 'laranja'],
};
const FEMININO = { moto: true, van: true };

// [{ nome: 'branca', hex: '#fff' }, ...] na ordem da paleta do tipo
const coresDo = (tipo) => (PALETA[tipo] || PALETA.carro).map((k) => ({ nome: COR[k][FEMININO[tipo] ? 'f' : 'm'], hex: COR[k].hex }));

// "1" ou "Branca" → "branca" (no gênero do veículo); outra cor digitada passa como veio
function lerCor(txt, tipo) {
  const lista = coresDo(tipo);
  const t = String(txt || '').trim().toLowerCase();
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= lista.length) return lista[n - 1].nome;
  const sem = (v) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/-/g, ' ');
  for (const k of Object.keys(COR)) {
    if ([COR[k].m, COR[k].f].some((v) => sem(v) === sem(t))) return COR[k][FEMININO[tipo] ? 'f' : 'm'];
  }
  return t.length >= 3 && !/^\d+$/.test(t) ? t.slice(0, 30) : null;
}

// "Gol prata" (modelo e cor do veículo do motorista)
const veiculo = (m) => [m.carro, m.cor].filter(Boolean).join(' ');

module.exports = { TIPOS, ORDEM, PRECOS_PADRAO, rotulo, lerTipo, veiculo, coresDo, lerCor };
