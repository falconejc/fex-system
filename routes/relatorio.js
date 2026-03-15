/**
 * @file relatorio.js
 * @description Rotas para geração de relatórios.
 * Fornece dados de vendas e deliveries por dia e por período,
 * usados nas telas de relatório e dashboard.
 */

const express = require('express');
const router = express.Router();
const db = require('../database');

router.get('/dia', (req, res) => {
  const data = req.query.data || new Date().toISOString().split('T')[0];
  const vendas = db.prepare("SELECT * FROM vendas WHERE date(horario_compra) = ? ORDER BY horario_compra DESC").all(data);
  const delivery = db.prepare("SELECT * FROM delivery WHERE date(horario_pedido) = ? ORDER BY horario_pedido DESC").all(data);
  res.json({
    data,
    resumo: {
      total_vendas: vendas.length,
      vendas_pendentes: vendas.filter(v => v.status === 'pendente').length,
      vendas_entregues: vendas.filter(v => v.status === 'entregue').length,
      total_delivery: delivery.length,
      delivery_pendentes: delivery.filter(d => d.status === 'pendente').length,
      delivery_entregues: delivery.filter(d => d.status === 'entregue').length,
    },
    vendas,
    delivery
  });
});

router.get('/periodo', (req, res) => {
  const ini = req.query.ini || new Date().toISOString().split('T')[0];
  const fim = req.query.fim || new Date().toISOString().split('T')[0];
  const vendas = db.prepare("SELECT * FROM vendas WHERE date(horario_compra) BETWEEN ? AND ? ORDER BY horario_compra ASC").all(ini, fim);
  const delivery = db.prepare("SELECT * FROM delivery WHERE date(horario_pedido) BETWEEN ? AND ? ORDER BY horario_pedido ASC").all(ini, fim);

  const diasMap = {};
  let cur = new Date(ini + 'T12:00:00');
  const fimDate = new Date(fim + 'T12:00:00');
  while (cur <= fimDate) {
    const d = cur.toISOString().split('T')[0];
    diasMap[d] = { data: d, vendas: 0, delivery: 0 };
    cur.setDate(cur.getDate() + 1);
  }
  vendas.forEach(v => { const d = v.horario_compra.split('T')[0].split(' ')[0]; if (diasMap[d]) diasMap[d].vendas++; });
  delivery.forEach(d => { const dia = d.horario_pedido.split('T')[0].split(' ')[0]; if (diasMap[dia]) diasMap[dia].delivery++; });

  res.json({ vendas, delivery, porDia: Object.values(diasMap) });
});

module.exports = router;
