const clients = new Set();

function broadcast(event) {
  clients.forEach(res => {
    try { res.write(`data: ${event}\n\n`); } catch(e) { clients.delete(res); }
  });
}

module.exports = { clients, broadcast };
