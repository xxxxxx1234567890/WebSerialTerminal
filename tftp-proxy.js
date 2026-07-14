const { WebSocketServer } = require('ws');
const dgram = require('dgram');

const WS_PORT = 52345;
const SOCKET_TIMEOUT = 3000;
const MAX_RETRIES = 4;
const BLOCK_SIZE = 512;

const wss = new WebSocketServer({ port: WS_PORT });
console.log('[TFTP Proxy] WebSocket server on port', WS_PORT);

let activeCleanup = null;

wss.on('connection', (ws) => {
  console.log('[TFTP Proxy] Client connected');

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log('[TFTP Proxy] Received:', msg.type);

      if (msg.type === 'upload') {
        if (activeCleanup) {
          ws.send(JSON.stringify({ type: 'error', message: 'Upload already in progress' }));
          return;
        }
        await handleUpload(ws, msg.addr, msg.port || 69, msg.filename, msg.data);
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown command: ' + msg.type }));
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  ws.on('close', () => {
    console.log('[TFTP Proxy] Client disconnected');
    if (activeCleanup) {
      activeCleanup();
      activeCleanup = null;
    }
  });
});

async function handleUpload(ws, addr, port, filename, base64Data) {
  const buf = Buffer.from(base64Data, 'base64');
  let blockNum = 1;
  let offset = 0;
  const socket = dgram.createSocket('udp4');

  let timeoutId;
  let retries = 0;
  let lastPacket = null;
  let lastPort = port;
  let lastAddr = addr;
  let transferDone = false;

  const cleanup = () => {
    clearTimeout(timeoutId);
    try { socket.close(); } catch(e) {}
    if (activeCleanup === cleanup) activeCleanup = null;
  };
  activeCleanup = cleanup;

  const setTimer = () => {
    clearTimeout(timeoutId);
    retries++;
    if (retries > MAX_RETRIES) {
      ws.send(JSON.stringify({ type: 'error', message: 'Timeout (max retries) for block ' + blockNum }));
      cleanup();
      return;
    }
    timeoutId = setTimeout(() => {
      if (lastPacket) {
        socket.send(lastPacket, lastPort, lastAddr);
        setTimer();
      }
    }, SOCKET_TIMEOUT);
  };

  // Send WRQ to TFTP well-known port
  const wrq = buildWRQ(filename, 'octet');
  lastPacket = wrq;
  socket.send(wrq, port, addr);
  retries = 0;
  setTimer();

  socket.on('message', (resp, rinfo) => {
    // TFTP servers use port-hopping: capture the response port for subsequent sends
    if (rinfo) {
      lastPort = rinfo.port;
      lastAddr = rinfo.address;
    }

    const opcode = resp.readUInt16BE(0);
    if (opcode === 4) {
      // ACK received
      const ackBlock = resp.readUInt16BE(2);

      if (ackBlock === (blockNum - 1) || (ackBlock === 0 && blockNum === 1)) {
        retries = 0;

        // If we already sent the last block, this ACK confirms it — complete
        if (transferDone) {
          ws.send(JSON.stringify({ type: 'complete', filename }));
          cleanup();
          return;
        }

        // Send next data block
        const chunk = offset < buf.length ? buf.slice(offset, offset + BLOCK_SIZE) : Buffer.alloc(0);

        // Always send data block (including empty terminator for exact multiples of 512)
        const dataPkt = buildData(blockNum, chunk);
        lastPacket = dataPkt;
        socket.send(dataPkt, lastPort, lastAddr);
        ws.send(JSON.stringify({ type: 'progress', sent: Math.min(offset + BLOCK_SIZE, buf.length), total: buf.length }));
        offset += BLOCK_SIZE;
        blockNum++;
        setTimer();

        // If chunk was smaller than BLOCK_SIZE (or empty terminator), wait for ACK before completing
        if (chunk.length < BLOCK_SIZE) {
          transferDone = true;
        }
      }
    } else if (opcode === 5) {
      // ERROR
      const errMsg = resp.length > 4 ? resp.slice(4).toString('utf-8').replace(/\0/g, '') : 'Unknown error';
      ws.send(JSON.stringify({ type: 'error', message: 'TFTP Error: ' + errMsg }));
      cleanup();
    }
  });

  socket.on('error', (e) => {
    ws.send(JSON.stringify({ type: 'error', message: 'Socket error: ' + e.message }));
    cleanup();
  });
}

function buildWRQ(filename, mode) {
  const fnBuf = Buffer.from(filename, 'utf-8');
  const modeBuf = Buffer.from(mode, 'ascii');
  const buf = Buffer.alloc(2 + fnBuf.length + 1 + modeBuf.length + 1);
  buf.writeUInt16BE(2, 0); // WRQ opcode
  fnBuf.copy(buf, 2);
  buf[2 + fnBuf.length] = 0;
  modeBuf.copy(buf, 2 + fnBuf.length + 1);
  buf[buf.length - 1] = 0;
  return buf;
}

function buildData(blockNum, data) {
  const buf = Buffer.alloc(4 + data.length);
  buf.writeUInt16BE(3, 0); // DATA opcode
  buf.writeUInt16BE(blockNum & 0xFFFF, 2);
  data.copy(buf, 4);
  return buf;
}
