const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const db = new Database(path.join(__dirname, 'frango.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    usuario TEXT UNIQUE NOT NULL,
    senha TEXT NOT NULL,
    nivel TEXT NOT NULL DEFAULT 'operador',
    ativo INTEGER DEFAULT 1,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT UNIQUE NOT NULL,
    tipo TEXT NOT NULL,
    atendente TEXT NOT NULL,
    usuario_id INTEGER,
    observacao TEXT,
    horario_compra DATETIME DEFAULT CURRENT_TIMESTAMP,
    horario_entrega DATETIME,
    status TEXT DEFAULT 'pendente',
    cancelado INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS delivery (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT UNIQUE NOT NULL,
    tipo TEXT NOT NULL,
    atendente TEXT NOT NULL,
    usuario_id INTEGER,
    nome_cliente TEXT NOT NULL,
    endereco TEXT,
    numero TEXT,
    bairro TEXT,
    referencia TEXT,
    pagamento TEXT NOT NULL,
    descricao TEXT,
    horario_pedido DATETIME DEFAULT CURRENT_TIMESTAMP,
    horario_entrega DATETIME,
    status TEXT DEFAULT 'pendente',
    cancelado INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS estoque (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    simples_total INTEGER DEFAULT 0,
    bacon_total INTEGER DEFAULT 0,
    usuario_id INTEGER,
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  ALTER TABLE vendas ADD COLUMN observacao TEXT;
`).catch?.(() => {});

try { db.exec('ALTER TABLE vendas ADD COLUMN observacao TEXT;'); } catch(e) {}

const adminExiste = db.prepare("SELECT id FROM usuarios WHERE usuario = 'admin'").get();
if (!adminExiste) {
  const senha = bcrypt.hashSync('admin123', 10);
  db.prepare("INSERT INTO usuarios (nome, usuario, senha, nivel) VALUES (?, ?, ?, ?)").run('Administrador', 'admin', senha, 'admin');
  const senhaOp = bcrypt.hashSync('operador123', 10);
  db.prepare("INSERT INTO usuarios (nome, usuario, senha, nivel) VALUES (?, ?, ?, ?)").run('Operador', 'operador', senhaOp, 'operador');
  const senhaDono = bcrypt.hashSync('dono123', 10);
  db.prepare("INSERT INTO usuarios (nome, usuario, senha, nivel) VALUES (?, ?, ?, ?)").run('Dono', 'dono', senhaDono, 'dono');
}

module.exports = db;
