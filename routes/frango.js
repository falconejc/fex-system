const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirNivel } = require('../auth');

function gerarCodigo() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function hoje() {
  return new Date().toISOString().split('T')[0];
}

router.post('/venda', (req, res) => {
  const { tipo, observacao } = req.body;
  const atendente = req.usuario.nome;
  if (!tipo) return res.status(400).json({ erro: 'Tipo obrigatório' });

  const data = hoje();
  const estoque = db.prepare('SELECT * FROM estoque WHERE data = ?').get(data);

  if (estoque) {
    const vendidos = db.prepare("SELECT COUNT(*) as c FROM vendas WHERE tipo=? AND cancelado=0 AND date(horario_compra)=?").get(tipo, data).c;
    const total = tipo === 'simples' ? estoque.simples_total : estoque.bacon_total;
    if (total > 0 && vendidos >= total) {
      return res.status(400).json({ erro: `Estoque esgotado! Todos os frangos ${tipo === 'simples' ? 'simples' : 'com bacon'} já foram vendidos.` });
    }
  }

  let codigo, tentativas = 0;
  do {
    codigo = gerarCodigo();
    if (++tentativas > 10) return res.status(500).json({ erro: 'Erro ao gerar código' });
  } while (db.prepare('SELECT id FROM vendas WHERE codigo = ?').get(codigo));

  db.prepare('INSERT INTO vendas (codigo, tipo, atendente, usuario_id, observacao) VALUES (?, ?, ?, ?, ?)')
    .run(codigo, tipo, atendente, req.usuario.id, observacao || '');

  res.json(db.prepare('SELECT * FROM vendas WHERE codigo = ?').get(codigo));
});

router.get('/pendentes', (req, res) => {
  res.json(db.prepare("SELECT * FROM vendas WHERE status='pendente' AND cancelado=0 ORDER BY horario_compra ASC").all());
});

router.get('/qrcode/:codigo', (req, res) => {
  const venda = db.prepare('SELECT * FROM vendas WHERE codigo = ?').get(req.params.codigo);
  if (!venda) return res.status(404).json({ erro: 'Código não encontrado' });
  res.json(venda);
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
  const { tipo, atendente, status, observacao } = req.body;
  const venda = db.prepare('SELECT * FROM vendas WHERE id = ?').get(req.params.id);
  if (!venda) return res.status(404).json({ erro: 'Venda não encontrada' });
  db.prepare('UPDATE vendas SET tipo=?, atendente=?, status=?, observacao=? WHERE id=?').run(tipo, atendente, status, observacao, req.params.id);
  res.json({ sucesso: true });
});

router.delete('/:id', exigirNivel('admin'), (req, res) => {
  const venda = db.prepare('SELECT * FROM vendas WHERE id = ?').get(req.params.id);
  if (!venda) return res.status(404).json({ erro: 'Venda não encontrada' });
  db.prepare('UPDATE vendas SET cancelado=1, status="cancelado" WHERE id=?').run(req.params.id);
  res.json({ sucesso: true });
});

module.exports = router;
