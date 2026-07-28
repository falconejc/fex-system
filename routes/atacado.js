/**
 * @file atacado.js
 * @description Rotas para vendas no atacado com entregador.
 * Gerencia clientes, registro/cancelamento de vendas (à vista ou fiado)
 * e baixa de pagamento (fiado) por cliente.
 */

const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirNivel } = require('../auth');

const FORMAS_PAGAMENTO = ['dinheiro', 'pix', 'cartao_credito', 'cartao_debito', 'fiado'];

function agora() {
  return new Date().toLocaleString('sv-SE', {timeZone:'America/Sao_Paulo'}).replace('T', ' ');
}

function hoje() {
  return new Date().toLocaleDateString('pt-BR', {timeZone:'America/Sao_Paulo'}).split('/').reverse().join('-');
}

function gerarCodigo() {
  return 'A' + Math.random().toString(36).substring(2, 7).toUpperCase();
}

router.get('/clientes', (req, res) => {
  res.json(db.prepare('SELECT * FROM atacado_clientes ORDER BY nome ASC').all());
});

router.post('/clientes', (req, res) => {
  const { nome, telefone } = req.body;
  if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
  const info = db.prepare('INSERT INTO atacado_clientes (nome, telefone) VALUES (?, ?)').run(nome.trim(), telefone || '');
  res.json(db.prepare('SELECT * FROM atacado_clientes WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/clientes/:id/extrato', (req, res) => {
  const cliente = db.prepare('SELECT * FROM atacado_clientes WHERE id = ?').get(req.params.id);
  if (!cliente) return res.status(404).json({ erro: 'Cliente não encontrado' });
  const vendas = db.prepare("SELECT * FROM atacado_vendas WHERE cliente_id = ? AND forma_pagamento = 'fiado' AND cancelado = 0 ORDER BY criado_em DESC").all(req.params.id);
  const pagamentos = db.prepare('SELECT * FROM atacado_pagamentos WHERE cliente_id = ? ORDER BY criado_em DESC').all(req.params.id);
  res.json({ cliente, vendas, pagamentos });
});

router.post('/venda', (req, res) => {
  const { cliente_id, nome_cliente, descricao, peso, preco_kg, valor, forma_pagamento, entregador } = req.body;
  if (!descricao || !descricao.trim()) return res.status(400).json({ erro: 'Descrição obrigatória' });
  const valorNum = Number(valor);
  if (!valorNum || valorNum <= 0) return res.status(400).json({ erro: 'Valor inválido' });
  const pesoNum = Number(peso);
  if (!pesoNum || pesoNum <= 0) return res.status(400).json({ erro: 'Peso inválido' });
  const precoKgNum = Number(preco_kg);
  if (!precoKgNum || precoKgNum <= 0) return res.status(400).json({ erro: 'Preço por kg inválido' });
  if (!FORMAS_PAGAMENTO.includes(forma_pagamento)) return res.status(400).json({ erro: 'Forma de pagamento inválida' });
  if (!entregador || !entregador.trim()) return res.status(400).json({ erro: 'Entregador obrigatório' });
  if (!nome_cliente || !nome_cliente.trim()) return res.status(400).json({ erro: 'Nome do cliente obrigatório' });

  let cliente = null;
  if (cliente_id) {
    cliente = db.prepare('SELECT * FROM atacado_clientes WHERE id = ?').get(cliente_id);
    if (!cliente) return res.status(400).json({ erro: 'Cliente inválido' });
  }
  if (forma_pagamento === 'fiado' && !cliente) {
    return res.status(400).json({ erro: 'Venda a prazo exige cliente cadastrado' });
  }

  let codigo, tentativas = 0;
  do {
    codigo = gerarCodigo();
    if (++tentativas > 10) return res.status(500).json({ erro: 'Erro ao gerar código' });
  } while (db.prepare('SELECT id FROM atacado_vendas WHERE codigo = ?').get(codigo));

  db.prepare(`INSERT INTO atacado_vendas (codigo, cliente_id, nome_cliente, descricao, peso, preco_kg, valor, forma_pagamento, entregador, operador, usuario_id, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(codigo, cliente_id || null, nome_cliente.trim(), descricao.trim(), pesoNum, precoKgNum, valorNum, forma_pagamento, entregador.trim(), req.usuario.nome, req.usuario.id, agora());

  if (forma_pagamento === 'fiado') {
    db.prepare('UPDATE atacado_clientes SET saldo_fiado = saldo_fiado + ? WHERE id = ?').run(valorNum, cliente_id);
  }

  res.json(db.prepare('SELECT * FROM atacado_vendas WHERE codigo = ?').get(codigo));
});

router.get('/vendas', (req, res) => {
  const data = hoje();
  res.json(db.prepare('SELECT * FROM atacado_vendas WHERE date(criado_em) = ? ORDER BY criado_em DESC').all(data));
});

router.put('/venda/:id/cancelar', exigirNivel('admin', 'dono'), (req, res) => {
  const venda = db.prepare('SELECT * FROM atacado_vendas WHERE id = ?').get(req.params.id);
  if (!venda) return res.status(404).json({ erro: 'Venda não encontrada' });
  if (venda.cancelado) return res.status(400).json({ erro: 'Venda já cancelada' });
  db.prepare('UPDATE atacado_vendas SET cancelado = 1 WHERE id = ?').run(req.params.id);
  if (venda.forma_pagamento === 'fiado' && venda.cliente_id) {
    db.prepare('UPDATE atacado_clientes SET saldo_fiado = MAX(0, saldo_fiado - ?) WHERE id = ?').run(venda.valor, venda.cliente_id);
  }
  res.json({ sucesso: true });
});

router.post('/clientes/:id/pagamento', (req, res) => {
  const cliente = db.prepare('SELECT * FROM atacado_clientes WHERE id = ?').get(req.params.id);
  if (!cliente) return res.status(404).json({ erro: 'Cliente não encontrado' });
  const { valor, forma_pagamento } = req.body;
  const valorNum = Number(valor);
  if (!valorNum || valorNum <= 0) return res.status(400).json({ erro: 'Valor inválido' });
  if (!['dinheiro', 'pix', 'cartao_credito', 'cartao_debito'].includes(forma_pagamento)) {
    return res.status(400).json({ erro: 'Forma de pagamento inválida' });
  }
  if (valorNum > cliente.saldo_fiado) return res.status(400).json({ erro: 'Valor maior que o saldo devedor' });

  db.prepare('INSERT INTO atacado_pagamentos (cliente_id, valor, forma_pagamento, operador, usuario_id, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.params.id, valorNum, forma_pagamento, req.usuario.nome, req.usuario.id, agora());
  db.prepare('UPDATE atacado_clientes SET saldo_fiado = MAX(0, saldo_fiado - ?) WHERE id = ?').run(valorNum, req.params.id);

  res.json(db.prepare('SELECT * FROM atacado_clientes WHERE id = ?').get(req.params.id));
});

router.get('/relatorio/dia', (req, res) => {
  const data = req.query.data || hoje();
  const vendas = db.prepare('SELECT * FROM atacado_vendas WHERE date(criado_em) = ? ORDER BY criado_em DESC').all(data);
  const validas = vendas.filter(v => !v.cancelado);

  const porFormaPagamento = {};
  FORMAS_PAGAMENTO.forEach(f => { porFormaPagamento[f] = { quantidade: 0, total: 0 }; });
  validas.forEach(v => {
    porFormaPagamento[v.forma_pagamento].quantidade++;
    porFormaPagamento[v.forma_pagamento].total += v.valor;
  });

  const totalVendido = validas.reduce((s, v) => s + v.valor, 0);
  const totalFiado = porFormaPagamento.fiado.total;

  const pagamentos = db.prepare("SELECT * FROM atacado_pagamentos WHERE date(criado_em) = ? ORDER BY criado_em DESC").all(data);
  const totalRecebidoFiado = pagamentos.reduce((s, p) => s + p.valor, 0);

  const totalAReceber = db.prepare('SELECT COALESCE(SUM(saldo_fiado), 0) as total FROM atacado_clientes').get().total;

  res.json({
    data,
    resumo: {
      total_vendido: totalVendido,
      quantidade_vendas: validas.length,
      total_fiado_gerado: totalFiado,
      total_recebido_pagamentos: totalRecebidoFiado,
      total_a_receber: totalAReceber,
      por_forma_pagamento: porFormaPagamento
    },
    vendas,
    pagamentos
  });
});

module.exports = router;
