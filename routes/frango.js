/**
 * @file frango.js
 * @description Rotas para vendas de frango assado.
 * Gerencia registro de vendas, validação de estoque, geração de código único,
 * baixa de entregas e consulta por QR code.
 */

const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirNivel } = require('../auth');
const { broadcast } = require('../events');

const FORMAS_PAGAMENTO = ['dinheiro', 'pix', 'cartao_credito', 'cartao_debito'];

function gerarCodigo() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function hoje() {
  return new Date().toLocaleDateString('pt-BR', {timeZone:'America/Sao_Paulo'}).split('/').reverse().join('-');
}

function agora() {
  return new Date().toLocaleString('sv-SE', {timeZone:'America/Sao_Paulo'}).replace('T', ' ');
}

// Registra uma venda de frango (estoque, ficha, insumos, espelho no PDV).
// Reaproveitada tanto pela rota /venda quanto pelo fluxo de pagamento dividido do PDV.
// forma_pagamento já deve vir sanitizada pelo chamador (não valida contra FORMAS_PAGAMENTO aqui,
// pra permitir o marcador interno 'misto' sem expor esse valor como opção pública).
function registrarVendaFrango({ tipo_id, atendente, usuario_id, observacao, telefone, forma_pagamento, referencia_pagamento }) {
  if (!tipo_id) return { erro: 'Tipo obrigatório' };

  const tipo = db.prepare('SELECT * FROM tipos_frango WHERE id = ? AND ativo = 1').get(tipo_id);
  if (!tipo) return { erro: 'Tipo inválido' };

  const data = hoje();
  const est = db.prepare('SELECT * FROM estoque WHERE data = ? AND tipo_id = ?').get(data, tipo_id);
  if (est && est.quantidade > 0) {
    const vendidos = db.prepare("SELECT COUNT(*) as c FROM vendas WHERE tipo_id=? AND cancelado=0 AND date(horario_compra)=?").get(tipo_id, data).c;
    if (vendidos >= est.quantidade) {
      return { erro: `Estoque esgotado para ${tipo.nome}!` };
    }
  }

  let codigo, tentativas = 0;
  do {
    codigo = gerarCodigo();
    if (++tentativas > 10) return { erro: 'Erro ao gerar código' };
  } while (db.prepare('SELECT id FROM vendas WHERE codigo = ?').get(codigo));

  // Calcula ordem sequencial do tipo no dia
  const dataHoje = hoje();
  const ordemRow = db.prepare(`
    SELECT COUNT(*) as total FROM vendas
    WHERE tipo_id = ? AND DATE(horario_compra) = ? AND cancelado = 0
  `).get(tipo_id, dataHoje);
  const ordem_tipo = (ordemRow.total || 0) + 1;

  db.prepare('INSERT INTO vendas (codigo, tipo, tipo_id, atendente, usuario_id, observacao, telefone, horario_compra, ordem_tipo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(codigo, tipo.nome, tipo_id, atendente, usuario_id, observacao || '', telefone || '', agora(), ordem_tipo);

  // Espelha a venda no PDV pra entrar no saldo esperado do caixa
  db.prepare(`INSERT INTO pdv_vendas (codigo, descricao, valor, forma_pagamento, operador, usuario_id, criado_em, referencia_pagamento)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(codigo, tipo.nome, tipo.preco, forma_pagamento, atendente, usuario_id, agora(), referencia_pagamento || null);

  // Baixa automatica de insumos vinculados ao tipo
  const insumos_vinculados = db.prepare('SELECT ti.*, i.nome, i.quantidade_atual FROM tipo_insumos ti LEFT JOIN insumos i ON ti.insumo_id = i.id WHERE ti.tipo_id = ?').all(tipo_id);
  const alertas_insumos = [];
  insumos_vinculados.forEach(iv => {
    const nova_qtd = iv.quantidade_atual - iv.quantidade;
    db.prepare('UPDATE insumos SET quantidade_atual = ? WHERE id = ?').run(nova_qtd, iv.insumo_id);
    db.prepare('INSERT INTO movimentacoes_insumos (insumo_id, tipo, quantidade, observacao, usuario_id) VALUES (?, ?, ?, ?, ?)').run(iv.insumo_id, 'saida', iv.quantidade, 'Venda automatica - ' + codigo, usuario_id);
    if (nova_qtd <= 0) alertas_insumos.push({ nome: iv.nome, quantidade_atual: nova_qtd });
  });

  const venda = db.prepare('SELECT * FROM vendas WHERE codigo = ?').get(codigo);
  return { venda: { ...venda, tipo_nome: tipo.nome, alertas_insumos } };
}

router.post('/venda', (req, res) => {
  const { tipo_id, observacao, telefone } = req.body;
  const forma_pagamento = FORMAS_PAGAMENTO.includes(req.body.forma_pagamento) ? req.body.forma_pagamento : 'dinheiro';

  const resultado = registrarVendaFrango({
    tipo_id, atendente: req.usuario.nome, usuario_id: req.usuario.id, observacao, telefone, forma_pagamento
  });
  if (resultado.erro) return res.status(400).json({ erro: resultado.erro });

  res.json(resultado.venda);
  broadcast('atualizar');
});

router.get('/pendentes', (req, res) => {
  res.json(db.prepare(`
    SELECT v.*, t.nome as tipo_nome, t.preco, t.icone as tipo_icone
    FROM vendas v
    LEFT JOIN tipos_frango t ON v.tipo_id = t.id
    WHERE v.status='pendente' AND v.cancelado=0
    ORDER BY v.tipo_id ASC, v.ordem_tipo ASC
  `).all());
});

router.get('/qrcode/:codigo', (req, res) => {
  const venda = db.prepare(`
    SELECT v.*, t.nome as tipo_nome FROM vendas v
    LEFT JOIN tipos_frango t ON v.tipo_id = t.id
    WHERE v.codigo = ?
  `).get(req.params.codigo);
  if (!venda) return res.status(404).json({ erro: 'Código não encontrado' });
  res.json(venda);
});

router.post('/entrega/:codigo', (req, res) => {
  const venda = db.prepare('SELECT * FROM vendas WHERE codigo = ?').get(req.params.codigo);
  if (!venda) return res.status(404).json({ erro: 'Código não encontrado' });
  if (venda.status === 'entregue') return res.status(400).json({ erro: 'Já entregue' });
  if (venda.cancelado) return res.status(400).json({ erro: 'Venda cancelada' });
  db.prepare("UPDATE vendas SET status='entregue', horario_entrega=? WHERE codigo=?").run(agora(), req.params.codigo);
  res.json({ sucesso: true });
  broadcast('atualizar');
});

router.put('/:id', exigirNivel('admin'), (req, res) => {
  const { tipo_id, atendente, status, observacao } = req.body;
  const venda = db.prepare('SELECT * FROM vendas WHERE id = ?').get(req.params.id);
  if (!venda) return res.status(404).json({ erro: 'Venda não encontrada' });
  const tipo = db.prepare('SELECT * FROM tipos_frango WHERE id = ?').get(tipo_id);
  db.prepare('UPDATE vendas SET tipo=?, tipo_id=?, atendente=?, status=?, observacao=? WHERE id=?')
    .run(tipo ? tipo.nome : venda.tipo, tipo_id, atendente, status, observacao, req.params.id);
  res.json({ sucesso: true });
});

router.delete('/:id', exigirNivel('admin'), (req, res) => {
  const venda = db.prepare('SELECT * FROM vendas WHERE id = ?').get(req.params.id);
  if (!venda) return res.status(404).json({ erro: 'Venda não encontrada' });
  db.prepare("UPDATE vendas SET cancelado=1, status='cancelado' WHERE id=?").run(req.params.id);
  db.prepare('UPDATE pdv_vendas SET cancelado=1 WHERE codigo=?').run(venda.codigo);
  res.json({ sucesso: true });
});

// Cancela venda pelo código (usado na tela de pendentes pelo admin)
router.post('/:codigo/cancelar', exigirNivel('admin'), (req, res) => {
  const venda = db.prepare('SELECT * FROM vendas WHERE codigo = ?').get(req.params.codigo);
  if (!venda) return res.status(404).json({ erro: 'Venda não encontrada' });
  if (venda.status === 'entregue') return res.status(400).json({ erro: 'Venda já entregue' });
  if (venda.cancelado) return res.status(400).json({ erro: 'Venda já cancelada' });
  db.prepare("UPDATE vendas SET cancelado=1, status='cancelado' WHERE codigo=?").run(req.params.codigo);
  db.prepare('UPDATE pdv_vendas SET cancelado=1 WHERE codigo=?').run(req.params.codigo);
  res.json({ sucesso: true });
});

module.exports = router;
module.exports.registrarVendaFrango = registrarVendaFrango;
