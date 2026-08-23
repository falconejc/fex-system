/**
 * @file pdv.js
 * @description Rotas do PDV (Ponto de Venda) para vendas avulsas de produtos diversos.
 * Gerencia registro e cancelamento de vendas, abertura de caixa, relatórios diário/mensal
 * e cadastro simples de clientes fiado.
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../database');
const { exigirNivel } = require('../auth');
const { broadcast } = require('../events');
const { registrarVendaFrango } = require('./frango');

const FORMAS_PAGAMENTO = ['dinheiro', 'pix', 'cartao_credito', 'cartao_debito'];
const UPLOADS_GASTOS_DIR = path.join(__dirname, '..', 'public', 'uploads', 'gastos');

// Decodifica uma foto de comprovante enviada como data URL (base64) e salva em disco.
// Evita adicionar multer/dependência de upload só pra isso — o front já redimensiona
// a imagem antes de enviar, então o payload fica pequeno o suficiente pro express.json().
function salvarComprovante(dataUrl) {
  if (!dataUrl) return null;
  const match = /^data:image\/(png|jpe?g|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error('Formato de comprovante inválido');
  const ext = match[1] === 'jpg' ? 'jpeg' : match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 5 * 1024 * 1024) throw new Error('Comprovante muito grande (máximo 5MB)');
  fs.mkdirSync(UPLOADS_GASTOS_DIR, { recursive: true });
  const nome = `gasto-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_GASTOS_DIR, nome), buffer);
  return `/uploads/gastos/${nome}`;
}

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

// Extrai produto_id/unidade/quantidade do corpo da requisição, validando o vínculo
// com o catálogo quando informado. Quantidade representa peso (kg) ou nº de unidades,
// conforme a unidade do produto — usado depois pros relatórios de kg/quantidade vendidos.
function extrairVinculoProduto(body) {
  const { produto_id, unidade, quantidade } = body;
  if (!produto_id) return { produto_id: null, unidade: null, quantidade: null };
  const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(produto_id);
  if (!produto) throw new Error('Produto inválido');
  const unidadeFinal = unidade === 'kg' ? 'kg' : 'un';
  const quantidadeNum = Number(quantidade);
  if (!quantidadeNum || quantidadeNum <= 0) throw new Error('Quantidade/peso inválido para o produto');
  return { produto_id: produto.id, unidade: unidadeFinal, quantidade: quantidadeNum };
}

router.post('/venda', (req, res) => {
  const { descricao, valor, forma_pagamento, data_hora } = req.body;
  if (!descricao || !descricao.trim()) return res.status(400).json({ erro: 'Descrição obrigatória' });
  const valorNum = Number(valor);
  if (!valorNum || valorNum <= 0) return res.status(400).json({ erro: 'Valor inválido' });
  if (!FORMAS_PAGAMENTO.includes(forma_pagamento)) return res.status(400).json({ erro: 'Forma de pagamento inválida' });

  let vinculo;
  try {
    vinculo = extrairVinculoProduto(req.body);
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }

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

  db.prepare(`INSERT INTO pdv_vendas (codigo, descricao, valor, forma_pagamento, operador, usuario_id, criado_em, produto_id, unidade, quantidade)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(codigo, descricao.trim(), valorNum, forma_pagamento, req.usuario.nome, req.usuario.id, criadoEm, vinculo.produto_id, vinculo.unidade, vinculo.quantidade);

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
  const vinculosItens = [];
  for (const it of listaItens) {
    if (!it.descricao || !String(it.descricao).trim()) return res.status(400).json({ erro: 'Descrição obrigatória' });
    if (!(Number(it.valor) > 0)) return res.status(400).json({ erro: 'Valor inválido' });
    try {
      vinculosItens.push(extrairVinculoProduto(it));
    } catch (e) {
      return res.status(400).json({ erro: e.message });
    }
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
    listaItens.forEach((it, i) => {
      let codigo, tentativas = 0;
      do {
        codigo = gerarCodigo();
        if (++tentativas > 10) throw new Error('Erro ao gerar código');
      } while (db.prepare('SELECT id FROM pdv_vendas WHERE codigo = ?').get(codigo));

      const vinculo = vinculosItens[i];
      db.prepare(`INSERT INTO pdv_vendas (codigo, descricao, valor, forma_pagamento, operador, usuario_id, criado_em, referencia_pagamento, produto_id, unidade, quantidade)
        VALUES (?, ?, ?, 'misto', ?, ?, ?, ?, ?, ?, ?)`)
        .run(codigo, String(it.descricao).trim(), Number(it.valor), atendente, usuario_id, criadoEm, referencia, vinculo.produto_id, vinculo.unidade, vinculo.quantidade);
      itensRegistrados.push(db.prepare('SELECT * FROM pdv_vendas WHERE codigo = ?').get(codigo));
    });

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

// Agrega vendas vinculadas a produtos do catálogo em dois totais: quilos vendidos
// (produtos por kg) e unidades vendidas (produtos por un) — usado nos relatórios
// diário e por período pra alimentar o dashboard de kg/quantidade.
function agregarProdutos(vendasValidas) {
  const comProduto = vendasValidas.filter(v => v.produto_id && v.unidade && v.quantidade != null);
  const idsUnicos = [...new Set(comProduto.map(v => v.produto_id))];
  const nomesMap = {};
  if (idsUnicos.length) {
    const placeholders = idsUnicos.map(() => '?').join(',');
    db.prepare(`SELECT id, nome, emoji FROM produtos WHERE id IN (${placeholders})`).all(...idsUnicos)
      .forEach(p => { nomesMap[p.id] = p; });
  }

  const porKg = {}, porQtd = {};
  comProduto.forEach(v => {
    const alvo = v.unidade === 'kg' ? porKg : porQtd;
    const produto = nomesMap[v.produto_id];
    if (!alvo[v.produto_id]) {
      alvo[v.produto_id] = {
        produto_id: v.produto_id,
        nome: produto ? produto.nome : 'Produto removido',
        emoji: produto ? produto.emoji : '📦',
        total_quantidade: 0,
        total_valor: 0
      };
    }
    alvo[v.produto_id].total_quantidade += v.quantidade;
    alvo[v.produto_id].total_valor += v.valor;
  });

  return {
    produtos_por_kg: Object.values(porKg).sort((a, b) => b.total_quantidade - a.total_quantidade),
    produtos_por_quantidade: Object.values(porQtd).sort((a, b) => b.total_quantidade - a.total_quantidade)
  };
}

router.get('/vendas', (req, res) => {
  const data = hoje();
  res.json(db.prepare('SELECT * FROM pdv_vendas WHERE date(criado_em) = ? AND cancelado = 0 ORDER BY criado_em DESC').all(data));
});

router.get('/relatorio/dia', (req, res) => {
  const data = req.query.data || hoje();
  const vendas = db.prepare('SELECT * FROM pdv_vendas WHERE date(criado_em) = ? ORDER BY criado_em DESC').all(data);
  const validas = vendas.filter(v => !v.cancelado);

  const gastos = db.prepare(`
    SELECT g.*, c.nome as categoria_nome, c.emoji as categoria_emoji
    FROM pdv_gastos g LEFT JOIN pdv_categorias_gasto c ON g.categoria_id = c.id
    WHERE date(g.criado_em) = ? ORDER BY g.criado_em DESC
  `).all(data);
  const gastosValidos = gastos.filter(g => !g.cancelado);
  const totalGastos = gastosValidos.reduce((s, g) => s + g.valor, 0);
  // Só gasto pago em dinheiro sai fisicamente da gaveta — os demais (pix/cartão da empresa)
  // entram no total de gastos normalmente, mas não afetam a conferência do caixa físico.
  const totalGastosDinheiro = gastosValidos.filter(g => (g.forma_saida || 'dinheiro') === 'dinheiro').reduce((s, g) => s + g.valor, 0);

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
  const saldoEsperadoCaixa = caixa ? caixa.valor_abertura + porFormaPagamento.dinheiro.total - totalGastosDinheiro : null;

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
    pagamentos_mistos: pagamentosMistos,
    ...agregarProdutos(validas)
  });
});

// Relatório financeiro do PDV por período (usado pelo dashboard) — mesma lógica do
// /relatorio/dia (soma pagamentos mistos por forma real), mas agregado por intervalo de datas.
router.get('/relatorio/periodo', (req, res) => {
  const ini = req.query.ini || hoje();
  const fim = req.query.fim || hoje();
  const vendas = db.prepare('SELECT * FROM pdv_vendas WHERE date(criado_em) BETWEEN ? AND ? ORDER BY criado_em ASC').all(ini, fim);
  const validas = vendas.filter(v => !v.cancelado);

  const gastos = db.prepare(`
    SELECT g.*, c.nome as categoria_nome, c.emoji as categoria_emoji
    FROM pdv_gastos g LEFT JOIN pdv_categorias_gasto c ON g.categoria_id = c.id
    WHERE date(g.criado_em) BETWEEN ? AND ? ORDER BY g.criado_em ASC
  `).all(ini, fim);
  const gastosValidos = gastos.filter(g => !g.cancelado);
  const totalGastos = gastosValidos.reduce((s, g) => s + g.valor, 0);

  const porFormaPagamento = {};
  FORMAS_PAGAMENTO.forEach(f => { porFormaPagamento[f] = { quantidade: 0, total: 0 }; });
  validas.forEach(v => {
    if (v.forma_pagamento === 'misto') return;
    porFormaPagamento[v.forma_pagamento].quantidade++;
    porFormaPagamento[v.forma_pagamento].total += v.valor;
  });

  const pagamentosMistos = db.prepare('SELECT * FROM pdv_pagamentos_misto WHERE date(criado_em) BETWEEN ? AND ? AND cancelado = 0').all(ini, fim);
  pagamentosMistos.forEach(p => {
    if (!porFormaPagamento[p.forma_pagamento]) porFormaPagamento[p.forma_pagamento] = { quantidade: 0, total: 0 };
    porFormaPagamento[p.forma_pagamento].quantidade++;
    porFormaPagamento[p.forma_pagamento].total += p.valor;
  });

  const totalVendido = validas.reduce((s, v) => s + v.valor, 0);

  const diasMap = {};
  let cur = new Date(ini + 'T12:00:00');
  const fimDate = new Date(fim + 'T12:00:00');
  while (cur <= fimDate) {
    const d = cur.toISOString().split('T')[0];
    diasMap[d] = { data: d, quantidade: 0, total_vendido: 0, total_gastos: 0 };
    cur.setDate(cur.getDate() + 1);
  }
  validas.forEach(v => { const d = v.criado_em.split(' ')[0]; if (diasMap[d]) { diasMap[d].quantidade++; diasMap[d].total_vendido += v.valor; } });
  gastosValidos.forEach(g => { const d = g.criado_em.split(' ')[0]; if (diasMap[d]) diasMap[d].total_gastos += g.valor; });

  const produtosMap = {};
  validas.forEach(v => {
    if (!produtosMap[v.descricao]) produtosMap[v.descricao] = { descricao: v.descricao, quantidade: 0, total: 0 };
    produtosMap[v.descricao].quantidade++;
    produtosMap[v.descricao].total += v.valor;
  });
  const topProdutos = Object.values(produtosMap).sort((a, b) => b.total - a.total).slice(0, 8);

  // Agrupa por categoria (não por descrição livre) pra não fragmentar o relatório
  // com variações de texto do mesmo tipo de gasto (ex.: "gelo" vs "Compra de gelo").
  const gastosMap = {};
  gastosValidos.forEach(g => {
    const chave = g.categoria_id || 'sem-categoria';
    if (!gastosMap[chave]) gastosMap[chave] = { categoria: g.categoria_nome || 'Sem categoria', emoji: g.categoria_emoji || '📦', quantidade: 0, total: 0 };
    gastosMap[chave].quantidade++;
    gastosMap[chave].total += g.valor;
  });
  const topGastos = Object.values(gastosMap).sort((a, b) => b.total - a.total);

  res.json({
    ini, fim,
    resumo: {
      total_vendido: totalVendido,
      quantidade_vendas: validas.length,
      ticket_medio: validas.length ? totalVendido / validas.length : 0,
      por_forma_pagamento: porFormaPagamento,
      total_gastos: totalGastos,
      quantidade_gastos: gastosValidos.length,
      saldo_liquido: totalVendido - totalGastos
    },
    por_dia: Object.values(diasMap),
    top_produtos: topProdutos,
    top_gastos: topGastos,
    ...agregarProdutos(validas)
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

  let criadoEm = agora();
  if (req.body.data_hora) {
    if (!['admin', 'dono'].includes(req.usuario.nivel)) {
      return res.status(403).json({ erro: 'Apenas admin ou dono podem definir horário retroativo da abertura' });
    }
    criadoEm = validarDataRetroativa(req.body.data_hora);
    if (!criadoEm) return res.status(400).json({ erro: 'Data/hora retroativa inválida' });
  }

  if (existente) {
    db.prepare('UPDATE pdv_caixa SET valor_abertura = ?, operador = ?, usuario_id = ?, criado_em = ? WHERE data = ?')
      .run(valorNum, req.usuario.nome, req.usuario.id, criadoEm, data);
  } else {
    db.prepare('INSERT INTO pdv_caixa (data, valor_abertura, operador, usuario_id, criado_em) VALUES (?, ?, ?, ?, ?)')
      .run(data, valorNum, req.usuario.nome, req.usuario.id, criadoEm);
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

// Categorias de gasto (gerenciáveis pela tela de categorias em pdv.html, sem precisar mexer em código)
router.get('/categorias-gasto', (req, res) => {
  res.json(db.prepare('SELECT * FROM pdv_categorias_gasto WHERE ativo = 1 ORDER BY nome').all());
});

router.get('/categorias-gasto/todas', exigirNivel('admin', 'dono'), (req, res) => {
  res.json(db.prepare('SELECT * FROM pdv_categorias_gasto ORDER BY ativo DESC, nome').all());
});

router.post('/categorias-gasto', exigirNivel('admin', 'dono'), (req, res) => {
  const { nome, emoji } = req.body;
  if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
  const info = db.prepare('INSERT INTO pdv_categorias_gasto (nome, emoji) VALUES (?, ?)').run(nome.trim(), emoji || '📦');
  res.json(db.prepare('SELECT * FROM pdv_categorias_gasto WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/categorias-gasto/:id', exigirNivel('admin', 'dono'), (req, res) => {
  const categoria = db.prepare('SELECT * FROM pdv_categorias_gasto WHERE id = ?').get(req.params.id);
  if (!categoria) return res.status(404).json({ erro: 'Categoria não encontrada' });
  const { nome, emoji, ativo } = req.body;
  if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
  db.prepare('UPDATE pdv_categorias_gasto SET nome = ?, emoji = ?, ativo = ? WHERE id = ?')
    .run(nome.trim(), emoji || '📦', ativo ? 1 : 0, req.params.id);
  res.json(db.prepare('SELECT * FROM pdv_categorias_gasto WHERE id = ?').get(req.params.id));
});

function categoriaValida(categoriaId) {
  return db.prepare('SELECT id FROM pdv_categorias_gasto WHERE id = ?').get(categoriaId);
}

router.post('/gasto', (req, res) => {
  const { descricao, valor, categoria_id, forma_saida, comprovante, data_hora } = req.body;
  if (!descricao || !descricao.trim()) return res.status(400).json({ erro: 'Descrição obrigatória' });
  const valorNum = Number(valor);
  if (!valorNum || valorNum <= 0) return res.status(400).json({ erro: 'Valor inválido' });
  if (!categoria_id || !categoriaValida(categoria_id)) return res.status(400).json({ erro: 'Categoria inválida' });
  const formaSaidaFinal = forma_saida || 'dinheiro';
  if (!FORMAS_PAGAMENTO.includes(formaSaidaFinal)) return res.status(400).json({ erro: 'Forma de saída inválida' });

  let criadoEm = agora();
  if (data_hora) {
    if (!['admin', 'dono'].includes(req.usuario.nivel)) {
      return res.status(403).json({ erro: 'Apenas admin ou dono podem lançar gastos retroativos' });
    }
    criadoEm = validarDataRetroativa(data_hora);
    if (!criadoEm) return res.status(400).json({ erro: 'Data/hora retroativa inválida' });
  }

  let comprovantePath;
  try {
    comprovantePath = salvarComprovante(comprovante);
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }

  const info = db.prepare(`INSERT INTO pdv_gastos (descricao, valor, categoria_id, forma_saida, comprovante, operador, usuario_id, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(descricao.trim(), valorNum, categoria_id, formaSaidaFinal, comprovantePath, req.usuario.nome, req.usuario.id, criadoEm);

  res.json(db.prepare(`
    SELECT g.*, c.nome as categoria_nome, c.emoji as categoria_emoji
    FROM pdv_gastos g LEFT JOIN pdv_categorias_gasto c ON g.categoria_id = c.id
    WHERE g.id = ?
  `).get(info.lastInsertRowid));
});

router.put('/gasto/:id', exigirNivel('admin', 'dono'), (req, res) => {
  const gasto = db.prepare('SELECT * FROM pdv_gastos WHERE id = ?').get(req.params.id);
  if (!gasto) return res.status(404).json({ erro: 'Gasto não encontrado' });

  const { descricao, valor, categoria_id, forma_saida, comprovante } = req.body;
  if (!descricao || !descricao.trim()) return res.status(400).json({ erro: 'Descrição obrigatória' });
  const valorNum = Number(valor);
  if (!valorNum || valorNum <= 0) return res.status(400).json({ erro: 'Valor inválido' });
  const categoriaFinal = categoria_id || gasto.categoria_id;
  if (!categoriaFinal || !categoriaValida(categoriaFinal)) return res.status(400).json({ erro: 'Categoria inválida' });
  const formaSaidaFinal = forma_saida || gasto.forma_saida || 'dinheiro';
  if (!FORMAS_PAGAMENTO.includes(formaSaidaFinal)) return res.status(400).json({ erro: 'Forma de saída inválida' });

  let comprovantePath = gasto.comprovante;
  if (comprovante) {
    try {
      comprovantePath = salvarComprovante(comprovante);
    } catch (e) {
      return res.status(400).json({ erro: e.message });
    }
  }

  db.prepare('UPDATE pdv_gastos SET descricao = ?, valor = ?, categoria_id = ?, forma_saida = ?, comprovante = ? WHERE id = ?')
    .run(descricao.trim(), valorNum, categoriaFinal, formaSaidaFinal, comprovantePath, req.params.id);

  res.json(db.prepare(`
    SELECT g.*, c.nome as categoria_nome, c.emoji as categoria_emoji
    FROM pdv_gastos g LEFT JOIN pdv_categorias_gasto c ON g.categoria_id = c.id
    WHERE g.id = ?
  `).get(req.params.id));
});

router.get('/gastos', (req, res) => {
  const data = hoje();
  res.json(db.prepare(`
    SELECT g.*, c.nome as categoria_nome, c.emoji as categoria_emoji
    FROM pdv_gastos g LEFT JOIN pdv_categorias_gasto c ON g.categoria_id = c.id
    WHERE date(g.criado_em) = ? AND g.cancelado = 0
    ORDER BY g.criado_em DESC
  `).all(data));
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
