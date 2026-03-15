const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rotas
app.use('/api/frango', require('./routes/frango'));
app.use('/api/delivery', require('./routes/delivery'));
app.use('/api/relatorio', require('./routes/relatorio'));

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sistema rodando em http://0.0.0.0:${PORT}`);
});
