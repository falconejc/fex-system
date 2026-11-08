/**
 * @file delivery.js
 * @description Rotas para pedidos de delivery.
 * Pedidos têm carrinho de itens (produtos do catálogo e/ou frango assado) e um
 * pagamento único, espelhados em pdv_vendas (agrupados por referencia_pagamento
 * = código do pedido) pra contar no caixa do PDV igual a qualquer outra venda.
 * Gerencia registro, Kanban de status, reimpressão e cancelamento (cascateando
 * pros registros financeiros espelhados).
 */

const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirNivel } = require('../auth');
const { broadcast } = require('../events');
const { registrarVendaFrango } = require('./frango');

const FORMAS_PAGAMENTO = ['dinheiro', 'pix', 'cartao_credito', 'cartao_debito'];
const STATUS_VALIDOS = ['pendente', 'preparando', 'saiu_entrega', 'entregue'];

function agora() {
  return new Date().toLocaleString('sv-SE', {timeZone:'America/Sao_Paulo'}).replace('T', ' ');
}

function hoje() {
  return new Date().toLocaleDateString('pt-BR', {timeZone:'America/Sao_Paulo'}).split('/').reverse().join('-');
}

function gerarCodigo() {
  return 'D' + Math.random().toString(36).substring(2, 7).toUpperCase();
}

function gerarCodigoItem() {
  return 'V' + Math.random().toString(36).substring(2, 7).toUpperCase();
}

// Valida vínculo de um item do carrinho com o catálogo de produtos (mesma lógica
// de routes/pdv.js) — usado pros relatórios de kg/quantidade vendidos.
function extrairVinculoProduto(item) {
  const { produto_id, unidade, quantidade } = item;
  if (!produto_id) return { produto_id: null, unidade: null, quantidade: null };
  const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(produto_id);
  if (!produto) throw new Error('Produto inválido');
  const unidadeFinal = unidade === 'kg' ? 'kg' : 'un';
  const quantidadeNum = Number(quantidade);
  if (!quantidadeNum || quantidadeNum <= 0) throw new Error('Quantidade/peso inválido para o produto');
  return { produto_id: produto.id, unidade: unidadeFinal, quantidade: quantidadeNum };
}

router.post('/pedido', (req, res) => {
  const { tipo, atendente, nome_cliente, endereco, numero, bairro, referencia, pagamento, observacao } = req.body;
  const listaItens = Array.isArray(req.body.itens) ? req.body.itens : [];
  const listaFrangos = Array.isArray(req.body.frango_tipo_ids) ? req.body.frango_tipo_ids : [];

  if (!tipo || !atendente || !nome_cliente) return res.status(400).json({ erro: 'Campos obrigatórios' });
  if (!FORMAS_PAGAMENTO.includes(pagamento)) return res.status(400).json({ erro: 'Forma de pagamento inválida' });
  if (!listaItens.length && !listaFrangos.length) return res.status(400).json({ erro: 'Nenhum item no pedido' });

  const vinculosItens = [];
  for (const it of listaItens) {
    if (!it.descricao || !String(it.descricao).trim()) return res.status(400).json({ erro: 'Descrição do item obrigatória' });
    if (!(Number(it.valor) > 0)) return res.status(400).json({ erro: 'Valor do item inválido' });
    try {
      vinculosItens.push(extrairVinculoProduto(it));
    } catch (e) {
      return res.status(400).json({ erro: e.message });
    }
  }

  const tiposFrango = listaFrangos.map(id => db.prepare('SELECT * FROM tipos_frango WHERE id = ? AND ativo = 1').get(id));
  if (tiposFrango.some(t => !t)) return res.status(400).json({ erro: 'Tipo de frango inválido' });

  const totalItens = listaItens.reduce((s, it) => s + Number(it.valor), 0);
  const totalFrangos = tiposFrango.reduce((s, t) => s + t.preco, 0);
  const valorTotal = totalItens + totalFrangos;

  const resumoItens = [...listaItens.map(it => String(it.descricao).trim()), ...tiposFrango.map(t => t.nome)].join(', ');
  const descricao = observacao && observacao.trim() ? `${resumoItens} — ${observacao.trim()}` : resumoItens;

  const usuario_id = req.usuario.id;

  let codigo, tentativas = 0;
  do {
    codigo = gerarCodigo();
    if (++tentativas > 10) return res.status(500).json({ erro: 'Erro ao gerar código' });
  } while (db.prepare('SELECT id FROM delivery WHERE codigo = ?').get(codigo));

  const executar = db.transaction(() => {
    db.prepare(`INSERT INTO delivery (codigo, tipo, atendente, usuario_id, nome_cliente, endereco, numero, bairro, referencia, pagamento, descricao, valor_total, horario_pedido)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(codigo, tipo, atendente, usuario_id, nome_cliente, endereco || '', numero || '', bairro || '', referencia || '', pagamento, descricao, valorTotal, agora());

    listaItens.forEach((it, i) => {
      const vinculo = vinculosItens[i];
      let codigoItem, tent = 0;
      do {
        codigoItem = gerarCodigoItem();
        if (++tent > 10) throw new Error('Erro ao gerar código do item');
      } while (db.prepare('SELECT id FROM pdv_vendas WHERE codigo = ?').get(codigoItem));
      db.prepare(`INSERT INTO pdv_vendas (codigo, descricao, valor, forma_pagamento, operador, usuario_id, criado_em, referencia_pagamento, produto_id, unidade, quantidade)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(codigoItem, String(it.descricao).trim(), Number(it.valor), pagamento, atendente, usuario_id, agora(), codigo, vinculo.produto_id, vinculo.unidade, vinculo.quantidade);
    });

    for (const tipo_id of listaFrangos) {
      const resultado = registrarVendaFrango({ tipo_id, atendente, usuario_id, forma_pagamento: pagamento, referencia_pagamento: codigo });
      if (resultado.erro) throw new Error(resultado.erro);
    }
  });

  try {
    executar();
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }

  res.json({ ...db.prepare('SELECT * FROM delivery WHERE codigo = ?').get(codigo), itens: buscarItensPedido(codigo) });
  broadcast('atualizar');
});

