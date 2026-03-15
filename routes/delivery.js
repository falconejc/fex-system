const express = require('express');
const router = express.Router();
const db = require('../database');

function gerarCodigo() {
  return 'D' + Math.random().toString(36).substring(2, 7).toUpperCase();
}

router.post('/pedido', (req, res) => {
  const { tipo, atendente, nome_cliente, endereco, numero, bairro, referencia, pagamento, descricao } = req.body;
  if (!tipo || !atendente || !nome_cliente || !pagamento) return res.status(400).json({ erro: 'Campos obrigatórios' });

  let codigo;
  let tentativas = 0;
  do {
    codigo = gerarCodigo();
    tentativas++;
    if (tentativas > 10) return res.status(500).json({ erro: 'Erro ao gerar código' });
  } while (db.prepare('SELECT id FROM delivery WHERE codigo = ?').get(codigo));

  db.prepare(`
    INSERT INTO delivery (codigo, tipo, atendente, nome_cliente, endereco, numero, bairro, referencia, pagamento, descricao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(codigo, tipo, atendente, nome_cliente, endereco || '', numero || '', bairro || '', referencia || '', pagamento, descricao || '');

  const pedido = db.prepare('SELECT * FROM delivery WHERE codigo = ?').get(codigo);
  res.json(pedido);
});

router.get('/pendentes', (req, res) => {
  const pedidos = db.prepare("SELECT * FROM delivery WHERE status = 'pendente' ORDER BY horario_pedido ASC").all();
  res.json(pedidos);
});

router.post('/entrega/:codigo', (req, res) => {
  const { codigo } = req.params;
  const pedido = db.prepare('SELECT * FROM delivery WHERE codigo = ?').get(codigo);
  if (!pedido) return res.status(404).json({ erro: 'Código não encontrado' });
  if (pedido.status === 'entregue') return res.status(400).json({ erro: 'Já entregue' });

  db.prepare("UPDATE delivery SET status = 'entregue', horario_entrega = CURRENT_TIMESTAMP WHERE codigo = ?").run(codigo);
  res.json({ sucesso: true });
});

module.exports = router;
