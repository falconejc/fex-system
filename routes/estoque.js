const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirNivel } = require('../auth');

function hoje() {
  return new Date().toISOString().split('T')[0];
}

router.get('/hoje', (req, res) => {
  const data = hoje();
  const estoque = db.prepare('SELECT * FROM estoque WHERE data = ?').get(data);
  if (!estoque) return res.json({ data, simples_total: 0, bacon_total: 0, simples_vendidos: 0, bacon_vendidos: 0 });

  const simples_vendidos = db.prepare("SELECT COUNT(*) as c FROM vendas WHERE tipo='simples' AND cancelado=0 AND date(horario_compra)=?").get(data).c;
  const bacon_vendidos = db.prepare("SELECT COUNT(*) as c FROM vendas WHERE tipo='bacon' AND cancelado=0 AND date(horario_compra)=?").get(data).c;

  res.json({
    data,
    simples_total: estoque.simples_total,
    bacon_total: estoque.bacon_total,
    simples_vendidos,
    bacon_vendidos,
    simples_restantes: estoque.simples_total - simples_vendidos,
    bacon_restantes: estoque.bacon_total - bacon_vendidos,
  });
});

router.post('/', exigirNivel('admin', 'operador'), (req, res) => {
  const { simples_total, bacon_total } = req.body;
  const data = hoje();
  const existe = db.prepare('SELECT id FROM estoque WHERE data = ?').get(data);
  if (existe) {
    db.prepare('UPDATE estoque SET simples_total=?, bacon_total=?, usuario_id=?, atualizado_em=CURRENT_TIMESTAMP WHERE data=?')
      .run(simples_total, bacon_total, req.usuario.id, data);
  } else {
    db.prepare('INSERT INTO estoque (data, simples_total, bacon_total, usuario_id) VALUES (?,?,?,?)')
      .run(data, simples_total, bacon_total, req.usuario.id);
  }
  res.json({ sucesso: true });
});

module.exports = router;
