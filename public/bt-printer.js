const BTPrinter = (() => {
  const SERVICE_UUID        = '000018f0-0000-1000-8000-00805f9b34fb';
  const CHARACTERISTIC_UUID = '00002af1-0000-1000-8000-00805f9b34fb';
  let device = null, characteristic = null;

  const ESC = 0x1B, GS = 0x1D;
  const CMD = {
    INIT:        [ESC, 0x40],
    CENTER:      [ESC, 0x61, 0x01],
    LEFT:        [ESC, 0x61, 0x00],
    BOLD_ON:     [ESC, 0x45, 0x01],
    BOLD_OFF:    [ESC, 0x45, 0x00],
    FONT_LARGE:  [GS,  0x21, 0x11],
    FONT_MEDIUM: [GS,  0x21, 0x10],
    FONT_NORMAL: [GS,  0x21, 0x00],
    FEED:        [ESC, 0x64, 0x04],
    CUT:         [GS,  0x56, 0x42, 0x00],
  };

  function norm(text) {
    const map = {'á':'a','à':'a','â':'a','ã':'a','é':'e','è':'e','ê':'e','í':'i','î':'i','ó':'o','ô':'o','õ':'o','ú':'u','û':'u','ç':'c','ñ':'n','Á':'A','À':'A','Â':'A','Ã':'A','É':'E','Ê':'E','Í':'I','Ó':'O','Ô':'O','Õ':'O','Ú':'U','Ç':'C'};
    return text.replace(/[^\x00-\x7F]/g, c => map[c] || '?');
  }

  function tb(text) { const b=[]; for(let c of norm(text)) b.push(c.charCodeAt(0)); return b; }
  function ln(text='') { return tb(text + '\n'); }
  function div(ch='-', n=32) { return tb(ch.repeat(n) + '\n'); }
  function center(text, w=32) { const p=Math.max(0,Math.floor((w-text.length)/2)); return tb(' '.repeat(p)+text+'\n'); }

  // QR Code via GS k (protocolo alternativo compatível com impressoras baratas)
  function qrCode(data) {
    const bytes = [];
    const d = [];
    for (let i = 0; i < data.length; i++) d.push(data.charCodeAt(i));

    // Método 1: GS k com type QR (fn=0x51)
    // Set QR size
    bytes.push(GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, 0x08);
    // Set error correction L
    bytes.push(GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x30);
    // Store data
    const len = d.length + 3;
    bytes.push(GS, 0x28, 0x6B, len & 0xFF, (len >> 8) & 0xFF, 0x31, 0x50, 0x30);
    d.forEach(b => bytes.push(b));
    // Print
    bytes.push(GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30);

    return bytes;
  }


  function buildComanda(p) {
    const bytes = [];
    const push = arr => arr.forEach(b => bytes.push(b));

    push(CMD.INIT);

    // Cabeçalho
    push(CMD.CENTER); push(CMD.BOLD_ON); push(CMD.FONT_LARGE);
    push(ln('COMANDA'));
    push(CMD.FONT_NORMAL); push(CMD.BOLD_OFF);
    push(CMD.CENTER); push(CMD.BOLD_ON);
    push(ln(p.tipo === 'entrega' ? '*** ENTREGA ***' : '*** RETIRADA ***'));
    push(CMD.BOLD_OFF);
    push(div());

    // Código grande
    push(CMD.CENTER); push(ln('Codigo:'));
    push(CMD.BOLD_ON); push(CMD.FONT_LARGE);
    push(ln(p.codigo));
    push(CMD.FONT_NORMAL); push(CMD.BOLD_OFF);
    push(div());

    // Dados
    push(CMD.LEFT);
    const hora = new Date(p.horario_pedido).toLocaleTimeString('pt-BR');
    const data = new Date(p.horario_pedido).toLocaleDateString('pt-BR');
    push(ln('Data: '+data+'  Hora: '+hora));
    push(ln('Atendente: '+(p.atendente||'')));
    push(ln('Cliente: '+(p.nome_cliente||'')));

    if (p.tipo === 'entrega') {
      push(ln('End: '+(p.endereco||'')+', '+(p.numero||'')));
      push(ln('Bairro: '+(p.bairro||'')));
      if (p.referencia) push(ln('Ref: '+p.referencia));
    } else {
      push(CMD.CENTER); push(CMD.BOLD_ON);
      push(ln('** RETIRADA NO LOCAL **'));
      push(CMD.BOLD_OFF); push(CMD.LEFT);
    }

    const pagLabels = { pix:'Pix', cartao:'Cartao', dinheiro:'Dinheiro' };
    push(ln('Pagamento: '+(pagLabels[p.pagamento]||p.pagamento||'')));
    push(div());

    // Descrição
    push(CMD.LEFT); push(CMD.BOLD_ON); push(ln('Descricao:')); push(CMD.BOLD_OFF);
    push(ln(p.descricao||''));
    push(div());
    push(CMD.CENTER); push(ln('Sistema de Vendas'));
    push(CMD.FEED); push(CMD.CUT);

    return new Uint8Array(bytes);
  }

  function buildComprovante(venda, loteInfo) {
    const bytes = [];
    const p = arr => arr.forEach(b => bytes.push(b));

    p(CMD.INIT);

    // Cabeçalho
    p(CMD.CENTER); p(CMD.BOLD_ON); p(CMD.FONT_LARGE);
    p(ln('FRANGO EXPRESSO'));
    p(CMD.FONT_NORMAL); p(CMD.BOLD_OFF);
    p(div());

    // Dados da venda
    const dt = venda.horario_compra.replace('T',' ').split(/[- :]/);
    const dc = new Date(dt[0],dt[1]-1,dt[2],dt[3],dt[4],dt[5]||0);
    p(CMD.LEFT);
    p(ln('Data: '+dc.toLocaleDateString('pt-BR')+'  Hora: '+dc.toLocaleTimeString('pt-BR')));
    p(ln('Atendente: '+(venda.atendente||'')));
    p(ln('Produto: Frango Assado '+(venda.tipo_nome||venda.tipo||'')));
    if (venda.observacao) p(ln('Obs: '+venda.observacao));
    p(div());

    // Código centralizado
    p(CMD.CENTER);
    p(ln('Seu codigo:'));
    p(CMD.BOLD_ON); p(CMD.FONT_LARGE);
    p(ln(venda.codigo));
    p(CMD.FONT_NORMAL); p(CMD.BOLD_OFF);
    p(ln(''));
    // QR Code nativo
    p(CMD.CENTER);
    p(qrCode(venda.codigo));
    p(ln(''));
    p(div());

    // Previsão
    if (loteInfo && loteInfo.status === 'assando') {
      p(CMD.CENTER); p(CMD.BOLD_ON); p(ln('PREVISAO DE RETIRADA')); p(CMD.BOLD_OFF);
      p(center('As '+loteInfo.hora_formatada+' (~'+loteInfo.minutos_restantes+' min)'));
    } else {
      p(CMD.CENTER); p(CMD.BOLD_ON); p(center('Frango pronto para retirada!')); p(CMD.BOLD_OFF);
    }
    p(div());

    // Aviso
    const dom = new Date().getDay()===0;
    p(CMD.CENTER); p(CMD.BOLD_ON); p(ln('** ATENCAO **')); p(CMD.BOLD_OFF);
    p(center('Retire seu frango hoje.'));
    p(center((dom?'Domingo':'Dia de semana')+': ate as '+(dom?'13:45':'18:30')));
    p(center('Nao nos responsabilizamos'));
    p(center('por retiradas fora do prazo.'));
    p(div());

    p(CMD.CENTER);
    p(ln('Guarde este comprovante'));
    p(center('Apresente na retirada'));
    p(CMD.FEED); p(CMD.CUT);

    return new Uint8Array(bytes);
  }

  async function sendBytes(data) {
    const CHUNK = 100;
    for (let i = 0; i < data.length; i += CHUNK) {
      await characteristic.writeValue(data.slice(i, i + CHUNK));
      await new Promise(r => setTimeout(r, 30));
    }
  }

  async function connect() {
    if (!navigator.bluetooth) { alert('Web Bluetooth nao suportado.\nUse o Chrome no Android.'); return false; }
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID]
      });
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
      device.addEventListener('gattserverdisconnected', () => { device=null; characteristic=null; updateUI(false); });
      updateUI(true);
      return true;
    } catch(e) {
      if (e.name !== 'NotFoundError') alert('Erro BT: '+e.message);
      return false;
    }
  }

  function disconnect() {
    if (device && device.gatt.connected) device.gatt.disconnect();
    device=null; characteristic=null; updateUI(false);
  }

  function updateUI(connected) {
    const btnConn  = document.getElementById('btn-bt-connect');
    const btnPrint = document.getElementById('btn-bt-print');
    if (btnConn)  { btnConn.textContent  = connected ? '🔵 BT Conectado' : '🔌 Conectar Impressora BT'; btnConn.style.background = connected ? '#1d4ed8' : '#6b7280'; }
    if (btnPrint) { btnPrint.style.display = connected ? 'block' : 'none'; }
  }

  async function printComanda(pedido) {
    if (!characteristic) { alert('Impressora BT nao conectada.'); return false; }
    try { await sendBytes(buildComanda(pedido)); return true; }
    catch(e) { alert('Erro ao imprimir: '+e.message); return false; }
  }

  async function printComprovante(venda, loteInfo) {
    if (!characteristic) { alert('Impressora BT nao conectada.\nClique em "Conectar Impressora BT" primeiro.'); return false; }
    try { await sendBytes(buildComprovante(venda, loteInfo)); return true; }
    catch(e) { alert('Erro ao imprimir: '+e.message); return false; }
  }

  function isConnected() { return !!(device && device.gatt.connected && characteristic); }
  return { connect, disconnect, printComprovante, printComanda, isConnected, updateUI };
})();
