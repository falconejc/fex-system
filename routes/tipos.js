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
  const { nome, descricao, preco } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
  const existe = db.prepare('SELECT id FROM tipos_frango WHERE nome = ?').get(nome);
  if (existe) return res.status(400).json({ erro: 'Tipo já existe' });
  db.prepare('INSERT INTO tipos_frango (nome, descricao, preco) VALUES (?, ?, ?)').run(nome, descricao || '', preco || 0);
  res.json({ sucesso: true });
});

router.put('/:id', exigirNivel('admin'), (req, res) => {
  const { nome, descricao, preco, ativo } = req.body;
  const tipo = db.prepare('SELECT * FROM tipos_frango WHERE id = ?').get(req.params.id);
  if (!tipo) return res.status(404).json({ erro: 'Tipo não encontrado' });
  db.prepare('UPDATE tipos_frango SET nome=?, descricao=?, preco=?, ativo=? WHERE id=?').run(nome, descricao || '', preco || 0, ativo, req.params.id);
  res.json({ sucesso: true });
});

module.exports = router;
