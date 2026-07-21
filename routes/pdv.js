/**
 * @file pdv.js
 * @description Rotas do PDV (Ponto de Venda) para vendas avulsas de produtos diversos.
 * Gerencia registro e cancelamento de vendas, abertura de caixa, relatórios diário/mensal
 * e cadastro simples de clientes fiado.
 */

const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirNivel } = require('../auth');

const FORMAS_PAGAMENTO = ['dinheiro', 'pix', 'cartao_credito', 'cartao_debito'];

function agora() {
  return new Date().toLocaleString('sv-SE', {timeZone:'America/Sao_Paulo'}).replace('T', ' ');
}

function hoje() {
  return new Date().toLocaleDateString('pt-BR', {timeZone:'America/Sao_Paulo'}).split('/').reverse().join('-');
}

function gerarCodigo() {
  return 'V' + Math.random().toString(36).substring(2, 7).toUpperCase();
}

router.post('/venda', (req, res) => {
  const { descricao, valor, forma_pagamento } = req.body;
  if (!descricao || !descricao.trim()) return res.status(400).json({ erro: 'Descrição obrigatória' });
  const valorNum = Number(valor);
  if (!valorNum || valorNum <= 0) return res.status(400).json({ erro: 'Valor inválido' });
  if (!FORMAS_PAGAMENTO.includes(forma_pagamento)) return res.status(400).json({ erro: 'Forma de pagamento inválida' });

  let codigo, tentativas = 0;
  do {
    codigo = gerarCodigo();
    if (++tentativas > 10) return res.status(500).json({ erro: 'Erro ao gerar código' });
  } while (db.prepare('SELECT id FROM pdv_vendas WHERE codigo = ?').get(codigo));

  db.prepare(`INSERT INTO pdv_vendas (codigo, descricao, valor, forma_pagamento, operador, usuario_id, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(codigo, descricao.trim(), valorNum, forma_pagamento, req.usuario.nome, req.usuario.id, agora());

  res.json(db.prepare('SELECT * FROM pdv_vendas WHERE codigo = ?').get(codigo));
});

router.get('/vendas', (req, res) => {
  const data = hoje();
  res.json(db.prepare('SELECT * FROM pdv_vendas WHERE date(criado_em) = ? ORDER BY criado_em DESC').all(data));
});

router.get('/relatorio/dia', (req, res) => {
  const data = req.query.data || hoje();
  const vendas = db.prepare('SELECT * FROM pdv_vendas WHERE date(criado_em) = ? ORDER BY criado_em DESC').all(data);
  const validas = vendas.filter(v => !v.cancelado);

  const gastos = db.prepare('SELECT * FROM pdv_gastos WHERE date(criado_em) = ? ORDER BY criado_em DESC').all(data);
  const gastosValidos = gastos.filter(g => !g.cancelado);
  const totalGastos = gastosValidos.reduce((s, g) => s + g.valor, 0);

  const porFormaPagamento = {};
  FORMAS_PAGAMENTO.forEach(f => { porFormaPagamento[f] = { quantidade: 0, total: 0 }; });
  validas.forEach(v => {
    porFormaPagamento[v.forma_pagamento].quantidade++;
    porFormaPagamento[v.forma_pagamento].total += v.valor;
  });

  const totalVendido = validas.reduce((s, v) => s + v.valor, 0);
  const caixa = db.prepare('SELECT * FROM pdv_caixa WHERE data = ?').get(data) || null;
  const saldoEsperadoCaixa = caixa ? caixa.valor_abertura + porFormaPagamento.dinheiro.total - totalGastos : null;

  res.json({
    data,
    resumo: {
      total_vendido: totalVendido,
      quantidade_vendas: validas.length,
      ticket_medio: validas.length ? totalVendido / validas.length : 0,
      por_forma_pagamento: porFormaPagamento,
      total_gastos: totalGastos,
      quantidade_gastos: gastosValidos.length,
      abertura_caixa: caixa,
      saldo_esperado_caixa: saldoEsperadoCaixa
    },
    vendas,
    gastos
  });
});

router.get('/relatorio/mes', (req, res) => {
  const mes = req.query.mes || hoje().substring(0, 7);
  const vendas = db.prepare("SELECT * FROM pdv_vendas WHERE strftime('%Y-%m', criado_em) = ? AND cancelado = 0 ORDER BY criado_em ASC").all(mes);

  const porDiaMap = {};
  vendas.forEach(v => {
    const dia = v.criado_em.split(' ')[0];
    if (!porDiaMap[dia]) porDiaMap[dia] = { data: dia, quantidade: 0, total: 0 };
    porDiaMap[dia].quantidade++;
    porDiaMap[dia].total += v.valor;
  });

  const totalMes = vendas.reduce((s, v) => s + v.valor, 0);
  const totalGastosMes = db.prepare("SELECT COALESCE(SUM(valor), 0) as total FROM pdv_gastos WHERE strftime('%Y-%m', criado_em) = ? AND cancelado = 0").get(mes).total;

  res.json({
    mes,
    resumo: { total_vendido: totalMes, quantidade_vendas: vendas.length, total_gastos: totalGastosMes },
    por_dia: Object.values(porDiaMap).sort((a, b) => a.data.localeCompare(b.data))
  });
});

router.get('/caixa', (req, res) => {
  const data = req.query.data || hoje();
  res.json(db.prepare('SELECT * FROM pdv_caixa WHERE data = ?').get(data) || null);
});

router.post('/caixa', (req, res) => {
  const valorNum = Number(req.body.valor_abertura);
  if (isNaN(valorNum) || valorNum < 0) return res.status(400).json({ erro: 'Valor inválido' });

  const data = hoje();
  const existente = db.prepare('SELECT * FROM pdv_caixa WHERE data = ?').get(data);
  if (existente && req.usuario.nivel !== 'admin') {
    return res.status(403).json({ erro: 'Caixa já foi aberto hoje. Apenas admin pode alterar.' });
  }

  if (existente) {
    db.prepare('UPDATE pdv_caixa SET valor_abertura = ?, operador = ?, usuario_id = ?, criado_em = ? WHERE data = ?')
      .run(valorNum, req.usuario.nome, req.usuario.id, agora(), data);
  } else {
    db.prepare('INSERT INTO pdv_caixa (data, valor_abertura, operador, usuario_id, criado_em) VALUES (?, ?, ?, ?, ?)')
      .run(data, valorNum, req.usuario.nome, req.usuario.id, agora());
  }

  res.json(db.prepare('SELECT * FROM pdv_caixa WHERE data = ?').get(data));
});

router.put('/venda/:id/cancelar', exigirNivel('admin', 'dono'), (req, res) => {
  const venda = db.prepare('SELECT * FROM pdv_vendas WHERE id = ?').get(req.params.id);
  if (!venda) return res.status(404).json({ erro: 'Venda não encontrada' });
  if (venda.cancelado) return res.status(400).json({ erro: 'Venda já cancelada' });
  db.prepare('UPDATE pdv_vendas SET cancelado = 1 WHERE id = ?').run(req.params.id);
  res.json({ sucesso: true });
});

router.post('/gasto', (req, res) => {
  const { descricao, valor } = req.body;
  if (!descricao || !descricao.trim()) return res.status(400).json({ erro: 'Descrição obrigatória' });
  const valorNum = Number(valor);
  if (!valorNum || valorNum <= 0) return res.status(400).json({ erro: 'Valor inválido' });

  const info = db.prepare(`INSERT INTO pdv_gastos (descricao, valor, operador, usuario_id, criado_em)
    VALUES (?, ?, ?, ?, ?)`)
    .run(descricao.trim(), valorNum, req.usuario.nome, req.usuario.id, agora());

  res.json(db.prepare('SELECT * FROM pdv_gastos WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/gastos', (req, res) => {
  const data = hoje();
  res.json(db.prepare('SELECT * FROM pdv_gastos WHERE date(criado_em) = ? ORDER BY criado_em DESC').all(data));
});

router.put('/gasto/:id/cancelar', exigirNivel('admin', 'dono'), (req, res) => {
  const gasto = db.prepare('SELECT * FROM pdv_gastos WHERE id = ?').get(req.params.id);
  if (!gasto) return res.status(404).json({ erro: 'Gasto não encontrado' });
  if (gasto.cancelado) return res.status(400).json({ erro: 'Gasto já cancelado' });
  db.prepare('UPDATE pdv_gastos SET cancelado = 1 WHERE id = ?').run(req.params.id);
  res.json({ sucesso: true });
});

router.get('/clientes', (req, res) => {
  res.json(db.prepare('SELECT * FROM pdv_clientes ORDER BY nome ASC').all());
});

router.post('/clientes', (req, res) => {
  const { nome, telefone } = req.body;
  if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
  const info = db.prepare('INSERT INTO pdv_clientes (nome, telefone) VALUES (?, ?)').run(nome.trim(), telefone || '');
  res.json(db.prepare('SELECT * FROM pdv_clientes WHERE id = ?').get(info.lastInsertRowid));
});

module.exports = router;
