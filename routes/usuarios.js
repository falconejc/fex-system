/**
 * @file usuarios.js
 * @description Rotas para gerenciamento de usuários.
 * Permite ao admin criar, editar, ativar/desativar e excluir usuários.
 * Níveis: admin, caixa, assador, dono.
 */

const express = require('express');
const router = express.Router();
const db = require('../database');
const bcrypt = require('bcryptjs');
const { exigirNivel } = require('../auth');

router.get('/', exigirNivel('admin'), (req, res) => {
  const usuarios = db.prepare('SELECT id, nome, usuario, nivel, ativo, criado_em FROM usuarios').all();
  res.json(usuarios);
});

router.post('/', exigirNivel('admin'), (req, res) => {
  const { nome, usuario, senha, nivel } = req.body;
  if (!nome || !usuario || !senha || !nivel) return res.status(400).json({ erro: 'Campos obrigatórios' });
  const existe = db.prepare('SELECT id FROM usuarios WHERE usuario = ?').get(usuario);
  if (existe) return res.status(400).json({ erro: 'Usuário já existe' });
  const hash = bcrypt.hashSync(senha, 10);
  db.prepare('INSERT INTO usuarios (nome, usuario, senha, nivel) VALUES (?, ?, ?, ?)').run(nome, usuario, hash, nivel);
  res.json({ sucesso: true });
});

router.put('/:id', exigirNivel('admin'), (req, res) => {
  const { nome, nivel, ativo, senha } = req.body;
  const user = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ erro: 'Usuário não encontrado' });
  if (senha) {
    const hash = bcrypt.hashSync(senha, 10);
    db.prepare('UPDATE usuarios SET nome=?, nivel=?, ativo=?, senha=? WHERE id=?').run(nome, nivel, ativo, hash, req.params.id);
  } else {
    db.prepare('UPDATE usuarios SET nome=?, nivel=?, ativo=? WHERE id=?').run(nome, nivel, ativo, req.params.id);
  }
  res.json({ sucesso: true });
});

router.delete('/:id', exigirNivel('admin'), (req, res) => {
  const user = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ erro: 'Usuário não encontrado' });
  if (user.usuario === 'admin') return res.status(400).json({ erro: 'Não é possível remover o admin principal' });
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(req.params.id);
  res.json({ sucesso: true });
});

module.exports = router;
