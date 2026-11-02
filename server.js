/**
 * @file server.js
 * @description Ponto de entrada da aplicação Fex System.
 * Configura o servidor Express com middlewares, rotas da API
 * e serve os arquivos estáticos do frontend.
 *
 * Variáveis de ambiente:
 *   PORT       — porta do servidor (padrão: 3000)
 *   APP_ENV    — ambiente: 'production' ou 'test' (padrão: 'production')
 *   JWT_SECRET — segredo de assinatura dos tokens (obrigatório, ver .env)
 */

require('dotenv').config();
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

// Slot compartilhado no header pra agrupar relógio, botão de tela cheia etc.
// sem sobrepor o título nem quebrar o layout justify-content:space-between
const HEADER_SLOT_SCRIPT = `<script>
window.__fexHeaderSlot = function(){
  var header = document.querySelector('header');
  if (!header) return null;
  var slot = document.getElementById('fex-header-actions');
  if (slot) return slot;
  slot = document.createElement('div');
  slot.id = 'fex-header-actions';
  slot.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0';
  if (window.getComputedStyle(header).justifyContent === 'space-between') {
    var fluxo = Array.prototype.filter.call(header.children, function(el){
      return window.getComputedStyle(el).position !== 'absolute';
    });
    var ultimo = fluxo[fluxo.length - 1];
    if (ultimo) {
      ultimo.parentNode.insertBefore(slot, ultimo);
      slot.appendChild(ultimo);
    } else {
      header.appendChild(slot);
    }
  } else {
    header.appendChild(slot);
  }
  return slot;
};
</script>`;

