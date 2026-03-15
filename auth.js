/**
 * @file auth.js
 * @description Módulo de autenticação JWT.
 * Gera tokens de acesso, middleware de verificação
 * e middleware de controle de nível de acesso por perfil.
 */

const jwt = require('jsonwebtoken');
const SECRET = 'fex-system-secret-2024';

function gerarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, nome: usuario.nome, nivel: usuario.nivel },
    SECRET,
    { expiresIn: '12h' }
  );
}

function verificarToken(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.redirect('/login.html');
  try {
    req.usuario = jwt.verify(token, SECRET);
    next();
  } catch {
    res.redirect('/login.html');
  }
}

function exigirNivel(...niveis) {
  return (req, res, next) => {
    if (!niveis.includes(req.usuario.nivel)) {
      return res.status(403).json({ erro: 'Acesso negado' });
    }
    next();
  };
}

module.exports = { gerarToken, verificarToken, exigirNivel, SECRET };
