/**
 * @file lotes.js
 * @description Rotas para gerenciamento de lotes de frangos no forno.
 * Controla entrada de lotes, previsão de conclusão (90min), status e validação
 * de quantidade contra o estoque de frangos crus registrado no dia.
 */

const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirNivel } = require('../auth');

/**
 * Retorna data/hora atual no fuso America/Sao_Paulo formatada para SQLite.
 * @returns {string} Ex: "2026-03-15 14:30:00"
 */
function agora() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace('T', ' ');
}

/**
 * Soma minutos a uma string de data/hora e retorna nova string formatada.
 * @param {string} dataStr - Data no formato "YYYY-MM-DD HH:MM:SS"
 * @param {number} minutos - Minutos a adicionar
 * @returns {string} Nova data/hora formatada
 */
function somarMinutos(dataStr, minutos) {
  const p = dataStr.replace('T', ' ').split(/[- :]/);
  const d = new Date(p[0], p[1] - 1, p[2], p[3], p[4], p[5] || 0);
  d.setMinutes(d.getMinutes() + minutos);
  return d.toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace('T', ' ');
}

/**
 * Retorna a data de hoje no formato YYYY-MM-DD (fuso Sao_Paulo).
 * @returns {string}
 */
function hoje() {
  return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    .split('/').reverse().join('-');
}

/**
 * Calcula quantos frangos crus ainda estão disponíveis para assar no dia.
 * Disponível = total de crus registrados - total já colocado em lotes hoje.
 * @param {string} data - Data no formato YYYY-MM-DD
 * @param {number} tipo_id - ID do tipo de frango
 * @returns {number} Quantidade disponível para assar
 */
function calcularDisponivel(data, tipo_id) {
  const totalCrus = db.prepare(
    'SELECT COALESCE(SUM(quantidade), 0) as t FROM frangos_crus WHERE data = ? AND tipo_id = ?'
  ).get(data, tipo_id).t;

  const totalEmLotes = db.prepare(
    "SELECT COALESCE(SUM(quantidade), 0) as t FROM lotes WHERE date(horario_entrada) = ? AND tipo_id = ?"
  ).get(data, tipo_id).t;

  return totalCrus - totalEmLotes;
}

/**
 * GET /api/lotes/ativos
 * Lista todos os lotes do dia com nome do tipo de frango.
 */
router.get('/ativos', (req, res) => {
  const data = hoje();
  const lotes = db.prepare(`
    SELECT l.*, t.nome as tipo_nome
    FROM lotes l
    LEFT JOIN tipos_frango t ON l.tipo_id = t.id
    WHERE date(l.horario_entrada) = ?
    ORDER BY l.horario_previsto ASC
  `).all(data);
  res.json(lotes);
});

/**
 * POST /api/lotes
 * Registra novo lote no forno.
 * Valida contra estoque de frangos crus — assador não pode ultrapassar,
 * mas admin sim (passa forcar: true no body).
 */
router.post('/', exigirNivel('admin', 'assador'), (req, res) => {
  const { quantidade, tipo_id, observacao, forcar } = req.body;

  if (!quantidade || quantidade <= 0) return res.status(400).json({ erro: 'Quantidade inválida' });
  if (!tipo_id) return res.status(400).json({ erro: 'Tipo obrigatório' });

  const data = hoje();
  const disponivel = calcularDisponivel(data, tipo_id);

  // Bloqueia assador se ultrapassar o estoque de crus
  if (disponivel < quantidade) {
    const tipo = db.prepare('SELECT nome FROM tipos_frango WHERE id = ?').get(tipo_id);
    const nomeTipo = tipo ? tipo.nome : 'selecionado';

    // Admin pode forçar com flag explícita
    if (req.usuario.nivel === 'admin' && forcar) {
      // Prossegue normalmente
    } else if (req.usuario.nivel === 'admin') {
      // Admin recebe aviso mas não forçou ainda
      return res.status(409).json({
        erro: `Estoque insuficiente`,
        detalhe: `Disponível: ${disponivel} frango(s) ${nomeTipo}. Deseja prosseguir mesmo assim?`,
        disponivel,
        requer_confirmacao: true
      });
    } else {
      // Assador é bloqueado
      return res.status(400).json({
        erro: `Estoque insuficiente`,
        detalhe: `Disponível para assar: ${disponivel} frango(s) ${nomeTipo}. Registre mais frangos crus antes de criar este lote.`,
        disponivel
      });
    }
  }

  const entrada = agora();
  const previsto = somarMinutos(entrada, 90);

  db.prepare(
    'INSERT INTO lotes (quantidade, tipo_id, horario_entrada, horario_previsto, usuario_id, observacao) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(quantidade, tipo_id, entrada, previsto, req.usuario.id, observacao || '');

  res.json({ sucesso: true, horario_previsto: previsto, disponivel_restante: disponivel - quantidade });
});

/**
 * PUT /api/lotes/:id/pronto
 * Marca um lote como pronto para entrega.
 */
router.put('/:id/pronto', exigirNivel('admin', 'assador'), (req, res) => {
  const lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(req.params.id);
  if (!lote) return res.status(404).json({ erro: 'Lote não encontrado' });
  db.prepare("UPDATE lotes SET status='pronto' WHERE id=?").run(req.params.id);
  res.json({ sucesso: true });
});

/**
 * PUT /api/lotes/:id/tempo
 * Adiciona minutos extras ao horário previsto de um lote.
 */
router.put('/:id/tempo', exigirNivel('admin', 'assador'), (req, res) => {
  const { minutos_extras } = req.body;
  const lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(req.params.id);
  if (!lote) return res.status(404).json({ erro: 'Lote não encontrado' });
  const novo_previsto = somarMinutos(lote.horario_previsto, minutos_extras);
  db.prepare("UPDATE lotes SET horario_previsto=? WHERE id=?").run(novo_previsto, req.params.id);
  res.json({ sucesso: true, horario_previsto: novo_previsto });
});

/**
 * GET /api/lotes/proximo/:tipo_id
 * Retorna o próximo lote assando para um tipo específico,
 * com horário previsto e minutos restantes.
 * Usado no comprovante de venda para informar o cliente.
 */
router.get('/proximo/:tipo_id', (req, res) => {
  const agr = agora();
  const lote = db.prepare(`
    SELECT l.*, t.nome as tipo_nome FROM lotes l
    LEFT JOIN tipos_frango t ON l.tipo_id = t.id
    WHERE l.status='assando' AND l.tipo_id=? AND l.horario_previsto >= ?
    ORDER BY l.horario_previsto ASC LIMIT 1
  `).get(req.params.tipo_id, agr);

  if (!lote) {
    const pronto = db.prepare(
      "SELECT * FROM lotes WHERE status='pronto' AND tipo_id=? ORDER BY horario_previsto DESC LIMIT 1"
    ).get(req.params.tipo_id);
    if (pronto) return res.json({ status: 'pronto', mensagem: 'Pronto para retirada!' });
    return res.json({ status: 'indisponivel', mensagem: 'Nenhum frango no forno' });
  }

  const p = lote.horario_previsto.replace('T', ' ').split(/[- :]/);
  const prev = new Date(p[0], p[1] - 1, p[2], p[3], p[4], p[5] || 0);
  const diffMin = Math.ceil((prev - new Date()) / 60000);
  const horaFormatada = prev.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  res.json({
    status: 'assando',
    hora_formatada: horaFormatada,
    minutos_restantes: diffMin > 0 ? diffMin : 0,
    lote_id: lote.id
  });
});

module.exports = router;
