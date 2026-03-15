const express = require('express');
const router = express.Router();
const db = require('../database');

router.get('/dia', (req, res) => {
  const data = req.query.data || new Date().toISOString().split('T')[0];

  const vendas = db.prepare(`
    SELECT * FROM vendas
    WHERE date(horario_compra) = ?
    ORDER BY horario_compra DESC
  `).all(data);

  const delivery = db.prepare(`
    SELECT * FROM delivery
    WHERE date(horario_pedido) = ?
    ORDER BY horario_pedido DESC
  `).all(data);

  const resumo = {
    total_vendas: vendas.length,
    vendas_pendentes: vendas.filter(v => v.status === 'pendente').length,
    vendas_entregues: vendas.filter(v => v.status === 'entregue').length,
    total_delivery: delivery.length,
    delivery_pendentes: delivery.filter(d => d.status === 'pendente').length,
    delivery_entregues: delivery.filter(d => d.status === 'entregue').length,
  };

  res.json({ data, resumo, vendas, delivery });
});

module.exports = router;
