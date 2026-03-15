const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirNivel } = require('../auth');

function gerarCodigo() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

router.post('/venda', (req, res) => {
  const { tipo, atendente } = req.body;
  if (!tipo || !atendente) return res.status(400).json({ erro: 'Campos obrigatórios' });
  let codigo, tentativas = 0;
  do {
    codigo = gerarCodigo();
    if (++tentativas > 10) return res.status(500).json({ erro: 'Erro ao gerar código' });
  } while (db.prepare('SELECT id FROM vendas WHERE codigo = ?').get(codigo));
  db.prepare('INSERT INTO vendas (codigo, tipo, atendente, usuario_id) VALUES (?, ?, ?, ?)').run(codigo, tipo, atendente, req.usuario.id);
  res.json(db.prepare('SELECT * FROM vendas WHERE codigo = ?').get(codigo));
});

router.get('/pendentes', (req, res) => {
  res.json(db.prepare("SELECT * FROM vendas WHERE status = 'pendente' AND cancelado = 0 ORDER BY horario_compra ASC").all());
});

router.post('/entrega/:codigo', (req, res) => {
  const venda = db.prepare('SELECT * FROM vendas WHERE codigo = ?').get(req.params.codigo);
  if (!venda) return res.status(404).json({ erro: 'Código não encontrado' });
  if (venda.status === 'entregue') return res.status(400).json({ erro: 'Já entregue' });
  if (venda.cancelado) return res.status(400).json({ erro: 'Venda cancelada' });
  db.prepare("UPDATE vendas SET status='entregue', horario_entrega=CURRENT_TIMESTAMP WHERE codigo=?").run(req.params.codigo);
  res.json({ sucesso: true });
});

router.put('/:id', exigirNivel('admin'), (req, res) => {
  const { tipo, atendente, status } = req.body;
  const venda = db.prepare('SELECT * FROM vendas WHERE id = ?').get(req.params.id);
  if (!venda) return res.status(404).json({ erro: 'Venda não encontrada' });
  db.prepare('UPDATE vendas SET tipo=?, atendente=?, status=? WHERE id=?').run(tipo, atendente, status, req.params.id);
  res.json({ sucesso: true });
});

router.delete('/:id', exigirNivel('admin'), (req, res) => {
  const venda = db.prepare('SELECT * FROM vendas WHERE id = ?').get(req.params.id);
  if (!venda) return res.status(404).json({ erro: 'Venda não encontrada' });
  db.prepare('UPDATE vendas SET cancelado=1, status="cancelado" WHERE id=?').run(req.params.id);
  res.json({ sucesso: true });
});

module.exports = router;
