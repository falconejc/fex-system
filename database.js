const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'frango.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT UNIQUE NOT NULL,
    tipo TEXT NOT NULL,
    atendente TEXT NOT NULL,
    horario_compra DATETIME DEFAULT CURRENT_TIMESTAMP,
    horario_entrega DATETIME,
    status TEXT DEFAULT 'pendente'
  );

  CREATE TABLE IF NOT EXISTS delivery (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT UNIQUE NOT NULL,
    tipo TEXT NOT NULL,
    atendente TEXT NOT NULL,
    nome_cliente TEXT NOT NULL,
    endereco TEXT,
    numero TEXT,
    bairro TEXT,
    referencia TEXT,
    pagamento TEXT NOT NULL,
    descricao TEXT,
    horario_pedido DATETIME DEFAULT CURRENT_TIMESTAMP,
    horario_entrega DATETIME,
    status TEXT DEFAULT 'pendente'
  );
`);

module.exports = db;
