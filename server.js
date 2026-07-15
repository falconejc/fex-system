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

const TEST_BANNER = IS_TEST
  ? '<div style="position:fixed;bottom:0;left:0;right:0;background:#dc2626;color:white;text-align:center;padding:8px;font-size:13px;font-weight:bold;z-index:9999">⚠️ AMBIENTE DE TESTES — dados não são reais</div>'
  : '';

const CLOCK_SCRIPT = `<script>
(function(){
  function tick(){
    var d=new Date();
    var h=String(d.getHours()).padStart(2,'0');
    var m=String(d.getMinutes()).padStart(2,'0');
    var s=String(d.getSeconds()).padStart(2,'0');
    var el=document.getElementById('fex-clock');
    if(el) el.textContent=h+':'+m+':'+s;
  }
  function inserirRelogio(){
    var header=document.querySelector('header');
    if(!header||document.getElementById('fex-clock')) return;
    var clock=document.createElement('div');
    clock.id='fex-clock';
    clock.style.cssText='position:absolute;left:50%;transform:translateX(-50%);font-family:monospace;font-size:12px;font-weight:bold;letter-spacing:1px;background:rgba(0,0,0,0.18);padding:3px 8px;border-radius:5px;color:white;white-space:nowrap;pointer-events:none';
    if(window.getComputedStyle(header).position==='static') header.style.position='relative';
    header.appendChild(clock);
    tick();
    setInterval(tick,1000);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',inserirRelogio);
  else inserirRelogio();
})();
</script>`;

const CONEXAO_SCRIPT = `<script>
(function(){
  var offline = false;
  var banner = null;
  var fetchOriginal = window.fetch.bind(window);

  function criarBanner(){
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = 'fex-conexao-banner';
    banner.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;z-index:99999;text-align:center;padding:10px;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:white;transition:background-color 0.2s';
    document.body.appendChild(banner);
    return banner;
  }

  function mostrarOffline(){
    if (offline) return;
    offline = true;
    var b = criarBanner();
    b.textContent = '⚠️ Sem conexão com o servidor';
    b.style.background = '#dc2626';
    b.style.display = 'block';
  }

  function mostrarReconectado(){
    if (!offline) return;
    offline = false;
    var b = criarBanner();
    b.textContent = '✅ Reconectado!';
    b.style.background = '#10b981';
    b.style.display = 'block';
    setTimeout(function(){ if (!offline) b.style.display = 'none'; }, 3000);
  }

  window.fetch = function(){
    return fetchOriginal.apply(window, arguments).then(
      function(res){ mostrarReconectado(); return res; },
      function(err){ mostrarOffline(); throw err; }
    );
  };

  setInterval(function(){
    fetchOriginal('/api/env', { cache: 'no-store' }).then(mostrarReconectado).catch(mostrarOffline);
  }, 5000);
})();
</script>`;

const FULLSCREEN_SCRIPT = `<script>
(function(){
  function alternar(){
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(function(){});
    else document.exitFullscreen();
  }
  function inserirBotao(){
    var header = document.querySelector('header');
    if (!header || document.getElementById('fex-fullscreen-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'fex-fullscreen-btn';
    btn.title = 'Tela cheia';
    btn.textContent = '⛶';
    btn.style.cssText = 'width:38px;height:38px;min-width:38px;border-radius:8px;border:none;background:rgba(0,0,0,0.18);color:white;font-size:16px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;margin-left:8px';
    btn.onclick = alternar;

    // Se o header usa space-between, agrupa o botão com o último elemento
    // (geralmente "Sair") num wrapper flex pra não quebrar o layout existente
    if (header.children.length >= 1 && window.getComputedStyle(header).justifyContent === 'space-between') {
      var ultimo = header.lastElementChild;
      var wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:flex;align-items:center;gap:8px';
      ultimo.parentNode.insertBefore(wrapper, ultimo);
      wrapper.appendChild(ultimo);
      wrapper.appendChild(btn);
    } else {
      header.appendChild(btn);
    }

    document.addEventListener('fullscreenchange', function(){
      btn.textContent = document.fullscreenElement ? '🗗' : '⛶';
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',inserirBotao);
  else inserirBotao();
})();
</script>`;

const INJECT_HTML = TEST_BANNER + CLOCK_SCRIPT + CONEXAO_SCRIPT + FULLSCREEN_SCRIPT;

function injetarBanner(filePath) {
  let html = fs.readFileSync(filePath, 'utf8');
  const idx = html.lastIndexOf('</body>');
  if (idx === -1) return html;
  return html.slice(0, idx) + INJECT_HTML + html.slice(idx);
}

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.get('/api/env', (req, res) => res.json({ env: APP_ENV }));

// Injeta relógio (e banner de teste) em todas as páginas HTML
app.use((req, res, next) => {
  if (req.method !== 'GET' || !req.path.endsWith('.html')) return next();
  const filePath = path.join(__dirname, 'public', req.path);
  if (!fs.existsSync(filePath)) return next();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(injetarBanner(filePath));
});

app.get('/login.html', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'login.html');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(injetarBanner(filePath));
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
app.use('/api/precos',        verificarToken, require('./routes/precos'));

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
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(injetarBanner(filePath));
  } catch { res.redirect('/login.html'); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, '0.0.0.0', () => console.log(`Sistema rodando em http://0.0.0.0:${PORT} [${APP_ENV}]`));
