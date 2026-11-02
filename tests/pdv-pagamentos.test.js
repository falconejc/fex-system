/**
 * @file pdv-pagamentos.test.js
 * @description Fluxo de dinheiro do PDV: venda simples e venda com pagamento
 * dividido entre formas (tudo ou nada) e cancelamento por referência.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, login, api } = require('./helpers/testServer');

let server, cookieAdmin, get, post, tipoId;

before(async () => {
  server = await startTestServer();
  cookieAdmin = await login(server.baseUrl, 'admin', 'admin123');
  get = (caminho) => api(server.baseUrl, cookieAdmin)(caminho);
  post = (caminho, body) => api(server.baseUrl, cookieAdmin)(caminho, { method: 'POST', body });

  await post('/api/tipos', { nome: 'Frango PDV Teste', preco: 20 });
  const todos = await (await get('/api/tipos/todos')).json();
  tipoId = todos.find(t => t.nome === 'Frango PDV Teste').id;
});

after(async () => {
  await server.stop();
});

test('venda simples no PDV registra valor e forma de pagamento', async () => {
  const res = await post('/api/pdv/venda', { descricao: 'Refrigerante', valor: 6, forma_pagamento: 'dinheiro' });
  assert.equal(res.status, 200);
  const venda = await res.json();
  assert.equal(venda.valor, 6);
  assert.equal(venda.forma_pagamento, 'dinheiro');
});

test('venda dividida rejeita quando soma dos pagamentos não bate com o total', async () => {
  const res = await post('/api/pdv/venda-dividida', {
    itens: [{ descricao: 'Suco', valor: 10 }],
    pagamentos: [{ forma_pagamento: 'dinheiro', valor: 5 }]
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).erro, /não bate/);
});

test('venda dividida com item + frango: tudo ou nada, e aparece no relatório do dia', async () => {
  const res = await post('/api/pdv/venda-dividida', {
    itens: [{ descricao: 'Suco', valor: 10 }],
    frango_tipo_ids: [tipoId],
    pagamentos: [
      { forma_pagamento: 'dinheiro', valor: 15 },
      { forma_pagamento: 'pix', valor: 15 }
    ]
  });
  assert.equal(res.status, 200);
  const corpo = await res.json();
  assert.equal(corpo.itens.length, 1);
  assert.equal(corpo.frangos.length, 1);
  assert.ok(corpo.referencia);

  // A ficha de frango da venda dividida segue o mesmo ciclo de baixa das vendas normais.
  const ficha = corpo.frangos[0];
  assert.equal(ficha.status, 'pendente');
  const baixa = await post(`/api/frango/entrega/${ficha.codigo}`);
  assert.equal(baixa.status, 200);
});

test('cancelar venda dividida por referência cancela itens, frangos e pagamentos', async () => {
  const criada = await (await post('/api/pdv/venda-dividida', {
    itens: [{ descricao: 'Água', valor: 4 }],
    pagamentos: [{ forma_pagamento: 'cartao_debito', valor: 4 }]
  })).json();

  const cancelar = await api(server.baseUrl, cookieAdmin)(`/api/pdv/venda-dividida/${criada.referencia}/cancelar`, { method: 'PUT' });
  assert.equal(cancelar.status, 200);

  const cancelarReferenciaInexistente = await api(server.baseUrl, cookieAdmin)('/api/pdv/venda-dividida/NAO-EXISTE/cancelar', { method: 'PUT' });
  assert.equal(cancelarReferenciaInexistente.status, 404);
});
