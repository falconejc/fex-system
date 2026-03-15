const express = require('express');
const router = express.Router();
const db = require('../database');

function gerarCodigo() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

router.post('/venda', (req, res) => {
  const { tipo, atendente } = req.body;
  if (!tipo || !atendente) return res.status(400).json({ erro: 'Campos obrigatórios' });

  let codigo;
  let tentativas = 0;
  do {
    codigo = gerarCodigo();
    tentativas++;
    if (tentativas > 10) return res.status(500).json({ erro: 'Erro ao gerar código' });
  } while (db.prepare('SELECT id FROM vendas WHERE codigo = ?').get(codigo));

  db.prepare('INSERT INTO vendas (codigo, tipo, atendente) VALUES (?, ?, ?)').run(codigo, tipo, atendente);
  const venda = db.prepare('SELECT * FROM vendas WHERE codigo = ?').get(codigo);
  res.json(venda);
});

router.get('/pendentes', (req, res) => {
  const vendas = db.prepare("SELECT * FROM vendas WHERE status = 'pendente' ORDER BY horario_compra ASC").all();
  res.json(vendas);
});

router.post('/entrega/:codigo', (req, res) => {
  const { codigo } = req.params;
  const venda = db.prepare('SELECT * FROM vendas WHERE codigo = ?').get(codigo);
  if (!venda) return res.status(404).json({ erro: 'Código não encontrado' });
  if (venda.status === 'entregue') return res.status(400).json({ erro: 'Já entregue' });

  db.prepare("UPDATE vendas SET status = 'entregue', horario_entrega = CURRENT_TIMESTAMP WHERE codigo = ?").run(codigo);
  res.json({ sucesso: true });
});

module.exports = router;
