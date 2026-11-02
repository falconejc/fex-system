/**
 * @file testServer.js
 * @description Sobe server.js como processo filho, com banco SQLite isolado e
 * descartável por teste, pra exercitar os fluxos de dinheiro ponta a ponta via HTTP.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');

async function startTestServer() {
  const port = 20000 + Math.floor(Math.random() * 10000);
  const dbFile = `.tmp-test-${crypto.randomBytes(6).toString('hex')}.db`;
  const dbPath = path.join(ROOT, dbFile);

  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      APP_ENV: 'test',
      DB_FILE: dbFile,
      JWT_SECRET: 'test-secret-nao-usar-em-producao'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let saida = '';
  proc.stdout.on('data', d => { saida += d; });
  proc.stderr.on('data', d => { saida += d; });

  const baseUrl = `http://localhost:${port}`;

  // Espera o servidor responder, em vez de confiar só na linha de log.
  const limite = Date.now() + 10000;
  while (Date.now() < limite) {
    try {
      const r = await fetch(`${baseUrl}/api/env`);
      if (r.ok) break;
    } catch {}
    if (proc.exitCode !== null) throw new Error('Servidor de teste caiu ao iniciar:\n' + saida);
    await new Promise(r => setTimeout(r, 100));
  }

  async function stop() {
    proc.kill();
    await new Promise(r => setTimeout(r, 100));
    for (const ext of ['', '-journal', '-wal', '-shm']) {
      fs.rmSync(dbPath + ext, { force: true });
    }
  }

  return { baseUrl, dbFile: dbPath, stop, getLog: () => saida };
}

function extrairCookie(res) {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('Login não retornou cookie');
  return setCookie.split(';')[0];
}

async function login(baseUrl, usuario, senha) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, senha })
  });
  if (!res.ok) throw new Error(`Login falhou para ${usuario}: ${await res.text()}`);
  return extrairCookie(res);
}

function api(baseUrl, cookie) {
  return (caminho, opts = {}) => fetch(`${baseUrl}${caminho}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      ...(opts.headers || {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
}

module.exports = { startTestServer, login, api };
