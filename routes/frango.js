/**
 * @file frango.js
 * @description Rotas para vendas de frango assado.
 * Gerencia registro de vendas, validação de estoque, geração de código único,
 * baixa de entregas e consulta por QR code.
 */

const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirNivel } = require('../auth');

function gerarCodigo() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function hoje() {
  return new Date().toLocaleDateString('pt-BR', {timeZone:'America/Sao_Paulo'}).split('/').reverse().join('-');
}

function agora() {
  return new Date().toLocaleString('sv-SE', {timeZone:'America/Sao_Paulo'}).replace('T', ' ');
}

router.post('/venda', (req, res) => {
  const { tipo_id, observacao, telefone } = req.body;
  const atendente = req.usuario.nome;
  if (!tipo_id) return res.status(400).json({ erro: 'Tipo obrigatório' });

  const tipo = db.prepare('SELECT * FROM tipos_frango WHERE id = ? AND ativo = 1').get(tipo_id);
  if (!tipo) return res.status(400).json({ erro: 'Tipo inválido' });

  const data = hoje();
  const est = db.prepare('SELECT * FROM estoque WHERE data = ? AND tipo_id = ?').get(data, tipo_id);
  if (est && est.quantidade > 0) {
    const vendidos = db.prepare("SELECT COUNT(*) as c FROM vendas WHERE tipo_id=? AND cancelado=0 AND date(horario_compra)=?").get(tipo_id, data).c;
    if (vendidos >= est.quantidade) {
      return res.status(400).json({ erro: `Estoque esgotado para ${tipo.nome}!` });
    }
  }

  let codigo, tentativas = 0;
  do {
    codigo = gerarCodigo();
    if (++tentativas > 10) return res.status(500).json({ erro: 'Erro ao gerar código' });
  } while (db.prepare('SELECT id FROM vendas WHERE codigo = ?').get(codigo));

  db.prepare('INSERT INTO vendas (codigo, tipo, tipo_id, atendente, usuario_id, observacao, telefone, horario_compra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(codigo, tipo.nome, tipo_id, atendente, req.usuario.id, observacao || '', telefone || '', agora());

  // Baixa automatica de insumos vinculados ao tipo
  const insumos_vinculados = db.prepare('SELECT ti.*, i.nome, i.quantidade_atual FROM tipo_insumos ti LEFT JOIN insumos i ON ti.insumo_id = i.id WHERE ti.tipo_id = ?').all(tipo_id);
  const alertas_insumos = [];
  insumos_vinculados.forEach(iv => {
    const nova_qtd = iv.quantidade_atual - iv.quantidade;
    db.prepare('UPDATE insumos SET quantidade_atual = ? WHERE id = ?').run(nova_qtd, iv.insumo_id);
    db.prepare('INSERT INTO movimentacoes_insumos (insumo_id, tipo, quantidade, observacao, usuario_id) VALUES (?, ?, ?, ?, ?)').run(iv.insumo_id, 'saida', iv.quantidade, 'Venda automatica - ' + codigo, req.usuario.id);
    if (nova_qtd <= 0) alertas_insumos.push({ nome: iv.nome, quantidade_atual: nova_qtd });
  });

  const venda = db.prepare('SELECT * FROM vendas WHERE codigo = ?').get(codigo);
  res.json({ ...venda, tipo_nome: tipo.nome, alertas_insumos });
});

router.get('/pendentes', (req, res) => {
  res.json(db.prepare(`
    SELECT v.*, t.nome as tipo_nome, t.preco
    FROM vendas v
    LEFT JOIN tipos_frango t ON v.tipo_id = t.id
    WHERE v.status='pendente' AND v.cancelado=0
    ORDER BY v.horario_compra ASC
  `).all());
});

router.get('/qrcode/:codigo', (req, res) => {
  const venda = db.prepare(`
    SELECT v.*, t.nome as tipo_nome FROM vendas v
    LEFT JOIN tipos_frango t ON v.tipo_id = t.id
    WHERE v.codigo = ?
  `).get(req.params.codigo);
  if (!venda) return res.status(404).json({ erro: 'Código não encontrado' });
  res.json(venda);
});

router.post('/entrega/:codigo', (req, res) => {
  const venda = db.prepare('SELECT * FROM vendas WHERE codigo = ?').get(req.params.codigo);
  if (!venda) return res.status(404).json({ erro: 'Código não encontrado' });
  if (venda.status === 'entregue') return res.status(400).json({ erro: 'Já entregue' });
  if (venda.cancelado) return res.status(400).json({ erro: 'Venda cancelada' });
  db.prepare("UPDATE vendas SET status='entregue', horario_entrega=? WHERE codigo=?").run(agora(), req.params.codigo);
  res.json({ sucesso: true });
});

router.put('/:id', exigirNivel('admin'), (req, res) => {
  const { tipo_id, atendente, status, observacao } = req.body;
  const venda = db.prepare('SELECT * FROM vendas WHERE id = ?').get(req.params.id);
  if (!venda) return res.status(404).json({ erro: 'Venda não encontrada' });
  const tipo = db.prepare('SELECT * FROM tipos_frango WHERE id = ?').get(tipo_id);
  db.prepare('UPDATE vendas SET tipo=?, tipo_id=?, atendente=?, status=?, observacao=? WHERE id=?')
    .run(tipo ? tipo.nome : venda.tipo, tipo_id, atendente, status, observacao, req.params.id);
  res.json({ sucesso: true });
});

router.delete('/:id', exigirNivel('admin'), (req, res) => {
  const venda = db.prepare('SELECT * FROM vendas WHERE id = ?').get(req.params.id);
  if (!venda) return res.status(404).json({ erro: 'Venda não encontrada' });
  db.prepare('UPDATE vendas SET cancelado=1, status="cancelado" WHERE id=?').run(req.params.id);
  res.json({ sucesso: true });
});

module.exports = router;
