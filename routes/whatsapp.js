const express = require('express');
const router = express.Router();
const db = require('../database');

const EVOLUTION_URL = 'http://localhost:8080';
const EVOLUTION_KEY = 'fex-evolution-key-2024';
const INSTANCE = 'frango-expresso';

function formatarTel(t) {
  const digits = t.replace(/\D/g, '');
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  return '55' + digits;
}

router.post('/comprovante/:codigo', async (req, res) => {
  const { telefone } = req.body;
  const venda = db.prepare(`
    SELECT v.*, t.nome as tipo_nome, t.icone as tipo_icone
    FROM vendas v
    LEFT JOIN tipos_frango t ON v.tipo_id = t.id
    WHERE v.codigo = ?
  `).get(req.params.codigo);

  if (!venda) return res.status(404).json({ erro: 'Venda nao encontrada' });

  const tel = telefone || venda.telefone;
  if (!tel) return res.status(400).json({ erro: 'Telefone nao informado' });

  if (!venda.telefone && telefone) {
    db.prepare('UPDATE vendas SET telefone = ? WHERE codigo = ?').run(telefone, req.params.codigo);
  }

  const p = venda.horario_compra.replace('T', ' ').split(/[- :]/);
  const dataCompra = new Date(p[0], p[1]-1, p[2], p[3], p[4], p[5]||0);
  const hora = dataCompra.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const data = dataCompra.toLocaleDateString('pt-BR');
  const icone = venda.tipo_icone || '';

  const mensagem = '*FRANGO EXPRESSO*\n\n'
    + 'Seu pedido foi registrado!\n\n'
    + '*Codigo:* ' + venda.codigo + '\n'
    + '*Produto:* ' + icone + ' ' + (venda.tipo_nome || venda.tipo) + '\n'
    + '*Data:* ' + data + ' as ' + hora + '\n'
    + '*Atendente:* ' + venda.atendente + '\n'
    + (venda.observacao ? '*Obs:* ' + venda.observacao + '\n' : '')
    + '\nApresente este codigo na retirada.';

  try {
    const response = await fetch(EVOLUTION_URL + '/message/sendText/' + INSTANCE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
      body: JSON.stringify({
        number: formatarTel(tel),
        textMessage: { text: mensagem }
      })
    });

    const data_resp = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data_resp));

    await fetch(EVOLUTION_URL + '/message/sendMedia/' + INSTANCE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
      body: JSON.stringify({
        number: formatarTel(tel),
        mediaMessage: {
          mediatype: 'image',
          media: 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + venda.codigo,
          caption: 'QR Code para retirada - Codigo: ' + venda.codigo
        }
      })
    });

    res.json({ sucesso: true });
  } catch(e) {
    res.status(500).json({ erro: 'Erro ao enviar WhatsApp: ' + e.message });
  }
});

module.exports = router;
