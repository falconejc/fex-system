const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirNivel } = require('../auth');

router.get('/', (req, res) => {
  const { categoria } = req.query;
  if (categoria && categoria !== 'todos') {
    return res.json(db.prepare('SELECT * FROM produtos WHERE ativo = 1 AND categoria = ? ORDER BY nome').all(categoria));
  }
  res.json(db.prepare('SELECT * FROM produtos WHERE ativo = 1 ORDER BY categoria, nome').all());
});

router.post('/', exigirNivel('admin', 'dono'), (req, res) => {
  const { nome, categoria, preco, unidade, emoji, imagem_url, descricao } = req.body;
  if (!nome || !categoria) return res.status(400).json({ erro: 'Nome e categoria são obrigatórios' });
  db.prepare('INSERT INTO produtos (nome, categoria, preco, unidade, emoji, imagem_url, descricao) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(nome, categoria, preco || 0, unidade || 'un', emoji || '📦', imagem_url || null, descricao || null);
  res.json({ sucesso: true });
});

router.put('/:id', exigirNivel('admin', 'dono'), (req, res) => {
  const { nome, categoria, preco, unidade, emoji, imagem_url, descricao, ativo } = req.body;
  const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(req.params.id);
  if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
  db.prepare('UPDATE produtos SET nome=?, categoria=?, preco=?, unidade=?, emoji=?, imagem_url=?, descricao=?, ativo=? WHERE id=?')
    .run(nome, categoria, preco || 0, unidade || 'un', emoji || '📦', imagem_url || null, descricao || null, ativo ?? 1, req.params.id);
  res.json({ sucesso: true });
});

router.delete('/:id', exigirNivel('admin', 'dono'), (req, res) => {
  db.prepare('DELETE FROM produtos WHERE id = ?').run(req.params.id);
  res.json({ sucesso: true });
});

module.exports = router;
