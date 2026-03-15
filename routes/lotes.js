const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirNivel } = require('../auth');

function agora() {
  return new Date().toLocaleString('sv-SE', {timeZone:'America/Sao_Paulo'}).replace('T', ' ');
}

function somarMinutos(dataStr, minutos) {
  const partes = dataStr.replace('T',' ').split(/[- :]/);
  const d = new Date(partes[0], partes[1]-1, partes[2], partes[3], partes[4], partes[5]||0);
  d.setMinutes(d.getMinutes() + minutos);
  return d.toLocaleString('sv-SE', {timeZone:'America/Sao_Paulo'}).replace('T', ' ');
}

router.get('/ativos', (req, res) => {
  const hoje = new Date().toLocaleDateString('pt-BR', {timeZone:'America/Sao_Paulo'}).split('/').reverse().join('-');
  const lotes = db.prepare("SELECT * FROM lotes WHERE date(horario_entrada) = ? ORDER BY horario_entrada ASC").all(hoje);
  res.json(lotes);
});

router.post('/', exigirNivel('admin', 'assador'), (req, res) => {
  const { quantidade, observacao } = req.body;
  if (!quantidade || quantidade <= 0) return res.status(400).json({ erro: 'Quantidade inválida' });
  const entrada = agora();
  const previsto = somarMinutos(entrada, 90);
  db.prepare('INSERT INTO lotes (quantidade, horario_entrada, horario_previsto, usuario_id, observacao) VALUES (?, ?, ?, ?, ?)')
    .run(quantidade, entrada, previsto, req.usuario.id, observacao || '');
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

router.get('/proximo', (req, res) => {
  const agr = agora();
  const lote = db.prepare("SELECT * FROM lotes WHERE status='assando' AND horario_previsto >= ? ORDER BY horario_previsto ASC LIMIT 1").get(agr);
  if (!lote) {
    const pronto = db.prepare("SELECT * FROM lotes WHERE status='pronto' ORDER BY horario_previsto DESC LIMIT 1").get();
    if (pronto) return res.json({ status: 'pronto', mensagem: 'Frangos prontos para retirada!' });
    return res.json({ status: 'indisponivel', mensagem: 'Nenhum frango no forno no momento' });
  }
  const partes = lote.horario_previsto.replace('T',' ').split(/[- :]/);
  const prev = new Date(partes[0], partes[1]-1, partes[2], partes[3], partes[4], partes[5]||0);
  const now = new Date();
  const diffMin = Math.ceil((prev - now) / 60000);
  const horaFormatada = prev.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  res.json({
    status: 'assando',
    horario_previsto: lote.horario_previsto,
    hora_formatada: horaFormatada,
    minutos_restantes: diffMin,
    lote_id: lote.id
  });
});

module.exports = router;