// Mostra quem está logado (nome + nível) no header, de forma consistente em toda
// página pós-login — antes só index.html mostrava isso, o resto só usava o nível
// internamente (ex. pra desabilitar botão) sem exibir nada pro usuário.
// Escondido em telas bem estreitas (maquininha/celular) pra não disputar espaço
// com relógio/botão de tela cheia/badge de fichas atrasadas.
const USUARIO_LOGADO_SCRIPT = `<style>
  @media (max-width: 480px) { #fex-usuario-logado { display: none !important; } }
</style>
<script>
(function(){
  var path = window.location.pathname;
  if (path === '/login.html' || path === '/teste-qr.html' || path === '/' || path === '/index.html') return;
  var NIVEIS = { admin: 'Admin', dono: 'Dono', caixa: 'Caixa', assador: 'Assador' };
  fetch('/api/auth/me')
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(user){
      if (!user) return;
      var slot = window.__fexHeaderSlot && window.__fexHeaderSlot();
      if (!slot || document.getElementById('fex-usuario-logado')) return;
      var label = document.createElement('div');
      label.id = 'fex-usuario-logado';
      label.style.cssText = 'font-size:12px;color:white;opacity:0.9;white-space:nowrap;line-height:1.2;text-align:right';
      label.textContent = user.nome + ' · ' + (NIVEIS[user.nivel] || user.nivel);
      slot.insertBefore(label, slot.firstChild);
    })
    .catch(function(){});
})();
</script>`;

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
    if(document.getElementById('fex-clock')) return;
    var slot = window.__fexHeaderSlot && window.__fexHeaderSlot();
    if(!slot) return;
    var clock=document.createElement('div');
    clock.id='fex-clock';
    clock.style.cssText='font-family:monospace;font-size:12px;font-weight:bold;letter-spacing:1px;background:rgba(0,0,0,0.18);padding:3px 8px;border-radius:5px;color:white;white-space:nowrap';
    slot.appendChild(clock);
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
    if (document.getElementById('fex-fullscreen-btn')) return;
    var slot = window.__fexHeaderSlot && window.__fexHeaderSlot();
    if (!slot) return;
    var btn = document.createElement('button');
    btn.id = 'fex-fullscreen-btn';
    btn.title = 'Tela cheia';
    btn.textContent = '⛶';
    btn.style.cssText = 'width:36px;height:36px;min-width:36px;border-radius:8px;border:none;background:rgba(0,0,0,0.18);color:white;font-size:16px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0';
    btn.onclick = alternar;
    slot.appendChild(btn);
    document.addEventListener('fullscreenchange', function(){
      btn.textContent = document.fullscreenElement ? '🗗' : '⛶';
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',inserirBotao);
  else inserirBotao();
})();
</script>`;

// Alerta de fichas de frango vendidas e não baixadas até o dia seguinte.
// Roda em toda página pós-login (exceto login/teste-qr); checa uma vez ao carregar.
// Pra não cansar quem navega entre várias telas no mesmo turno, o modal bloqueante
// só aparece uma vez por sessão de login — nas próximas checagens vira um badge
// discreto no header, que reabre o modal completo se clicado.
const ALERTAS_FICHAS_SCRIPT = `<script>
(function(){
  var path = window.location.pathname;
  if (path === '/login.html' || path === '/teste-qr.html') return;

  var FLAG_SESSAO = 'fexFichasAtrasadasModalMostrado';

  function formatarHorario(dt){
    if (!dt) return '';
    var partes = dt.split(' ');
    return partes.length > 1 ? partes[1].slice(0,5) + ' (' + partes[0].split('-').reverse().join('/') + ')' : dt;
  }

  function removerBadge(){
    var badge = document.getElementById('fex-fichas-badge');
    if (badge) badge.remove();
  }

  function montarBadge(quantidade){
    var badge = document.getElementById('fex-fichas-badge');
    if (!badge) {
      var slot = window.__fexHeaderSlot && window.__fexHeaderSlot();
      if (!slot) return;
      badge = document.createElement('button');
      badge.id = 'fex-fichas-badge';
      badge.title = 'Fichas de frango sem baixa de dias anteriores';
      badge.style.cssText = 'background:#dc2626;color:white;border:none;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:bold;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:4px';
      badge.onclick = function(){ checar(true); };
      slot.appendChild(badge);
    }
    badge.textContent = '⚠️ ' + quantidade + (quantidade === 1 ? ' ficha atrasada' : ' fichas atrasadas');
  }

  function montarModal(fichas){
    if (document.getElementById('fex-alerta-fichas')) return;
    try { sessionStorage.setItem(FLAG_SESSAO, '1'); } catch(e) {}
    removerBadge();
    var overlay = document.createElement('div');
    overlay.id = 'fex-alerta-fichas';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:999999;display:flex;align-items:center;justify-content:center;padding:16px;font-family:Arial,sans-serif';

    var box = document.createElement('div');
    box.style.cssText = 'background:white;border-radius:12px;max-width:480px;width:100%;max-height:80vh;overflow:auto;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,0.3)';

    var titulo = document.createElement('div');
    titulo.style.cssText = 'font-size:17px;font-weight:bold;color:#dc2626;margin-bottom:6px';
    titulo.textContent = '⚠️ Fichas sem baixa de dias anteriores';
    box.appendChild(titulo);

    var sub = document.createElement('div');
    sub.style.cssText = 'font-size:13px;color:#555;margin-bottom:14px';
    sub.textContent = 'Essas fichas de frango ficaram pendentes e não foram baixadas no dia da venda. Confira se o frango foi retirado e dê baixa.';
    box.appendChild(sub);

    var lista = document.createElement('div');
    lista.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    box.appendChild(lista);

    function renderLista(){
      lista.innerHTML = '';
      fichas.forEach(function(f){
        var item = document.createElement('div');
        item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid #eee;border-radius:8px;padding:8px 10px';
        var info = document.createElement('div');
        info.innerHTML = '<div style="font-weight:bold">' + (f.tipo_icone || '') + ' ' + f.tipo_nome + ' <span style="color:#888;font-weight:normal">#' + f.codigo + '</span></div>' +
          '<div style="font-size:12px;color:#777">' + formatarHorario(f.horario_compra) + ' · ' + (f.atendente || '') + '</div>';
        item.appendChild(info);
        var btn = document.createElement('button');
        btn.textContent = 'Dar baixa';
        btn.style.cssText = 'background:#10b981;color:white;border:none;border-radius:6px;padding:7px 12px;font-size:13px;font-weight:bold;cursor:pointer;white-space:nowrap';
        btn.onclick = function(){
          btn.disabled = true;
          btn.textContent = '...';
          fetch('/api/frango/entrega/' + f.codigo, { method: 'POST' })
            .then(function(r){ return r.json(); })
            .then(function(j){
              if (j.erro) { alert(j.erro); btn.disabled = false; btn.textContent = 'Dar baixa'; return; }
              fichas = fichas.filter(function(x){ return x.codigo !== f.codigo; });
              if (fichas.length === 0) { overlay.remove(); removerBadge(); return; }
              renderLista();
            })
            .catch(function(){ btn.disabled = false; btn.textContent = 'Dar baixa'; });
        };
        item.appendChild(btn);
        lista.appendChild(item);
      });
    }
    renderLista();

    var fechar = document.createElement('button');
    fechar.textContent = 'Fechar';
    fechar.style.cssText = 'margin-top:16px;width:100%;background:#eee;color:#333;border:none;border-radius:8px;padding:10px;font-size:13px;cursor:pointer';
    fechar.onclick = function(){
      overlay.remove();
      if (fichas.length > 0) montarBadge(fichas.length);
    };
    box.appendChild(fechar);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  function checar(forcarModal){
    fetch('/api/frango/pendentes-atrasadas', { cache: 'no-store' })
      .then(function(r){ if (!r.ok) throw 0; return r.json(); })
      .then(function(fichas){
        if (!fichas || !fichas.length) { removerBadge(); return; }
        var jaMostrouNaSessao = false;
        try { jaMostrouNaSessao = sessionStorage.getItem(FLAG_SESSAO) === '1'; } catch(e) {}
        if (forcarModal || !jaMostrouNaSessao) montarModal(fichas);
        else montarBadge(fichas.length);
      })
      .catch(function(){});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checar);
  else checar();
})();
</script>`;

const INJECT_HTML = TEST_BANNER + HEADER_SLOT_SCRIPT + USUARIO_LOGADO_SCRIPT + CLOCK_SCRIPT + CONEXAO_SCRIPT + FULLSCREEN_SCRIPT + ALERTAS_FICHAS_SCRIPT;

function injetarBanner(filePath) {
  let html = fs.readFileSync(filePath, 'utf8');
  const idx = html.lastIndexOf('</body>');
  if (idx === -1) return html;
  return html.slice(0, idx) + INJECT_HTML + html.slice(idx);
}

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '8mb' })); // acomoda a foto do comprovante de gasto (base64)
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
app.use('/api/pdv',           verificarToken, require('./routes/pdv'));
app.use('/api/atacado',       verificarToken, require('./routes/atacado'));

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
