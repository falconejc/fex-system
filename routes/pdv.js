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
const { broadcast } = require('../events');
const { registrarVendaFrango } = require('./frango');

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

function gerarReferenciaMisto() {
  return 'MX' + Math.random().toString(36).substring(2, 7).toUpperCase();
}

// Valida uma data/hora retroativa vinda do front (formato 'YYYY-MM-DDTHH:MM' ou com segundos)
// e garante que não é uma data futura. Retorna null se inválida.
function validarDataRetroativa(dataHora) {
  if (typeof dataHora !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(dataHora)) return null;
  let formatada = dataHora.replace('T', ' ');
  if (formatada.length === 16) formatada += ':00';
  if (formatada > agora()) return null;
  return formatada;
}

router.post('/venda', (req, res) => {
  const { descricao, valor, forma_pagamento, data_hora } = req.body;
  if (!descricao || !descricao.trim()) return res.status(400).json({ erro: 'Descrição obrigatória' });
  const valorNum = Number(valor);
  if (!valorNum || valorNum <= 0) return res.status(400).json({ erro: 'Valor inválido' });
  if (!FORMAS_PAGAMENTO.includes(forma_pagamento)) return res.status(400).json({ erro: 'Forma de pagamento inválida' });

  let criadoEm = agora();
  if (data_hora) {
    if (!['admin', 'dono'].includes(req.usuario.nivel)) {
      return res.status(403).json({ erro: 'Apenas admin ou dono podem lançar vendas retroativas' });
    }
    criadoEm = validarDataRetroativa(data_hora);
    if (!criadoEm) return res.status(400).json({ erro: 'Data/hora retroativa inválida' });
  }

  let codigo, tentativas = 0;
  do {
    codigo = gerarCodigo();
    if (++tentativas > 10) return res.status(500).json({ erro: 'Erro ao gerar código' });
  } while (db.prepare('SELECT id FROM pdv_vendas WHERE codigo = ?').get(codigo));

  db.prepare(`INSERT INTO pdv_vendas (codigo, descricao, valor, forma_pagamento, operador, usuario_id, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(codigo, descricao.trim(), valorNum, forma_pagamento, req.usuario.nome, req.usuario.id, criadoEm);

  res.json(db.prepare('SELECT * FROM pdv_vendas WHERE codigo = ?').get(codigo));
});

// Venda com pagamento dividido entre duas ou mais formas (ex.: parte no cartão, parte no dinheiro).
// Cada item/frango é registrado normalmente (mantendo ficha, baixa de estoque e insumos),
// só que marcado com forma_pagamento='misto' — o de-para real de quanto foi pago em cada
// forma fica em pdv_pagamentos_misto, somado no relatório do dia.
router.post('/venda-dividida', (req, res) => {
  const listaItens = Array.isArray(req.body.itens) ? req.body.itens : [];
  const listaFrangos = Array.isArray(req.body.frango_tipo_ids) ? req.body.frango_tipo_ids : [];
  const listaPagamentos = Array.isArray(req.body.pagamentos) ? req.body.pagamentos : [];
  const { data_hora } = req.body;

  if (!listaItens.length && !listaFrangos.length) {
    return res.status(400).json({ erro: 'Nenhum item na venda' });
  }
  if (!listaPagamentos.length) {
    return res.status(400).json({ erro: 'Informe ao menos uma forma de pagamento' });
  }
  for (const p of listaPagamentos) {
    if (!FORMAS_PAGAMENTO.includes(p.forma_pagamento)) return res.status(400).json({ erro: 'Forma de pagamento inválida' });
    if (!(Number(p.valor) > 0)) return res.status(400).json({ erro: 'Valor de pagamento inválido' });
  }
  for (const it of listaItens) {
    if (!it.descricao || !String(it.descricao).trim()) return res.status(400).json({ erro: 'Descrição obrigatória' });
    if (!(Number(it.valor) > 0)) return res.status(400).json({ erro: 'Valor inválido' });
  }

  let criadoEm = agora();
  if (data_hora) {
    if (listaFrangos.length) {
      return res.status(400).json({ erro: 'Itens de frango assado não podem ser lançados de forma retroativa' });
    }
    if (!['admin', 'dono'].includes(req.usuario.nivel)) {
      return res.status(403).json({ erro: 'Apenas admin ou dono podem lançar vendas retroativas' });
    }
    criadoEm = validarDataRetroativa(data_hora);
    if (!criadoEm) return res.status(400).json({ erro: 'Data/hora retroativa inválida' });
  }

  const tiposFrango = listaFrangos.map(id => db.prepare('SELECT * FROM tipos_frango WHERE id = ? AND ativo = 1').get(id));
  if (tiposFrango.some(t => !t)) return res.status(400).json({ erro: 'Tipo de frango inválido' });

  const totalItens = listaItens.reduce((s, it) => s + Number(it.valor), 0);
  const totalFrangos = tiposFrango.reduce((s, t) => s + t.preco, 0);
  const totalPagamentos = listaPagamentos.reduce((s, p) => s + Number(p.valor), 0);
  if (Math.abs(totalPagamentos - (totalItens + totalFrangos)) > 0.01) {
    return res.status(400).json({ erro: 'A soma dos pagamentos não bate com o total da venda' });
  }

  const referencia = gerarReferenciaMisto();
  const atendente = req.usuario.nome;
  const usuario_id = req.usuario.id;

  const executar = db.transaction(() => {
    const itensRegistrados = [];
    for (const it of listaItens) {
      let codigo, tentativas = 0;
      do {
        codigo = gerarCodigo();
        if (++tentativas > 10) throw new Error('Erro ao gerar código');
      } while (db.prepare('SELECT id FROM pdv_vendas WHERE codigo = ?').get(codigo));

      db.prepare(`INSERT INTO pdv_vendas (codigo, descricao, valor, forma_pagamento, operador, usuario_id, criado_em, referencia_pagamento)
        VALUES (?, ?, ?, 'misto', ?, ?, ?, ?)`)
        .run(codigo, String(it.descricao).trim(), Number(it.valor), atendente, usuario_id, criadoEm, referencia);
      itensRegistrados.push(db.prepare('SELECT * FROM pdv_vendas WHERE codigo = ?').get(codigo));
    }

    const frangosRegistrados = [];
    for (const tipo_id of listaFrangos) {
      const resultado = registrarVendaFrango({
        tipo_id, atendente, usuario_id, forma_pagamento: 'misto', referencia_pagamento: referencia
      });
      if (resultado.erro) throw new Error(resultado.erro);
      frangosRegistrados.push(resultado.venda);
    }

    listaPagamentos.forEach(p => {
      db.prepare(`INSERT INTO pdv_pagamentos_misto (referencia, forma_pagamento, valor, operador, usuario_id, criado_em)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(referencia, p.forma_pagamento, Number(p.valor), atendente, usuario_id, criadoEm);
    });

    return { itensRegistrados, frangosRegistrados };
  });

  try {
    const { itensRegistrados, frangosRegistrados } = executar();
    res.json({ referencia, itens: itensRegistrados, frangos: frangosRegistrados });
    if (frangosRegistrados.length) broadcast('atualizar');
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// Cancela todos os itens (e pagamentos) de uma venda com pagamento dividido, pelo código de referência.
router.put('/venda-dividida/:referencia/cancelar', exigirNivel('admin', 'dono'), (req, res) => {
  const { referencia } = req.params;
  const itens = db.prepare('SELECT * FROM pdv_vendas WHERE referencia_pagamento = ?').all(referencia);
  const pagamentos = db.prepare('SELECT * FROM pdv_pagamentos_misto WHERE referencia = ?').all(referencia);
  if (!itens.length && !pagamentos.length) return res.status(404).json({ erro: 'Venda dividida não encontrada' });

  db.transaction(() => {
    db.prepare('UPDATE pdv_vendas SET cancelado = 1 WHERE referencia_pagamento = ?').run(referencia);
    db.prepare("UPDATE vendas SET cancelado = 1, status = 'cancelado' WHERE codigo IN (SELECT codigo FROM pdv_vendas WHERE referencia_pagamento = ?)").run(referencia);
    db.prepare('UPDATE pdv_pagamentos_misto SET cancelado = 1 WHERE referencia = ?').run(referencia);
  })();

  res.json({ sucesso: true });
});

router.get('/vendas', (req, res) => {
  const data = hoje();
  res.json(db.prepare('SELECT * FROM pdv_vendas WHERE date(criado_em) = ? AND cancelado = 0 ORDER BY criado_em DESC').all(data));
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
    // Vendas com pagamento dividido ('misto') não têm uma forma única — a baixa por
    // forma de pagamento real vem de pdv_pagamentos_misto, somada logo abaixo.
    if (v.forma_pagamento === 'misto') return;
    porFormaPagamento[v.forma_pagamento].quantidade++;
    porFormaPagamento[v.forma_pagamento].total += v.valor;
  });

  const pagamentosMistos = db.prepare('SELECT * FROM pdv_pagamentos_misto WHERE date(criado_em) = ? AND cancelado = 0').all(data);
  pagamentosMistos.forEach(p => {
    if (!porFormaPagamento[p.forma_pagamento]) porFormaPagamento[p.forma_pagamento] = { quantidade: 0, total: 0 };
    porFormaPagamento[p.forma_pagamento].quantidade++;
    porFormaPagamento[p.forma_pagamento].total += p.valor;
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
    gastos,
    pagamentos_mistos: pagamentosMistos
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

router.put('/venda/:id', exigirNivel('admin', 'dono'), (req, res) => {
  const venda = db.prepare('SELECT * FROM pdv_vendas WHERE id = ?').get(req.params.id);
  if (!venda) return res.status(404).json({ erro: 'Venda não encontrada' });

  const { descricao, valor, forma_pagamento } = req.body;
  if (!descricao || !descricao.trim()) return res.status(400).json({ erro: 'Descrição obrigatória' });
  const valorNum = Number(valor);
  if (!valorNum || valorNum <= 0) return res.status(400).json({ erro: 'Valor inválido' });
  if (!FORMAS_PAGAMENTO.includes(forma_pagamento)) return res.status(400).json({ erro: 'Forma de pagamento inválida' });

  db.prepare('UPDATE pdv_vendas SET descricao = ?, valor = ?, forma_pagamento = ? WHERE id = ?')
    .run(descricao.trim(), valorNum, forma_pagamento, req.params.id);

  res.json(db.prepare('SELECT * FROM pdv_vendas WHERE id = ?').get(req.params.id));
});

router.put('/venda/:id/cancelar', exigirNivel('admin', 'dono'), (req, res) => {
  const venda = db.prepare('SELECT * FROM pdv_vendas WHERE id = ?').get(req.params.id);
  if (!venda) return res.status(404).json({ erro: 'Venda não encontrada' });
  if (venda.cancelado) return res.status(400).json({ erro: 'Venda já cancelada' });
  db.prepare('UPDATE pdv_vendas SET cancelado = 1 WHERE id = ?').run(req.params.id);
  res.json({ sucesso: true });
});

router.post('/gasto', (req, res) => {
  const { descricao, valor, data_hora } = req.body;
  if (!descricao || !descricao.trim()) return res.status(400).json({ erro: 'Descrição obrigatória' });
  const valorNum = Number(valor);
  if (!valorNum || valorNum <= 0) return res.status(400).json({ erro: 'Valor inválido' });

  let criadoEm = agora();
  if (data_hora) {
    if (!['admin', 'dono'].includes(req.usuario.nivel)) {
      return res.status(403).json({ erro: 'Apenas admin ou dono podem lançar gastos retroativos' });
    }
    criadoEm = validarDataRetroativa(data_hora);
    if (!criadoEm) return res.status(400).json({ erro: 'Data/hora retroativa inválida' });
  }

  const info = db.prepare(`INSERT INTO pdv_gastos (descricao, valor, operador, usuario_id, criado_em)
    VALUES (?, ?, ?, ?, ?)`)
    .run(descricao.trim(), valorNum, req.usuario.nome, req.usuario.id, criadoEm);

  res.json(db.prepare('SELECT * FROM pdv_gastos WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/gasto/:id', exigirNivel('admin', 'dono'), (req, res) => {
  const gasto = db.prepare('SELECT * FROM pdv_gastos WHERE id = ?').get(req.params.id);
  if (!gasto) return res.status(404).json({ erro: 'Gasto não encontrado' });

  const { descricao, valor } = req.body;
  if (!descricao || !descricao.trim()) return res.status(400).json({ erro: 'Descrição obrigatória' });
  const valorNum = Number(valor);
  if (!valorNum || valorNum <= 0) return res.status(400).json({ erro: 'Valor inválido' });

  db.prepare('UPDATE pdv_gastos SET descricao = ?, valor = ? WHERE id = ?')
    .run(descricao.trim(), valorNum, req.params.id);

  res.json(db.prepare('SELECT * FROM pdv_gastos WHERE id = ?').get(req.params.id));
});

router.get('/gastos', (req, res) => {
  const data = hoje();
  res.json(db.prepare('SELECT * FROM pdv_gastos WHERE date(criado_em) = ? AND cancelado = 0 ORDER BY criado_em DESC').all(data));
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
