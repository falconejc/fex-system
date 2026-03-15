const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirNivel } = require('../auth');

function agora() {
  return new Date().toLocaleString('sv-SE', {timeZone:'America/Sao_Paulo'}).replace('T', ' ');
}

function somarMinutos(dataStr, minutos) {
  const p = dataStr.replace('T',' ').split(/[- :]/);
  const d = new Date(p[0], p[1]-1, p[2], p[3], p[4], p[5]||0);
  d.setMinutes(d.getMinutes() + minutos);
  return d.toLocaleString('sv-SE', {timeZone:'America/Sao_Paulo'}).replace('T', ' ');
}

function hoje() {
  return new Date().toLocaleDateString('pt-BR', {timeZone:'America/Sao_Paulo'}).split('/').reverse().join('-');
}

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

router.post('/', exigirNivel('admin', 'assador'), (req, res) => {
  const { quantidade, tipo_id, observacao } = req.body;
  if (!quantidade || quantidade <= 0) return res.status(400).json({ erro: 'Quantidade inválida' });
  if (!tipo_id) return res.status(400).json({ erro: 'Tipo obrigatório' });
  const entrada = agora();
  const previsto = somarMinutos(entrada, 90);
  db.prepare('INSERT INTO lotes (quantidade, tipo_id, horario_entrada, horario_previsto, usuario_id, observacao) VALUES (?, ?, ?, ?, ?, ?)')
    .run(quantidade, tipo_id, entrada, previsto, req.usuario.id, observacao || '');
  res.json({ sucesso: true, horario_previsto: previsto });
});

router.put('/:id/pronto', exigirNivel('admin', 'assador'), (req, res) => {
  const lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(req.params.id);
  if (!lote) return res.status(404).json({ erro: 'Lote não encontrado' });
  db.prepare("UPDATE lotes SET status='pronto' WHERE id=?").run(req.params.id);
  res.json({ sucesso: true });
});

router.put('/:id/tempo', exigirNivel('admin', 'assador'), (req, res) => {
  const { minutos_extras } = req.body;
  const lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(req.params.id);
  if (!lote) return res.status(404).json({ erro: 'Lote não encontrado' });
  const novo_previsto = somarMinutos(lote.horario_previsto, minutos_extras);
  db.prepare("UPDATE lotes SET horario_previsto=? WHERE id=?").run(novo_previsto, req.params.id);
  res.json({ sucesso: true, horario_previsto: novo_previsto });
});

router.get('/proximo/:tipo_id', (req, res) => {
  const agr = agora();
  const lote = db.prepare(`
    SELECT l.*, t.nome as tipo_nome FROM lotes l
    LEFT JOIN tipos_frango t ON l.tipo_id = t.id
    WHERE l.status='assando' AND l.tipo_id=? AND l.horario_previsto >= ?
    ORDER BY l.horario_previsto ASC LIMIT 1
  `).get(req.params.tipo_id, agr);

  if (!lote) {
    const pronto = db.prepare("SELECT * FROM lotes WHERE status='pronto' AND tipo_id=? ORDER BY horario_previsto DESC LIMIT 1").get(req.params.tipo_id);
    if (pronto) return res.json({ status: 'pronto', mensagem: 'Pronto para retirada!' });
    return res.json({ status: 'indisponivel', mensagem: 'Nenhum frango no forno' });
  }

  const p = lote.horario_previsto.replace('T',' ').split(/[- :]/);
  const prev = new Date(p[0], p[1]-1, p[2], p[3], p[4], p[5]||0);
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
