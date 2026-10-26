// Relatório individual do motorista: corridas, ganhos e viagens (créditos) num período.
const { pool } = require('./db');
const { rotulo, veiculo } = require('./tipos');

const FUSO = 'America/Campo_Grande';
const reais = (v) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
const dataBR = (iso) => iso.split('-').reverse().join('/');

// de/ate no formato AAAA-MM-DD (dias do fuso da central)
async function montar(motoristaId, de, ate) {
  const { rows: [m] } = await pool.query('SELECT * FROM motoristas WHERE id = $1', [motoristaId]);
  if (!m) return null;
  const filtro = `(c.criado_em AT TIME ZONE '${FUSO}')::date BETWEEN $2 AND $3`;
  const { rows: corridas } = await pool.query(`
    SELECT c.id, c.status, c.origem_texto, c.destino_texto, c.km, c.valor_final, c.valor_estimado, c.avaliacao, c.tipo,
           to_char(c.criado_em AT TIME ZONE '${FUSO}', 'DD/MM HH24:MI') AS quando
      FROM corridas c WHERE c.motorista_id = $1 AND c.status IN ('finalizada', 'cancelada') AND ${filtro}
     ORDER BY c.criado_em`, [m.id, de, ate]);
  const finalizadas = corridas.filter((c) => c.status === 'finalizada');
  const notas = finalizadas.filter((c) => c.avaliacao).map((c) => c.avaliacao);
  const { rows: mov } = await pool.query(`
    SELECT motivo, sum(quantidade)::int AS qtd FROM creditos_mov
     WHERE motorista_id = $1 AND (criado_em AT TIME ZONE '${FUSO}')::date BETWEEN $2 AND $3 GROUP BY motivo`, [m.id, de, ate]);
  const viagens = Object.fromEntries(mov.map((x) => [x.motivo, x.qtd]));
  const { rows: [pago] } = await pool.query(`
    SELECT coalesce(sum(valor), 0)::float AS valor FROM compras
     WHERE motorista_id = $1 AND status = 'pago' AND (pago_em AT TIME ZONE '${FUSO}')::date BETWEEN $2 AND $3`, [m.id, de, ate]);
  return {
    motorista: { id: m.id, nome: m.nome, telefone: m.telefone, contato: m.contato, tipo: m.tipo, veiculo: veiculo(m), placa: m.placa, saldo: m.creditos },
    de, ate,
    corridas,
    totais: {
      finalizadas: finalizadas.length,
      canceladas: corridas.length - finalizadas.length,
      ganhos: finalizadas.reduce((s, c) => s + Number(c.valor_final || 0), 0),
      km: finalizadas.reduce((s, c) => s + Number(c.km || 0), 0),
      nota: notas.length ? Math.round((notas.reduce((a, b) => a + b, 0) / notas.length) * 10) / 10 : null,
      avaliacoes: notas.length,
    },
    viagens: {
      compradas: viagens.compra || 0,
      bonus: viagens.bonus || 0,
      usadas: -(viagens.corrida || 0) - (viagens.estorno || 0),
      ajustes: viagens.ajuste || 0,
      pago: pago.valor,
    },
  };
}

// texto para mandar no WhatsApp
function texto(r, nomeCentral, cobranca = true) {
  const t = r.totais, v = r.viagens;
  const linhas = [
    `📊 *Relatório · ${nomeCentral}*`,
    `👤 ${r.motorista.nome}`,
    `${rotulo(r.motorista.tipo)} · ${r.motorista.veiculo} · ${r.motorista.placa}`,
    `📅 ${dataBR(r.de)}${r.de !== r.ate ? ' a ' + dataBR(r.ate) : ''}`,
    '',
    `🏁 Corridas feitas: *${t.finalizadas}*` + (t.canceladas ? ` (${t.canceladas} cancelada${t.canceladas > 1 ? 's' : ''})` : ''),
    `💰 Total das corridas: *${reais(t.ganhos)}*`,
  ];
  if (t.km) linhas.push(`📏 Distância: ${t.km.toFixed(1).replace('.', ',')} km`);
  if (t.nota) linhas.push(`⭐ Nota média: *${String(t.nota).replace('.', ',')}* (${t.avaliacoes} avaliaç${t.avaliacoes > 1 ? 'ões' : 'ão'})`);
  if (cobranca) {
    linhas.push('', '🎟️ *Viagens*');
    if (v.compradas) linhas.push(`Compradas: ${v.compradas} (${reais(v.pago)})`);
    if (v.bonus) linhas.push(`Grátis: ${v.bonus}`);
    if (v.ajustes) linhas.push(`Ajustes da central: ${v.ajustes > 0 ? '+' : ''}${v.ajustes}`);
    linhas.push(`Usadas: ${v.usadas}`, `Saldo atual: *${r.motorista.saldo}*`);
  }
  const lista = r.corridas.filter((c) => c.status === 'finalizada');
  if (lista.length) {
    linhas.push('', '*Corridas*');
    const mostrar = lista.slice(-25);
    if (lista.length > mostrar.length) linhas.push(`_(últimas ${mostrar.length} de ${lista.length})_`);
    for (const c of mostrar) {
      linhas.push(`${c.quando} · ${c.origem_texto.slice(0, 25)} → ${c.destino_texto.slice(0, 25)} · ${reais(c.valor_final)}${c.avaliacao ? ' · ' + c.avaliacao + '⭐' : ''}`);
    }
  }
  return linhas.join('\n');
}

// primeiro dia do mês e hoje, no fuso da central
function mesAtual() {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(new Date());
  return { de: hoje.slice(0, 8) + '01', ate: hoje };
}

module.exports = { montar, texto, mesAtual };
