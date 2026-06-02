/**
 * @file server.js
 * @description Ponto de entrada da aplicação Fex System.
 * Configura o servidor Express com middlewares, rotas da API
 * e serve os arquivos estáticos do frontend.
 *
 * Variáveis de ambiente:
 *   PORT     — porta do servidor (padrão: 3000)
 *   APP_ENV  — ambiente: 'production' ou 'test' (padrão: 'production')
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const db = require('./database');
const { gerarToken, verificarToken, SECRET } = require('./auth');
const { clients } = require('./events');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 3000;
const APP_ENV = process.env.APP_ENV || 'production';
const IS_TEST = APP_ENV === 'test';

const BANNER_HTML = IS_TEST
  ? '<div style="position:fixed;bottom:0;left:0;right:0;background:#dc2626;color:white;text-align:center;padding:8px;font-size:13px;font-weight:bold;z-index:9999">⚠️ AMBIENTE DE TESTES — dados não são reais</div>'
  : '';

function injetarBanner(filePath) {
  let html = fs.readFileSync(filePath, 'utf8');
  return html.replace('</body>', BANNER_HTML + '</body>');
}

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.get('/api/env', (req, res) => res.json({ env: APP_ENV }));

// Em modo teste, injeta o banner em todas as páginas HTML
if (IS_TEST) {
  app.use((req, res, next) => {
    if (req.method !== 'GET' || !req.path.endsWith('.html')) return next();
    const filePath = path.join(__dirname, 'public', req.path);
    if (!fs.existsSync(filePath)) return next();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(injetarBanner(filePath));
  });
}

app.get('/login.html', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'login.html');
  if (IS_TEST) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.send(injetarBanner(filePath)); }
  res.sendFile(filePath);
});

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

app.use('/api/frango',        verificarToken, require('./routes/frango'));
app.use('/api/delivery',      verificarToken, require('./routes/delivery'));
app.use('/api/relatorio',     verificarToken, require('./routes/relatorio'));
app.use('/api/usuarios',      verificarToken, require('./routes/usuarios'));
app.use('/api/exportar',      verificarToken, require('./routes/exportar'));
app.use('/api/estoque',       verificarToken, require('./routes/estoque'));
app.use('/api/lotes',         verificarToken, require('./routes/lotes'));
app.use('/api/whatsapp',      verificarToken, require('./routes/whatsapp'));
app.use('/api/tipos',         verificarToken, require('./routes/tipos'));
app.use('/api/estoque_modulo',verificarToken, require('./routes/estoque_modulo'));

app.get('/api/eventos', verificarToken, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('data: conectado\n\n');
  clients.add(res);
  const keepalive = setInterval(() => { try { res.write(':\n\n'); } catch(e) {} }, 25000);
  req.on('close', () => { clients.delete(res); clearInterval(keepalive); });
});

app.get('/', (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.redirect('/login.html');
  try {
    jwt.verify(token, SECRET);
    const filePath = path.join(__dirname, 'public', 'index.html');
    if (IS_TEST) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.send(injetarBanner(filePath)); }
    res.sendFile(filePath);
  } catch { res.redirect('/login.html'); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, '0.0.0.0', () => console.log(`Sistema rodando em http://0.0.0.0:${PORT} [${APP_ENV}]`));
