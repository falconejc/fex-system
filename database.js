/**
 * @file database.js
 * @description Configuração e inicialização do banco de dados SQLite.
 * Cria as tabelas necessárias se não existirem e insere
 * usuários padrão na primeira execução.
 */

const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbFile = process.env.DB_FILE || 'frango.db';
const db = new Database(path.join(__dirname, dbFile));

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
    tipo_id INTEGER DEFAULT 1,
    atendente TEXT NOT NULL,
    usuario_id INTEGER,
    observacao TEXT,
    telefone TEXT,
    horario_compra DATETIME DEFAULT CURRENT_TIMESTAMP,
    horario_entrega DATETIME,
    status TEXT DEFAULT 'pendente',
    cancelado INTEGER DEFAULT 0,
    ordem_tipo INTEGER DEFAULT 0
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
    tipo_id INTEGER DEFAULT 1,
    quantidade INTEGER DEFAULT 0,
    usuario_id INTEGER,
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS lotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quantidade INTEGER NOT NULL,
    tipo_id INTEGER DEFAULT 1,
    horario_entrada TEXT NOT NULL,
    horario_previsto TEXT NOT NULL,
    status TEXT DEFAULT 'assando',
    usuario_id INTEGER,
    observacao TEXT
  );

  CREATE TABLE IF NOT EXISTS tipos_frango (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    descricao TEXT,
    preco REAL DEFAULT 0,
    icone TEXT DEFAULT '🍗',
    ativo INTEGER DEFAULT 1,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS insumos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    unidade TEXT NOT NULL DEFAULT 'un',
    quantidade_atual REAL DEFAULT 0,
    quantidade_minima REAL DEFAULT 0,
    descricao TEXT,
    ativo INTEGER DEFAULT 1,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS movimentacoes_insumos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    insumo_id INTEGER NOT NULL,
    tipo TEXT NOT NULL,
    quantidade REAL NOT NULL,
    observacao TEXT,
    usuario_id INTEGER,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS historico_estoque (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    tipo_id INTEGER NOT NULL,
    quantidade_inicial INTEGER DEFAULT 0,
    quantidade_vendida INTEGER DEFAULT 0,
    quantidade_sobra INTEGER DEFAULT 0,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS frangos_crus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    tipo_id INTEGER NOT NULL,
    quantidade INTEGER NOT NULL,
    observacao TEXT,
    usuario_id INTEGER,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tipo_insumos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo_id INTEGER NOT NULL,
    insumo_id INTEGER NOT NULL,
    quantidade REAL NOT NULL DEFAULT 1,
    UNIQUE(tipo_id, insumo_id)
  );

  CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    categoria TEXT NOT NULL,
    preco REAL DEFAULT 0,
    unidade TEXT DEFAULT 'un',
    emoji TEXT DEFAULT '📦',
    imagem_url TEXT,
    descricao TEXT,
    ativo INTEGER DEFAULT 1,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrations: adiciona colunas que podem não existir em bancos antigos
const migrations = [
  "ALTER TABLE vendas ADD COLUMN telefone TEXT",
  "ALTER TABLE vendas ADD COLUMN ordem_tipo INTEGER DEFAULT 0",
  "ALTER TABLE tipos_frango ADD COLUMN icone TEXT DEFAULT '🍗'",
];
migrations.forEach(sql => { try { db.exec(sql); } catch(e) {} });

const produtosExistem = db.prepare('SELECT id FROM produtos LIMIT 1').get();
if (!produtosExistem) {
  const ins = db.prepare('INSERT INTO produtos (nome, categoria, preco, unidade, emoji) VALUES (?, ?, ?, ?, ?)');
  // Cortes de Frango
  ins.run('Frango Inteiro', 'cortes', 0, 'un', '🍗');
  ins.run('Meio Frango', 'cortes', 0, 'un', '🍗');
  ins.run('Coxa e Sobrecoxa', 'cortes', 0, 'un', '🍗');
  ins.run('Coxa', 'cortes', 0, 'un', '🍗');
  ins.run('Sobrecoxa', 'cortes', 0, 'un', '🍗');
  ins.run('Asa', 'cortes', 0, 'un', '🍗');
  ins.run('Pé de Frango', 'cortes', 0, 'pct', '🦴');
  ins.run('Pescoço', 'cortes', 0, 'kg', '🍗');
  ins.run('Fígado', 'cortes', 0, 'kg', '🫀');
  // Bebidas
  ins.run('Água 500ml', 'bebidas', 0, 'un', '💧');
  ins.run('Água 1,5L', 'bebidas', 0, 'un', '💧');
  ins.run('Refrigerante Lata', 'bebidas', 0, 'un', '🥤');
  ins.run('Refrigerante 2L', 'bebidas', 0, 'un', '🥤');
  ins.run('Suco de Laranja', 'bebidas', 0, 'un', '🧃');
  ins.run('Suco de Caju', 'bebidas', 0, 'un', '🧃');
  ins.run('Leite', 'bebidas', 0, 'un', '🥛');
  ins.run('Café', 'bebidas', 0, 'un', '☕');
  ins.run('Cerveja Lata', 'bebidas', 0, 'un', '🍺');
  // Mercearia
  ins.run('Arroz 5kg', 'mercearia', 0, 'pct', '🍚');
  ins.run('Feijão 1kg', 'mercearia', 0, 'pct', '🫘');
  ins.run('Óleo 900ml', 'mercearia', 0, 'un', '🛢️');
  ins.run('Sal 1kg', 'mercearia', 0, 'pct', '🧂');
  ins.run('Açúcar 1kg', 'mercearia', 0, 'pct', '🍬');
  ins.run('Macarrão 500g', 'mercearia', 0, 'pct', '🍝');
  ins.run('Farinha de Trigo 1kg', 'mercearia', 0, 'pct', '🌾');
  ins.run('Vinagrete', 'mercearia', 0, 'un', '🫙');
  // Comida
  ins.run('Marmita P', 'comida', 0, 'un', '🍱');
  ins.run('Marmita M', 'comida', 0, 'un', '🍱');
  ins.run('Marmita G', 'comida', 0, 'un', '🍱');
  ins.run('Prato Feito', 'comida', 0, 'un', '🍽️');
  ins.run('Porção de Frango', 'comida', 0, 'un', '🍗');
}

const adminExiste = db.prepare("SELECT id FROM usuarios WHERE usuario = 'admin'").get();
if (!adminExiste) {
  db.prepare("INSERT INTO usuarios (nome, usuario, senha, nivel) VALUES (?, ?, ?, ?)").run('Administrador', 'admin', bcrypt.hashSync('admin123', 10), 'admin');
  db.prepare("INSERT INTO usuarios (nome, usuario, senha, nivel) VALUES (?, ?, ?, ?)").run('Caixa', 'caixa', bcrypt.hashSync('caixa123', 10), 'caixa');
  db.prepare("INSERT INTO usuarios (nome, usuario, senha, nivel) VALUES (?, ?, ?, ?)").run('Assador', 'assador', bcrypt.hashSync('assador123', 10), 'assador');
  db.prepare("INSERT INTO usuarios (nome, usuario, senha, nivel) VALUES (?, ?, ?, ?)").run('Dono', 'dono', bcrypt.hashSync('dono123', 10), 'dono');
}

module.exports = db;
