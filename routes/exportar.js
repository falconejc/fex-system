/**
 * @file exportar.js
 * @description Rotas para exportação de relatórios em Excel.
 * Gera planilha com abas de vendas, delivery e resumo,
 * com formatação colorida por status.
 */

const express = require('express');
const router = express.Router();
const db = require('../database');
const ExcelJS = require('exceljs');
const { exigirNivel } = require('../auth');

router.get('/excel', exigirNivel('admin', 'dono'), async (req, res) => {
  const ini = req.query.ini || new Date().toISOString().split('T')[0];
  const fim = req.query.fim || new Date().toISOString().split('T')[0];

  const vendas = db.prepare("SELECT * FROM vendas WHERE date(horario_compra) BETWEEN ? AND ? ORDER BY horario_compra ASC").all(ini, fim);
  const delivery = db.prepare("SELECT * FROM delivery WHERE date(horario_pedido) BETWEEN ? AND ? ORDER BY horario_pedido ASC").all(ini, fim);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Frango Expresso';
  wb.created = new Date();

  const estilo = {
    header: { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF59E0B' } }, alignment: { horizontal: 'center' } },
    cancelado: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } } },
    entregue: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } } },
  };

  const ws1 = wb.addWorksheet('Vendas de Frango');
  ws1.columns = [
    { header: 'Código', key: 'codigo', width: 12 },
    { header: 'Tipo', key: 'tipo', width: 16 },
    { header: 'Atendente', key: 'atendente', width: 20 },
    { header: 'Horário Compra', key: 'horario_compra', width: 22 },
    { header: 'Horário Entrega', key: 'horario_entrega', width: 22 },
    { header: 'Status', key: 'status', width: 14 },
  ];
  ws1.getRow(1).eachCell(cell => Object.assign(cell, estilo.header));
  vendas.forEach(v => {
    const row = ws1.addRow({
      codigo: v.codigo,
      tipo: v.tipo === 'simples' ? 'Frango Simples' : 'Frango com Bacon',
      atendente: v.atendente,
      horario_compra: v.horario_compra ? new Date(v.horario_compra).toLocaleString('pt-BR') : '',
      horario_entrega: v.horario_entrega ? new Date(v.horario_entrega).toLocaleString('pt-BR') : '-',
      status: v.status,
    });
    if (v.cancelado) row.eachCell(cell => Object.assign(cell, estilo.cancelado));
    else if (v.status === 'entregue') row.eachCell(cell => Object.assign(cell, estilo.entregue));
  });

  const ws2 = wb.addWorksheet('Delivery');
  ws2.columns = [
    { header: 'Código', key: 'codigo', width: 12 },
    { header: 'Tipo', key: 'tipo', width: 12 },
    { header: 'Cliente', key: 'nome_cliente', width: 24 },
    { header: 'Endereço', key: 'endereco', width: 28 },
    { header: 'Bairro', key: 'bairro', width: 18 },
    { header: 'Pagamento', key: 'pagamento', width: 14 },
    { header: 'Atendente', key: 'atendente', width: 18 },
    { header: 'Horário Pedido', key: 'horario_pedido', width: 22 },
    { header: 'Horário Entrega', key: 'horario_entrega', width: 22 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Descrição', key: 'descricao', width: 36 },
  ];
  ws2.getRow(1).eachCell(cell => Object.assign(cell, estilo.header));
  delivery.forEach(d => {
    const row = ws2.addRow({
      codigo: d.codigo,
      tipo: d.tipo === 'entrega' ? 'Entrega' : 'Retirada',
      nome_cliente: d.nome_cliente,
      endereco: d.endereco ? `${d.endereco}, ${d.numero}` : '',
      bairro: d.bairro || '',
      pagamento: d.pagamento,
      atendente: d.atendente,
      horario_pedido: d.horario_pedido ? new Date(d.horario_pedido).toLocaleString('pt-BR') : '',
      horario_entrega: d.horario_entrega ? new Date(d.horario_entrega).toLocaleString('pt-BR') : '-',
      status: d.status,
      descricao: d.descricao || '',
    });
    if (d.cancelado) row.eachCell(cell => Object.assign(cell, estilo.cancelado));
    else if (d.status === 'entregue') row.eachCell(cell => Object.assign(cell, estilo.entregue));
  });

  const ws3 = wb.addWorksheet('Resumo');
  ws3.columns = [{ header: 'Indicador', key: 'ind', width: 30 }, { header: 'Valor', key: 'val', width: 16 }];
  ws3.getRow(1).eachCell(cell => Object.assign(cell, estilo.header));
  const totalVendas = vendas.length;
  const totalDelivery = delivery.length;
  ws3.addRows([
    { ind: 'Período', val: `${ini} a ${fim}` },
    { ind: 'Total frangos vendidos', val: totalVendas },
    { ind: 'Frangos entregues', val: vendas.filter(v => v.status === 'entregue').length },
    { ind: 'Frangos cancelados', val: vendas.filter(v => v.cancelado).length },
    { ind: 'Frango simples', val: vendas.filter(v => v.tipo === 'simples').length },
    { ind: 'Frango com bacon', val: vendas.filter(v => v.tipo === 'bacon').length },
    { ind: '', val: '' },
    { ind: 'Total pedidos delivery', val: totalDelivery },
    { ind: 'Deliveries entregues', val: delivery.filter(d => d.status === 'entregue').length },
    { ind: 'Deliveries cancelados', val: delivery.filter(d => d.cancelado).length },
    { ind: 'Pagamento Pix', val: delivery.filter(d => d.pagamento === 'pix').length },
    { ind: 'Pagamento Cartão', val: delivery.filter(d => d.pagamento === 'cartao').length },
    { ind: 'Pagamento Dinheiro', val: delivery.filter(d => d.pagamento === 'dinheiro').length },
  ]);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=relatorio-${ini}-${fim}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

module.exports = router;
