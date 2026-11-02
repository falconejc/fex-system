/**
 * @file frango-fichas.test.js
 * @description Fluxo de dinheiro: venda de ficha de frango, estoque esgotado,
 * baixa (entrega), cancelamento e detecção de fichas atrasadas sem baixa.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { startTestServer, login, api } = require('./helpers/testServer');

let server, cookieAdmin, get, post, del, tipoId;

before(async () => {
  server = await startTestServer();
  cookieAdmin = await login(server.baseUrl, 'admin', 'admin123');
  get = (caminho) => api(server.baseUrl, cookieAdmin)(caminho);
  post = (caminho, body) => api(server.baseUrl, cookieAdmin)(caminho, { method: 'POST', body });
  del = (caminho) => api(server.baseUrl, cookieAdmin)(caminho, { method: 'DELETE' });

  const resTipo = await post('/api/tipos', { nome: 'Frango Teste', preco: 30 });
  assert.equal(resTipo.status, 200);
  const todos = await (await get('/api/tipos/todos')).json();
  tipoId = todos.find(t => t.nome === 'Frango Teste').id;
});

after(async () => {
  await server.stop();
});

test('registra venda de ficha como pendente', async () => {
  const res = await post('/api/frango/venda', { tipo_id: tipoId });
  const venda = await res.json();
  assert.equal(res.status, 200);
  assert.equal(venda.status, 'pendente');
  assert.ok(venda.codigo);

  const pendentes = await (await get('/api/frango/pendentes')).json();
  assert.ok(pendentes.some(v => v.codigo === venda.codigo));
});

test('dar baixa marca como entregue e bloqueia baixa repetida', async () => {
  const venda = await (await post('/api/frango/venda', { tipo_id: tipoId })).json();

  const baixa = await post(`/api/frango/entrega/${venda.codigo}`);
  assert.equal(baixa.status, 200);

  const repetida = await post(`/api/frango/entrega/${venda.codigo}`);
  assert.equal(repetida.status, 400);
  assert.equal((await repetida.json()).erro, 'Já entregue');
});

test('venda cancelada não pode receber baixa', async () => {
  const venda = await (await post('/api/frango/venda', { tipo_id: tipoId })).json();

  const cancelar = await del(`/api/frango/${venda.id}`);
  assert.equal(cancelar.status, 200);

  const baixa = await post(`/api/frango/entrega/${venda.codigo}`);
  assert.equal(baixa.status, 400);
  assert.equal((await baixa.json()).erro, 'Venda cancelada');
});

test('estoque esgotado bloqueia nova venda do mesmo tipo', async () => {
  const resTipo = await post('/api/tipos', { nome: 'Frango Esgota Rápido', preco: 25 });
  assert.equal(resTipo.status, 200);
  const todos = await (await get('/api/tipos/todos')).json();
  const tipoLimitado = todos.find(t => t.nome === 'Frango Esgota Rápido').id;

  const estoqueRes = await post('/api/estoque', { estoques: [{ tipo_id: tipoLimitado, quantidade: 1 }] });
  assert.equal(estoqueRes.status, 200);

  const primeira = await post('/api/frango/venda', { tipo_id: tipoLimitado });
  assert.equal(primeira.status, 200);

  const segunda = await post('/api/frango/venda', { tipo_id: tipoLimitado });
  assert.equal(segunda.status, 400);
  assert.match((await segunda.json()).erro, /Estoque esgotado/);
});

test('ficha pendente de dia anterior aparece em pendentes-atrasadas e some após a baixa', async () => {
  const venda = await (await post('/api/frango/venda', { tipo_id: tipoId })).json();

  // Simula "virou o dia sem dar baixa": só dá pra voltar a data no banco direto,
  // não existe (nem deveria existir) endpoint que deixe o cliente retroagir a venda.
  const db = new Database(server.dbFile);
  db.prepare("UPDATE vendas SET horario_compra = datetime(horario_compra, '-1 day') WHERE codigo = ?").run(venda.codigo);
  db.close();

  const atrasadas = await (await get('/api/frango/pendentes-atrasadas')).json();
  assert.ok(atrasadas.some(v => v.codigo === venda.codigo), 'ficha atrasada deveria aparecer na lista');

  const baixa = await post(`/api/frango/entrega/${venda.codigo}`);
  assert.equal(baixa.status, 200);

  const atrasadasDepois = await (await get('/api/frango/pendentes-atrasadas')).json();
  assert.ok(!atrasadasDepois.some(v => v.codigo === venda.codigo), 'ficha deveria sair da lista após a baixa');
});
