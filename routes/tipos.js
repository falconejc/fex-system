/**
 * @file tipos.js
 * @description Rotas para gerenciamento de tipos de frango.
 * Admin pode cadastrar novos tipos (ex: simples, bacon, catupiry)
 * com nome, descrição e preço.
 */

const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirNivel } = require('../auth');

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM tipos_frango WHERE ativo = 1 ORDER BY id').all());
});

router.get('/todos', exigirNivel('admin'), (req, res) => {
  res.json(db.prepare('SELECT * FROM tipos_frango ORDER BY id').all());
});

router.post('/', exigirNivel('admin'), (req, res) => {
  const { nome, descricao, preco, icone } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
  const existe = db.prepare('SELECT id FROM tipos_frango WHERE nome = ?').get(nome);
  if (existe) return res.status(400).json({ erro: 'Tipo já existe' });
  db.prepare('INSERT INTO tipos_frango (nome, descricao, preco, icone) VALUES (?, ?, ?, ?)').run(nome, descricao || '', preco || 0, icone || '🍗');
  res.json({ sucesso: true });
});

router.put('/:id', exigirNivel('admin'), (req, res) => {
  const { nome, descricao, preco, ativo, icone } = req.body;
  const tipo = db.prepare('SELECT * FROM tipos_frango WHERE id = ?').get(req.params.id);
  if (!tipo) return res.status(404).json({ erro: 'Tipo não encontrado' });
  db.prepare('UPDATE tipos_frango SET nome=?, descricao=?, preco=?, ativo=?, icone=? WHERE id=?').run(nome, descricao || '', preco || 0, ativo, icone || '🍗', req.params.id);
  res.json({ sucesso: true });
});

// Lista insumos vinculados a um tipo
router.get('/:id/insumos', (req, res) => {
  const vinculados = db.prepare(`
    SELECT ti.*, i.nome, i.unidade
    FROM tipo_insumos ti
    LEFT JOIN insumos i ON ti.insumo_id = i.id
    WHERE ti.tipo_id = ?
  `).all(req.params.id);
  res.json(vinculados);
});

// Vincula ou atualiza insumo em um tipo
router.post('/:id/insumos', exigirNivel('admin'), (req, res) => {
  const { insumo_id, quantidade } = req.body;
  if (!insumo_id || !quantidade) return res.status(400).json({ erro: 'Insumo e quantidade obrigatorios' });
  const existe = db.prepare('SELECT id FROM tipo_insumos WHERE tipo_id = ? AND insumo_id = ?').get(req.params.id, insumo_id);
  if (existe) {
    db.prepare('UPDATE tipo_insumos SET quantidade = ? WHERE tipo_id = ? AND insumo_id = ?').run(quantidade, req.params.id, insumo_id);
  } else {
    db.prepare('INSERT INTO tipo_insumos (tipo_id, insumo_id, quantidade) VALUES (?, ?, ?)').run(req.params.id, insumo_id, quantidade);
  }
  res.json({ sucesso: true });
});

// Remove vinculo de insumo de um tipo
router.delete('/:id/insumos/:insumo_id', exigirNivel('admin'), (req, res) => {
  db.prepare('DELETE FROM tipo_insumos WHERE tipo_id = ? AND insumo_id = ?').run(req.params.id, req.params.insumo_id);
  res.json({ sucesso: true });
});

module.exports = router;
