const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirNivel } = require('../auth');

function hoje() {
  return new Date().toLocaleDateString('pt-BR', {timeZone:'America/Sao_Paulo'}).split('/').reverse().join('-');
}

function agora() {
  return new Date().toLocaleString('sv-SE', {timeZone:'America/Sao_Paulo'}).replace('T', ' ');
}

router.get('/resumo', (req, res) => {
  const data = hoje();
  const tipos = db.prepare('SELECT * FROM tipos_frango WHERE ativo = 1').all();
  const estoques = tipos.map(tipo => {
    const est = db.prepare('SELECT * FROM estoque WHERE data = ? AND tipo_id = ?').get(data, tipo.id);
    const vendidos = db.prepare("SELECT COUNT(*) as c FROM vendas WHERE tipo_id=? AND cancelado=0 AND date(horario_compra)=?").get(tipo.id, data).c;
    const lotes = db.prepare("SELECT * FROM lotes WHERE date(horario_entrada)=? AND tipo_id=? ORDER BY horario_previsto ASC").all(data, tipo.id);
    const prontos = lotes.filter(l => l.status === 'pronto').reduce((s, l) => s + l.quantidade, 0);
    const assando = lotes.filter(l => l.status === 'assando').reduce((s, l) => s + l.quantidade, 0);
    const total = est ? est.quantidade : 0;
    return { tipo_id: tipo.id, tipo_nome: tipo.nome, total, vendidos, restantes: Math.max(0, total - vendidos), prontos, assando, lotes };
  });

  const insumos = db.prepare('SELECT * FROM insumos WHERE ativo = 1 ORDER BY nome').all();
  const alertas = insumos.filter(i => i.quantidade_atual <= i.quantidade_minima);

  res.json({ estoques, insumos, alertas });
});

router.get('/historico', (req, res) => {
  const ini = req.query.ini || new Date().toISOString().split('T')[0];
  const fim = req.query.fim || new Date().toISOString().split('T')[0];
  const tipos = db.prepare('SELECT * FROM tipos_frango').all();

  const diasMap = {};
  let cur = new Date(ini + 'T12:00:00');
  const fimDate = new Date(fim + 'T12:00:00');
  while (cur <= fimDate) {
    const d = cur.toISOString().split('T')[0];
    diasMap[d] = { data: d, tipos: {} };
    tipos.forEach(t => {
      const est = db.prepare('SELECT * FROM estoque WHERE data = ? AND tipo_id = ?').get(d, t.id);
      const vendidos = db.prepare("SELECT COUNT(*) as c FROM vendas WHERE tipo_id=? AND cancelado=0 AND date(horario_compra)=?").get(t.id, d).c;
      const total = est ? est.quantidade : 0;
      diasMap[d].tipos[t.id] = { tipo_nome: t.nome, total, vendidos, sobra: Math.max(0, total - vendidos) };
    });
    cur.setDate(cur.getDate() + 1);
  }
  res.json({ historico: Object.values(diasMap), tipos });
});

router.get('/consumo', (req, res) => {
  const dias = parseInt(req.query.dias) || 30;
  const fim = hoje();
  const ini = new Date(Date.now() - (dias - 1) * 86400000).toISOString().split('T')[0];
  const tipos = db.prepare('SELECT * FROM tipos_frango WHERE ativo = 1').all();
  const resultado = tipos.map(tipo => {
    const vendas = db.prepare("SELECT COUNT(*) as c FROM vendas WHERE tipo_id=? AND cancelado=0 AND date(horario_compra) BETWEEN ? AND ?").get(tipo.id, ini, fim).c;
    const diasComVenda = db.prepare("SELECT COUNT(DISTINCT date(horario_compra)) as c FROM vendas WHERE tipo_id=? AND cancelado=0 AND date(horario_compra) BETWEEN ? AND ?").get(tipo.id, ini, fim).c;
    const mediaDia = diasComVenda > 0 ? Math.round(vendas / diasComVenda) : 0;
    return { tipo_id: tipo.id, tipo_nome: tipo.nome, total_vendido: vendas, dias_com_venda: diasComVenda, media_dia: mediaDia, previsao_semana: mediaDia * 7 };
  });
  res.json({ periodo: { ini, fim, dias }, consumo: resultado });
});

router.get('/insumos', (req, res) => {
  res.json(db.prepare('SELECT * FROM insumos ORDER BY nome').all());
});

router.post('/insumos', exigirNivel('admin', 'caixa'), (req, res) => {
  const { nome, unidade, quantidade_atual, quantidade_minima, descricao } = req.body;
  if (!nome || !unidade) return res.status(400).json({ erro: 'Nome e unidade obrigatórios' });
  const existe = db.prepare('SELECT id FROM insumos WHERE nome = ?').get(nome);
  if (existe) return res.status(400).json({ erro: 'Insumo já cadastrado' });
  db.prepare('INSERT INTO insumos (nome, unidade, quantidade_atual, quantidade_minima, descricao) VALUES (?,?,?,?,?)')
    .run(nome, unidade, quantidade_atual || 0, quantidade_minima || 0, descricao || '');
  res.json({ sucesso: true });
});

router.put('/insumos/:id', exigirNivel('admin', 'caixa'), (req, res) => {
  const { nome, unidade, quantidade_minima, descricao, ativo } = req.body;
  const insumo = db.prepare('SELECT * FROM insumos WHERE id = ?').get(req.params.id);
  if (!insumo) return res.status(404).json({ erro: 'Insumo não encontrado' });
  db.prepare('UPDATE insumos SET nome=?, unidade=?, quantidade_minima=?, descricao=?, ativo=? WHERE id=?')
    .run(nome, unidade, quantidade_minima, descricao, ativo, req.params.id);
  res.json({ sucesso: true });
});

router.post('/insumos/:id/movimentar', exigirNivel('admin', 'caixa'), (req, res) => {
  const { tipo, quantidade, observacao } = req.body;
  if (!tipo || !quantidade) return res.status(400).json({ erro: 'Tipo e quantidade obrigatórios' });
  const insumo = db.prepare('SELECT * FROM insumos WHERE id = ?').get(req.params.id);
  if (!insumo) return res.status(404).json({ erro: 'Insumo não encontrado' });
  const nova = tipo === 'entrada' ? insumo.quantidade_atual + quantidade : insumo.quantidade_atual - quantidade;
  if (nova < 0) return res.status(400).json({ erro: 'Quantidade insuficiente em estoque' });
  db.prepare('UPDATE insumos SET quantidade_atual=? WHERE id=?').run(nova, req.params.id);
  db.prepare('INSERT INTO movimentacoes_insumos (insumo_id, tipo, quantidade, observacao, usuario_id) VALUES (?,?,?,?,?)')
    .run(req.params.id, tipo, quantidade, observacao || '', req.usuario.id);
  res.json({ sucesso: true, quantidade_atual: nova });
});

router.get('/insumos/:id/movimentacoes', (req, res) => {
  const movs = db.prepare(`
    SELECT m.*, u.nome as usuario_nome
    FROM movimentacoes_insumos m
    LEFT JOIN usuarios u ON m.usuario_id = u.id
    WHERE m.insumo_id = ?
    ORDER BY m.criado_em DESC
    LIMIT 30
  `).all(req.params.id);
  res.json(movs);
});

module.exports = router;
