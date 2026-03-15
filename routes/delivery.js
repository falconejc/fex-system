/**
 * @file delivery.js
 * @description Rotas para pedidos de delivery.
 * Gerencia registro de pedidos (entrega/retirada), baixa de entregas
 * e edição/cancelamento por administradores.
 */

const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirNivel } = require('../auth');

function gerarCodigo() {
  return 'D' + Math.random().toString(36).substring(2, 7).toUpperCase();
}

router.post('/pedido', (req, res) => {
  const { tipo, atendente, nome_cliente, endereco, numero, bairro, referencia, pagamento, descricao } = req.body;
  if (!tipo || !atendente || !nome_cliente || !pagamento) return res.status(400).json({ erro: 'Campos obrigatórios' });
  let codigo, tentativas = 0;
  do {
    codigo = gerarCodigo();
    if (++tentativas > 10) return res.status(500).json({ erro: 'Erro ao gerar código' });
  } while (db.prepare('SELECT id FROM delivery WHERE codigo = ?').get(codigo));
  db.prepare(`INSERT INTO delivery (codigo, tipo, atendente, usuario_id, nome_cliente, endereco, numero, bairro, referencia, pagamento, descricao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(codigo, tipo, atendente, req.usuario.id, nome_cliente, endereco||'', numero||'', bairro||'', referencia||'', pagamento, descricao||'');
  res.json(db.prepare('SELECT * FROM delivery WHERE codigo = ?').get(codigo));
});

router.get('/pendentes', (req, res) => {
  res.json(db.prepare("SELECT * FROM delivery WHERE status='pendente' AND cancelado=0 ORDER BY horario_pedido ASC").all());
});

router.post('/entrega/:codigo', (req, res) => {
  const pedido = db.prepare('SELECT * FROM delivery WHERE codigo = ?').get(req.params.codigo);
  if (!pedido) return res.status(404).json({ erro: 'Código não encontrado' });
  if (pedido.status === 'entregue') return res.status(400).json({ erro: 'Já entregue' });
  if (pedido.cancelado) return res.status(400).json({ erro: 'Pedido cancelado' });
  db.prepare("UPDATE delivery SET status='entregue', horario_entrega=CURRENT_TIMESTAMP WHERE codigo=?").run(req.params.codigo);
  res.json({ sucesso: true });
});

router.put('/:id', exigirNivel('admin'), (req, res) => {
  const { tipo, atendente, nome_cliente, endereco, numero, bairro, referencia, pagamento, descricao, status } = req.body;
  const pedido = db.prepare('SELECT * FROM delivery WHERE id = ?').get(req.params.id);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' });
  db.prepare(`UPDATE delivery SET tipo=?, atendente=?, nome_cliente=?, endereco=?, numero=?, bairro=?, referencia=?, pagamento=?, descricao=?, status=? WHERE id=?`)
    .run(tipo, atendente, nome_cliente, endereco, numero, bairro, referencia, pagamento, descricao, status, req.params.id);
  res.json({ sucesso: true });
});

router.delete('/:id', exigirNivel('admin'), (req, res) => {
  const pedido = db.prepare('SELECT * FROM delivery WHERE id = ?').get(req.params.id);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' });
  db.prepare('UPDATE delivery SET cancelado=1, status="cancelado" WHERE id=?').run(req.params.id);
  res.json({ sucesso: true });
});

module.exports = router;