// Itens de frango assado do pedido são espelhados em pdv_vendas (ver registrarVendaFrango),
// então o JOIN com vendas identifica quais itens são fichas de frango (pra permitir reimprimir
// a ficha de retirada, além da comanda do pedido).
function buscarItensPedido(codigo) {
  return db.prepare(`
    SELECT pv.*, v.tipo_id as frango_tipo_id
    FROM pdv_vendas pv
    LEFT JOIN vendas v ON v.codigo = pv.codigo
    WHERE pv.referencia_pagamento = ? AND pv.cancelado = 0
  `).all(codigo);
}

router.get('/pedido/:codigo', (req, res) => {
  const pedido = db.prepare('SELECT * FROM delivery WHERE codigo = ?').get(req.params.codigo);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' });
  res.json({ ...pedido, itens: buscarItensPedido(req.params.codigo) });
});

// Indica, sem precisar buscar os itens completos, se o pedido tem ficha(s) de frango
// assado pra reimprimir — usado pra mostrar o botão de ficha direto nos cards.
const SELECT_COM_FRANGO = `*, EXISTS (
  SELECT 1 FROM pdv_vendas pv JOIN vendas v ON v.codigo = pv.codigo
  WHERE pv.referencia_pagamento = delivery.codigo AND pv.cancelado = 0
) AS tem_frango`;

router.get('/kanban', (req, res) => {
  const data = req.query.data || hoje();
  const pedidos = db.prepare(`SELECT ${SELECT_COM_FRANGO} FROM delivery WHERE cancelado = 0 AND date(horario_pedido) = ? ORDER BY horario_pedido ASC`).all(data);
  const colunas = { pendente: [], preparando: [], saiu_entrega: [], entregue: [] };
  pedidos.forEach(p => { if (colunas[p.status]) colunas[p.status].push(p); });
  res.json(colunas);
});

router.get('/cancelados', (req, res) => {
  const data = req.query.data || hoje();
  res.json(db.prepare(`SELECT ${SELECT_COM_FRANGO} FROM delivery WHERE cancelado = 1 AND date(horario_pedido) = ? ORDER BY horario_pedido DESC`).all(data));
});

router.put('/pedido/:codigo/status', (req, res) => {
  const { status } = req.body;
  if (!STATUS_VALIDOS.includes(status)) return res.status(400).json({ erro: 'Status inválido' });
  const pedido = db.prepare('SELECT * FROM delivery WHERE codigo = ?').get(req.params.codigo);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' });
  if (pedido.cancelado) return res.status(400).json({ erro: 'Pedido cancelado' });
  const horario_entrega = status === 'entregue' ? agora() : null;
  db.prepare('UPDATE delivery SET status = ?, horario_entrega = ? WHERE codigo = ?').run(status, horario_entrega, req.params.codigo);
  res.json({ sucesso: true });
  broadcast('atualizar');
});

router.put('/:id', exigirNivel('admin'), (req, res) => {
  const { tipo, atendente, nome_cliente, endereco, numero, bairro, referencia, status } = req.body;
  const pedido = db.prepare('SELECT * FROM delivery WHERE id = ?').get(req.params.id);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' });
  db.prepare(`UPDATE delivery SET tipo=?, atendente=?, nome_cliente=?, endereco=?, numero=?, bairro=?, referencia=?, status=? WHERE id=?`)
    .run(tipo, atendente, nome_cliente, endereco, numero, bairro, referencia, status, req.params.id);
  res.json({ sucesso: true });
  broadcast('atualizar');
});

// Cancela o pedido e cascateia o cancelamento pros lançamentos financeiros
// espelhados (pdv_vendas e vendas, no caso de itens de frango assado), evitando
// receita fantasma continuar contando no caixa do PDV.
router.delete('/:id', exigirNivel('admin'), (req, res) => {
  const pedido = db.prepare('SELECT * FROM delivery WHERE id = ?').get(req.params.id);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' });

  db.transaction(() => {
    db.prepare("UPDATE delivery SET cancelado=1, status='cancelado' WHERE id=?").run(req.params.id);
    db.prepare('UPDATE pdv_vendas SET cancelado=1 WHERE referencia_pagamento=?').run(pedido.codigo);
    db.prepare("UPDATE vendas SET cancelado=1, status='cancelado' WHERE codigo IN (SELECT codigo FROM pdv_vendas WHERE referencia_pagamento=?)").run(pedido.codigo);
  })();

  res.json({ sucesso: true });
  broadcast('atualizar');
});

module.exports = router;
