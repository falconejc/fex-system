/**
 * @file server.js
 * @description Ponto de entrada da aplicação Fex System.
 * Configura o servidor Express com middlewares, rotas da API
 * e serve os arquivos estáticos do frontend.
 * Porta padrão: 3000
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const db = require('./database');
const { gerarToken, verificarToken, SECRET } = require('./auth');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/api/auth/login', (req, res) => {
  const { usuario, senha } = req.body;
  const user = db.prepare('SELECT * FROM usuarios WHERE usuario = ? AND ativo = 1').get(usuario);
  if (!user || !bcrypt.compareSync(senha, user.senha)) return res.status(401).json({ erro: 'Usuário ou senha inválidos' });
  const token = gerarToken(user);
  res.cookie('token', token, { httpOnly: true, maxAge: 12 * 60 * 60 * 1000, sameSite: 'lax', path: '/' });
  res.json({ sucesso: true, nivel: user.nivel, nome: user.nome });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token', { path: '/' });
  res.json({ sucesso: true });
});

app.get('/api/auth/me', verificarToken, (req, res) => res.json(req.usuario));

app.use('/api/frango',   verificarToken, require('./routes/frango'));
app.use('/api/delivery', verificarToken, require('./routes/delivery'));
app.use('/api/relatorio',verificarToken, require('./routes/relatorio'));
app.use('/api/usuarios', verificarToken, require('./routes/usuarios'));
app.use('/api/exportar', verificarToken, require('./routes/exportar'));
app.use('/api/estoque',  verificarToken, require('./routes/estoque'));
app.use('/api/lotes',    verificarToken, require('./routes/lotes'));
app.use('/api/whatsapp', verificarToken, require('./routes/whatsapp'));
app.use('/api/tipos',    verificarToken, require('./routes/tipos'));
app.use('/api/estoque_modulo', verificarToken, require('./routes/estoque_modulo'));

app.get('/', (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.redirect('/login.html');
  try { jwt.verify(token, SECRET); res.sendFile(path.join(__dirname, 'public', 'index.html')); }
  catch { res.redirect('/login.html'); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(3000, '0.0.0.0', () => console.log('Sistema rodando em http://0.0.0.0:3000'));
