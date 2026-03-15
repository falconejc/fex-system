/**
 * @file estoque.js
 * @description Rotas para controle do estoque diário de frangos por tipo.
 * Permite configurar quantos frangos de cada tipo estão disponíveis para venda no dia.
 */

const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirNivel } = require('../auth');

function hoje() {
  return new Date().toLocaleDateString('pt-BR', {timeZone:'America/Sao_Paulo'}).split('/').reverse().join('-');
}

router.get('/hoje', (req, res) => {
  const data = hoje();
  const tipos = db.prepare('SELECT * FROM tipos_frango WHERE ativo = 1').all();
  const resultado = tipos.map(tipo => {
    const est = db.prepare('SELECT * FROM estoque WHERE data = ? AND tipo_id = ?').get(data, tipo.id);
    const vendidos = db.prepare("SELECT COUNT(*) as c FROM vendas WHERE tipo_id=? AND cancelado=0 AND date(horario_compra)=?").get(tipo.id, data).c;
    const lotes = db.prepare("SELECT * FROM lotes WHERE date(horario_entrada)=? AND tipo_id=? ORDER BY horario_previsto ASC").all(data, tipo.id);
    const prontos = lotes.filter(l => l.status === 'pronto').reduce((s, l) => s + l.quantidade, 0);
    const assando = lotes.filter(l => l.status === 'assando').reduce((s, l) => s + l.quantidade, 0);
    const total = est ? est.quantidade : 0;
    return {
      tipo_id: tipo.id,
      tipo_nome: tipo.nome,
      tipo_preco: tipo.preco,
      total,
      vendidos,
      restantes: Math.max(0, total - vendidos),
      prontos,
      assando,
      lotes
    };
  });
  res.json(resultado);
});

router.post('/', exigirNivel('admin', 'caixa'), (req, res) => {
  const { estoques } = req.body;
  if (!estoques || !Array.isArray(estoques)) return res.status(400).json({ erro: 'Dados inválidos' });
  const data = hoje();
  estoques.forEach(({ tipo_id, quantidade }) => {
    const existe = db.prepare('SELECT id FROM estoque WHERE data = ? AND tipo_id = ?').get(data, tipo_id);
    if (existe) {
      db.prepare('UPDATE estoque SET quantidade=?, usuario_id=? WHERE data=? AND tipo_id=?').run(quantidade, req.usuario.id, data, tipo_id);
    } else {
      db.prepare('INSERT INTO estoque (data, tipo_id, quantidade, usuario_id) VALUES (?,?,?,?)').run(data, tipo_id, quantidade, req.usuario.id);
    }
  });
  res.json({ sucesso: true });
});

module.exports = router;
