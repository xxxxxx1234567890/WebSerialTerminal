# Modbus RTU Debug Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Modbus RTU debug panel to the right sidebar of WebTerm Pro, supporting 8 standard function codes with request builder, response parsing, and multi-format data display.

**Architecture:** Single-file addition to `WebSerialTerminal.html`. CSS (~100 lines) adds Modbus-specific styles. HTML (~50 lines) adds the tool section. JavaScript (~250 lines) adds frame construction, CRC16, response parsing, and log management. Reuses existing serial writer/reader infrastructure.

**Tech Stack:** Vanilla HTML/CSS/JS (single file), Web Serial API, no dependencies.

---

### Task 1: CRC16 Utility Functions

**Files:**
- Modify: `D:\Claude WorkSpace\Web Terminal\WebSerialTerminal.html` (add JS functions before existing code)

- [ ] **Step 1: Write the CRC16 test code (inline comment/test)**

```javascript
// Modbus CRC16 test vectors:
// CRC16([0x01,0x03,0x00,0x00,0x00,0x0A]) = 0xCDC5 → [0xC5,0xCD]
// CRC16([0x01,0x06,0x00,0x01,0x00,0x03]) = 0x0B98 → [0x98,0x0B]
// CRC16([0x11,0x03,0x00,0x6B,0x00,0x03]) = 0x8776 → [0x76,0x87]
```

- [ ] **Step 2: Implement `modbusCRC16(data)` function**

```javascript
function modbusCRC16(data) {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x0001) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc = crc >> 1;
      }
    }
  }
  // Little-endian output
  return new Uint8Array([crc & 0xFF, (crc >> 8) & 0xFF]);
}
```

- [ ] **Step 3: Verify CRC16 with test vectors**

- [ ] **Step 4: Commit**

### Task 2: Modbus Frame Construction and Sending

**Files:**
- Modify: `D:\Claude WorkSpace\Web Terminal\WebSerialTerminal.html`
- Add: `modbusConstructFrame()`, `modbusSend()` functions

- [ ] **Step 1: Implement `modbusConstructFrame(slaveId, funcCode, address, quantity, data)`**

```javascript
function modbusConstructFrame(slaveId, funcCode, address, quantity, writeData) {
  const buffer = [];
  buffer.push(slaveId);
  buffer.push(funcCode);
  buffer.push((address >> 8) & 0xFF);
  buffer.push(address & 0xFF);
  
  // Write function codes (05, 06, 15, 16) need data in PDU
  // Read function codes (01, 02, 03, 04) need quantity
  if (funcCode === 1 || funcCode === 2 || funcCode === 3 || funcCode === 4) {
    buffer.push((quantity >> 8) & 0xFF);
    buffer.push(quantity & 0xFF);
  } else if (funcCode === 5) {
    // Write Single Coil: value 0xFF00 (ON) or 0x0000 (OFF)
    buffer.push((writeData >> 8) & 0xFF);
    buffer.push(writeData & 0xFF);
  } else if (funcCode === 6) {
    // Write Single Register
    buffer.push((writeData >> 8) & 0xFF);
    buffer.push(writeData & 0xFF);
  } else if (funcCode === 15) {
    // Write Multiple Coils
    buffer.push((quantity >> 8) & 0xFF);
    buffer.push(quantity & 0xFF);
    const byteCount = Math.ceil(quantity / 8);
    buffer.push(byteCount);
    // writeData is a Uint8Array of coil bytes
    for (let i = 0; i < byteCount; i++) buffer.push(writeData[i]);
  } else if (funcCode === 16) {
    // Write Multiple Registers
    buffer.push((quantity >> 8) & 0xFF);
    buffer.push(quantity & 0xFF);
    const byteCount = quantity * 2;
    buffer.push(byteCount);
    // writeData is a Uint8Array of register bytes
    for (let i = 0; i < byteCount; i++) buffer.push(writeData[i]);
  }
  
  const data = new Uint8Array(buffer);
  const crc = modbusCRC16(data);
  const frame = new Uint8Array(buffer.length + 2);
  frame.set(data);
  frame[data.length] = crc[0];
  frame[data.length + 1] = crc[1];
  return frame;
}
```

- [ ] **Step 3: Implement `modbusSend()` — reads UI fields, constructs frame, sends via writer**

```javascript
function modbusSend() {
  if (!isConnected) { appendLine('[Modbus] 未连接串口', 'error'); return; }
  
  const slaveId = parseInt(document.getElementById('mbSlaveId').value);
  const funcCode = parseInt(document.getElementById('mbFuncCode').value);
  const address = modbusParseAddress();
  const quantity = parseInt(document.getElementById('mbQuantity').value);
  
  // Validate
  if (isNaN(slaveId) || slaveId < 1 || slaveId > 247) {
    appendLine('[Modbus] 从站 ID 无效 (1-247)', 'error'); return;
  }
  // ... more validation
  
  const frame = modbusConstructFrame(slaveId, funcCode, address, quantity, writeData);
  
  // Send via serial writer
  writer.write(frame).then(() => {
    // Show TX frame
    modbusShowTx(frame);
    // Start response timeout
    modbusStartWait(frame);
  }).catch(err => {
    appendLine('[Modbus] 发送失败: ' + err.message, 'error');
  });
}
```

- [ ] **Step 4: Commit**

### Task 3: Modbus Response Parser

**Files:**
- Modify: `D:\Claude WorkSpace\Web Terminal\WebSerialTerminal.html`
- Add: `modbusParseResponse()`, response buffer logic, timeout handling

- [ ] **Step 1: Implement response buffer and parser**

```javascript
// Global state
let modbusResponseBuffer = [];
let modbusPendingRequest = null;
let modbusPendingTimeout = null;

// Called from readLoop when data arrives
function modbusFeedResponse(bytes) {
  if (!modbusPendingRequest) return;
  for (let i = 0; i < bytes.length; i++) {
    modbusResponseBuffer.push(bytes[i]);
  }
  const result = modbusTryParseResponse();
  if (result) {
    modbusPendingRequest = null;
    clearTimeout(modbusPendingTimeout);
    modbusShowRx(result);
  }
}

function modbusTryParseResponse() {
  const buf = modbusResponseBuffer;
  if (buf.length < 5) return null; // Minimum RTU frame (addr+FC+data+CRC)
  
  const slaveId = buf[0];
  const funcCode = buf[1];
  
  // Check if exception response
  if (funcCode & 0x80) {
    if (buf.length >= 5) {
      const crc = modbusCRC16(new Uint8Array(buf.slice(0, -2)));
      if (crc[0] === buf[buf.length-2] && crc[1] === buf[buf.length-1]) {
        return { type: 'exception', slaveId, funcCode: funcCode & 0x7F, exceptionCode: buf[2], raw: new Uint8Array(buf) };
      }
    }
    return null;
  }
  
  // Determine expected length based on function code
  let expectedLen = -1;
  if (funcCode === 1 || funcCode === 2) {
    if (buf.length >= 3) expectedLen = 3 + 2 + buf[2]; // addr + FC + byteCount + data + CRC
  } else if (funcCode === 3 || funcCode === 4) {
    if (buf.length >= 3) expectedLen = 3 + 2 + buf[2];
  } else if (funcCode === 5 || funcCode === 6) {
    expectedLen = 8; // addr + FC + addr(2) + value(2) + CRC(2)
  } else if (funcCode === 15 || funcCode === 16) {
    expectedLen = 8; // addr + FC + addr(2) + quantity(2) + CRC(2)
  }
  
  if (expectedLen < 0 || buf.length < expectedLen) return null;
  
  // Verify CRC
  const crc = modbusCRC16(new Uint8Array(buf.slice(0, -2)));
  if (crc[0] !== buf[expectedLen-2] || crc[1] !== buf[expectedLen-1]) {
    return { type: 'crc_error', raw: new Uint8Array(buf) };
  }
  
  // Parse PDU
  const pdu = new Uint8Array(buf.slice(1, expectedLen - 2));
  return { type: 'success', slaveId, funcCode, pdu, raw: new Uint8Array(buf.slice(0, expectedLen)) };
}
```

- [ ] **Step 2: Implement response timeout (500ms)**

```javascript
function modbusStartWait(frame) {
  modbusPendingRequest = frame;
  modbusResponseBuffer = [];
  modbusPendingTimeout = setTimeout(() => {
    modbusPendingRequest = null;
    modbusResponseBuffer = [];
    modbusShowTimeout();
  }, 500);
}
```

- [ ] **Step 3: Implement register value parsing (HEX/U16/I16/F32)**

```javascript
function modbusParseRegisters(pdu, funcCode) {
  if (funcCode === 3 || funcCode === 4) {
    const byteCount = pdu[0];
    const registers = [];
    for (let i = 0; i < byteCount; i += 2) {
      const hi = pdu[1 + i];
      const lo = pdu[2 + i];
      const u16 = (hi << 8) | lo;
      const i16 = (hi << 8) | lo;
      const hex = hi.toString(16).padStart(2,'0') + ' ' + lo.toString(16).padStart(2,'0');
      registers.push({ hex, u16, i16: (i16 & 0x8000) ? i16 - 0x10000 : i16 });
    }
    // F32 pairs
    const f32Values = [];
    for (let i = 0; i + 3 < byteCount; i += 4) {
      const view = new DataView(new Uint8Array([pdu[1+i], pdu[2+i], pdu[3+i], pdu[4+i]]).buffer);
      f32Values.push(view.getFloat32(0, true)); // little-endian
    }
    return { registers, f32Values };
  }
  // ... coil parsing for FC 01/02
}
```

- [ ] **Step 4: Commit**

### Task 4: HTML/CSS for the Modbus Tool Panel

**Files:**
- Modify: `D:\Claude WorkSpace\Web Terminal\WebSerialTerminal.html`

- [ ] **Step 1: Add CSS styles** (in the `<style>` block)

```css
/* Modbus RTU Debug */
.modbus-frame { font-family: var(--font-mono); font-size: 11px; padding: 6px 8px; border-radius: 4px; margin-bottom: 6px; word-break: break-all; line-height: 1.5; }
.modbus-frame-tx { background: rgba(0,180,255,0.08); border-left: 2px solid var(--accent); }
.modbus-frame-rx { background: rgba(0,255,136,0.08); border-left: 2px solid var(--green); }
.modbus-frame-error { background: rgba(255,50,80,0.08); border-left: 2px solid var(--red); }
.modbus-crc { color: var(--amber); }
.modbus-timestamp { font-size: 9px; color: var(--text-dim); font-family: var(--font-ui); }
.modbus-response-time { font-size: 9px; color: var(--text-secondary); font-family: var(--font-ui); }
.modbus-reg-table { width: 100%; border-collapse: collapse; font-size: 10px; font-family: var(--font-mono); }
.modbus-reg-table th { text-align: left; color: var(--text-dim); padding: 2px 4px; border-bottom: 1px solid var(--border); font-family: var(--font-ui); font-size: 9px; letter-spacing: 0.5px; }
.modbus-reg-table td { padding: 2px 4px; border-bottom: 1px solid rgba(26,58,92,0.3); }
.modbus-reg-table tr:nth-child(even) { background: rgba(0,0,0,0.15); }
.modbus-coil-container { display: flex; gap: 3px; flex-wrap: wrap; padding: 4px; }
.modbus-coil-bit { width: 22px; height: 22px; border-radius: 3px; display: flex; align-items: center; justify-content: center; font-size: 9px; font-weight: bold; border: 1px solid var(--border); }
.modbus-coil-on { background: var(--green); color: #000; border-color: var(--green); }
.modbus-coil-off { background: var(--bg-elevated); color: var(--text-dim); }
.modbus-log-list { max-height: 160px; overflow-y: auto; font-size: 10px; }
.modbus-log-entry { display: grid; grid-template-columns: 50px 1fr 40px; gap: 4px; padding: 3px 4px; border-bottom: 1px solid rgba(26,58,92,0.2); }
.modbus-log-entry:hover { background: rgba(0,180,255,0.05); }
.modbus-log-time { color: var(--text-dim); }
.modbus-log-desc { font-family: var(--font-mono); }
.modbus-log-status { text-align: center; }
.modbus-log-ok { color: var(--green); }
.modbus-log-err { color: var(--red); }
.modbus-log-warn { color: var(--amber); }
.modbus-tabs { display: flex; border-bottom: 1px solid var(--border); margin-bottom: 6px; }
.modbus-tab { padding: 4px 10px; font-size: 10px; color: var(--text-dim); cursor: pointer; border-bottom: 2px solid transparent; user-select: none; }
.modbus-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.modbus-tab:hover { color: var(--text-primary); }
```

- [ ] **Step 2: Add HTML structure** (in the right sidebar, after TFTP section)

```html
<!-- Modbus RTU Debug -->
<div class="tool-section">
  <div class="tool-header" onclick="toggleTool('modbus')">
    <span>◈ Modbus RTU 调试</span>
    <span class="tool-arrow" id="arrowModbus">▶</span>
  </div>
  <div class="tool-body" id="toolModbus" style="display:none">
    <!-- Slave ID + Function Code -->
    <div class="tool-field">
      <div class="tool-label">从站 ID</div>
      <div style="display:flex; gap:4px;">
        <input type="number" class="tool-input" id="mbSlaveId" value="1" min="1" max="247" style="width:60px; text-align:center;">
        <select class="tool-select" id="mbFuncCode" style="flex:1;">
          <option value="1">01 - Read Coils</option>
          <option value="2">02 - Read Discrete Inputs</option>
          <option value="3" selected>03 - Read Holding Registers</option>
          <option value="4">04 - Read Input Registers</option>
          <option value="5">05 - Write Single Coil</option>
          <option value="6">06 - Write Single Register</option>
          <option value="15">15 (0F) - Write Multiple Coils</option>
          <option value="16">16 (10) - Write Multiple Registers</option>
        </select>
      </div>
    </div>
    <!-- Address + Quantity -->
    <div class="tool-field">
      <div style="display:flex; gap:4px;">
        <div style="flex:1;">
          <div class="tool-label">起始地址</div>
          <input type="text" class="tool-input" id="mbAddress" value="0" placeholder="0">
        </div>
        <div style="flex:0 0 70px;">
          <div class="tool-label">数量</div>
          <input type="number" class="tool-input" id="mbQuantity" value="10" min="1" max="2000" style="width:100%; text-align:center;">
        </div>
      </div>
    </div>
    <!-- Write Data (only for write FCs) -->
    <div class="tool-field" id="mbWriteDataField" style="display:none;">
      <div class="tool-label">写入数据 (HEX)</div>
      <input type="text" class="tool-input" id="mbWriteData" placeholder="00 FF 00 01 ..." style="width:100%;">
    </div>
    <!-- Address format toggle + Send -->
    <div class="tool-field">
      <div style="display:flex; gap:4px; align-items:flex-end;">
        <button class="tool-btn primary" id="mbSendBtn" onclick="modbusSend()" style="flex:1;">▶ 发送</button>
        <label class="toggle-switch" style="flex-shrink:0;">
          <span class="toggle-label active" id="mbAddrDecLabel">DEC</span>
          <span class="toggle-track">
            <span class="toggle-thumb"></span>
          </span>
          <span class="toggle-label" id="mbAddrHexLabel">HEX</span>
          <input type="checkbox" id="mbAddrMode" onchange="modbusToggleAddrMode()" hidden>
        </label>
      </div>
    </div>
    <!-- TX/RX Frame Display -->
    <div id="modbusTxDisplay" style="display:none;"></div>
    <div id="modbusRxDisplay" style="display:none;"></div>
    <!-- Response Data (registers/coils) -->
    <div id="modbusDataDisplay" style="display:none;"></div>
    <!-- Log -->
    <div class="tool-divider"></div>
    <div class="modbus-tabs">
      <div class="modbus-tab active" onclick="modbusSwitchTab('req')">请求</div>
      <div class="modbus-tab" onclick="modbusSwitchTab('log')">日志</div>
    </div>
    <div id="modbusLogPanel">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
        <span style="font-size:10px; color:var(--text-dim);" id="modbusLogCount">0 条记录</span>
        <button class="tool-btn" style="font-size:9px; padding:2px 8px;" onclick="modbusClearLog()">清空</button>
      </div>
      <div class="modbus-log-list" id="modbusLogList"></div>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Commit**

### Task 5: JS Logic — Send, Parse, Display, Log

**Files:**
- Modify: `D:\Claude WorkSpace\Web Terminal\WebSerialTerminal.html`
- Add all Modbus tool JS functions

- [ ] **Step 1: Implement `modbusSend()` — full version with validation and UI integration**

```javascript
function modbusSend() {
  if (!isConnected) {
    appendLine('[Modbus] 未连接串口', 'error');
    return;
  }
  
  const slaveId = parseInt(document.getElementById('mbSlaveId').value);
  const funcCode = parseInt(document.getElementById('mbFuncCode').value);
  const quantity = parseInt(document.getElementById('mbQuantity').value);
  
  // Validate
  if (isNaN(slaveId) || slaveId < 1 || slaveId > 247) {
    appendLine('[Modbus] 从站 ID 必须在 1-247 之间', 'error');
    return;
  }
  if (isNaN(quantity) || quantity < 1 || quantity > 2000) {
    appendLine('[Modbus] 数量必须在 1-2000 之间', 'error');
    return;
  }
  
  let address = modbusParseAddress();
  if (address < 0 || address > 65535) {
    appendLine('[Modbus] 地址无效 (0-65535)', 'error');
    return;
  }
  
  let writeData = null;
  if (funcCode === 5 || funcCode === 6 || funcCode === 15 || funcCode === 16) {
    writeData = modbusParseWriteData(funcCode, quantity);
    if (writeData === null) return;
  }
  
  const frame = modbusConstructFrame(slaveId, funcCode, address, quantity, writeData);
  
  // Show TX frame
  modbusShowTx(frame);
  modbusAddLog(frame, null);
  
  writer.write(frame).then(() => {
    modbusStartWait(frame);
  }).catch(err => {
    appendLine('[Modbus] 发送失败: ' + err.message, 'error');
    modbusPendingRequest = null;
  });
}
```

- [ ] **Step 2: Implement display functions**

```javascript
function modbusShowTx(frame) {
  const hex = Array.from(frame).map(b => b.toString(16).padStart(2,'0')).join(' ');
  const crcIdx = frame.length - 2;
  const html = hex.substring(0, crcIdx * 3) +
    '<span class="modbus-crc">' + hex.substring(crcIdx * 3) + '</span>';
  
  const div = document.getElementById('modbusTxDisplay');
  div.style.display = 'block';
  div.innerHTML = '<div class="modbus-frame modbus-frame-tx"><span style="color:var(--accent);font-weight:bold;">TX →</span> <span class="modbus-timestamp">' +
    new Date().toLocaleTimeString() + '</span><br>' + html + '<br><span class="modbus-response-time">CRC16: 0x' +
    frame[frame.length-2].toString(16).padStart(2,'0').toUpperCase() +
    frame[frame.length-1].toString(16).padStart(2,'0').toUpperCase() + ' ✓</span></div>';
}

function modbusShowTimeout() {
  const div = document.getElementById('modbusRxDisplay');
  div.style.display = 'block';
  div.innerHTML = '<div class="modbus-frame modbus-frame-error"><span style="color:var(--red);font-weight:bold;">RX ←</span> 响应超时 (500ms)</div>';
  modbusAddLog(null, { type: 'timeout' });
}

function modbusShowRx(result) {
  const rxDiv = document.getElementById('modbusRxDisplay');
  rxDiv.style.display = 'block';
  const dataDiv = document.getElementById('modbusDataDisplay');
  
  if (result.type === 'crc_error') {
    rxDiv.innerHTML = '<div class="modbus-frame modbus-frame-error">' +
      '<span style="color:var(--red);font-weight:bold;">RX ←</span> <span class="modbus-timestamp">' +
      new Date().toLocaleTimeString() + '</span><br>CRC 校验失败</div>';
    modbusAddLog(null, { type: 'crc_error' });
    return;
  }
  
  if (result.type === 'exception') {
    const codes = {
      1: '非法功能码', 2: '非法数据地址', 3: '非法数据值',
      4: '从站设备故障', 5: '确认', 6: '从站设备忙',
      8: '存储奇偶性错误', 10: '网关路径不可用', 11: '网关目标无响应'
    };
    const desc = codes[result.exceptionCode] || '未知异常 (' + result.exceptionCode + ')';
    rxDiv.innerHTML = '<div class="modbus-frame modbus-frame-error">' +
      '<span style="color:var(--red);font-weight:bold;">RX ←</span> <span class="modbus-timestamp">' +
      new Date().toLocaleTimeString() + '</span><br>' +
      '<span style="color:var(--red);">异常响应: ' + desc + '</span></div>';
    modbusAddLog(null, { type: 'exception', code: result.exceptionCode, desc });
    return;
  }
  
  // Success
  const hex = Array.from(result.raw).map(b => b.toString(16).padStart(2,'0')).join(' ');
  rxDiv.innerHTML = '<div class="modbus-frame modbus-frame-rx">' +
    '<span style="color:var(--green);font-weight:bold;">RX ←</span> <span class="modbus-timestamp">' +
    new Date().toLocaleTimeString() + '</span>' +
    '<span class="modbus-response-time" style="float:right;">' + modbusCalcResponseTime() + '</span><br>' + hex + '</div>';
  
  modbusAddLog(null, { type: 'success' });
  modbusShowParsedData(result);
}

function modbusShowParsedData(result) {
  const dataDiv = document.getElementById('modbusDataDisplay');
  dataDiv.style.display = 'block';
  
  if (result.funcCode === 1 || result.funcCode === 2) {
    // Coil display
    const byteCount = result.pdu[0];
    let bits = '';
    for (let i = 0; i < byteCount; i++) {
      for (let b = 0; b < 8; b++) {
        const on = (result.pdu[1 + i] >> b) & 1;
        bits += '<div class="modbus-coil-bit ' + (on ? 'modbus-coil-on' : 'modbus-coil-off') + '">' + on + '</div>';
      }
    }
    dataDiv.innerHTML = '<div class="modbus-coil-container">' + bits + '</div>';
  } else if (result.funcCode === 3 || result.funcCode === 4) {
    // Register display
    const byteCount = result.pdu[0];
    let table = '<table class="modbus-reg-table"><tr><th>地址</th><th>HEX</th><th>U16</th><th>I16</th><th>F32</th></tr>';
    let f32Idx = 0;
    for (let i = 0; i + 1 < byteCount; i += 2) {
      const hi = result.pdu[1 + i];
      const lo = result.pdu[2 + i];
      const u16 = (hi << 8) | lo;
      const i16 = (u16 & 0x8000) ? u16 - 0x10000 : u16;
      const hexStr = hi.toString(16).padStart(2,'0') + ' ' + lo.toString(16).padStart(2,'0');
      
      let f32Str = '—';
      if (f32Idx * 4 + 4 <= byteCount) {
        const idx = 1 + f32Idx * 4;
        const view = new DataView(new Uint8Array([result.pdu[idx], result.pdu[idx+1], result.pdu[idx+2], result.pdu[idx+3]]).buffer);
        f32Str = view.getFloat32(0, true).toExponential(4);
      }
      
      table += '<tr><td style="color:var(--text-secondary);">0x' + (Math.floor(i/2)).toString(16).toUpperCase().padStart(4,'0') +
        '</td><td>' + hexStr.toUpperCase() + '</td><td>' + u16 + '</td><td>' + i16 +
        '</td><td style="color:var(--amber);">' + f32Str + '</td></tr>';
      if (i % 4 === 2) f32Idx++;
    }
    table += '</table>';
    dataDiv.innerHTML = table;
  } else {
    // Write confirmation (FC 05, 06, 15, 16)
    dataDiv.innerHTML = '<div style="padding:4px; font-size:11px; color:var(--green);">✓ 写入成功</div>';
  }
}
```

- [ ] **Step 3: Implement logging functions**

```javascript
const modbusLog = [];
const MODBUS_LOG_MAX = 100;

function modbusAddLog(frame, response) {
  const entry = { time: new Date(), funcCode: null, status: 'ok', desc: '' };
  if (frame) {
    entry.funcCode = frame[1];
    const names = {1:'Read Coils',2:'Read Discrete Inputs',3:'Read Holding Registers',
      4:'Read Input Registers',5:'Write Single Coil',6:'Write Single Register',
      15:'Write Multiple Coils',16:'Write Multiple Registers'};
    entry.desc = names[entry.funcCode] || 'FC' + entry.funcCode;
  }
  if (response) {
    if (response.type === 'timeout') { entry.status = 'err'; entry.desc += ' · 超时'; }
    else if (response.type === 'exception') { entry.status = 'warn'; entry.desc += ' · ' + response.desc; }
    else if (response.type === 'crc_error') { entry.status = 'err'; entry.desc += ' · CRC 错误'; }
  }
  modbusLog.unshift(entry);
  if (modbusLog.length > MODBUS_LOG_MAX) modbusLog.pop();
  modbusRenderLog();
}

function modbusRenderLog() {
  const list = document.getElementById('modbusLogList');
  document.getElementById('modbusLogCount').textContent = modbusLog.length + ' 条记录';
  list.innerHTML = modbusLog.map(e => {
    const statusClass = e.status === 'ok' ? 'modbus-log-ok' : e.status === 'err' ? 'modbus-log-err' : 'modbus-log-warn';
    const icon = e.status === 'ok' ? '✓' : e.status === 'err' ? '✗' : '⚠';
    return '<div class="modbus-log-entry"><span class="modbus-log-time">' +
      e.time.toLocaleTimeString() + '</span><span class="modbus-log-desc">' + escapeHtml(e.desc) +
      '</span><span class="modbus-log-status ' + statusClass + '">' + icon + '</span></div>';
  }).join('');
}

function modbusClearLog() {
  modbusLog.length = 0;
  modbusRenderLog();
}

function modbusSwitchTab(tab) {
  document.querySelectorAll('.modbus-tab').forEach(t => t.classList.remove('active'));
  if (tab === 'req') {
    document.querySelector('.modbus-tab:nth-child(1)').classList.add('active');
    // Show request/response panels
  } else {
    document.querySelector('.modbus-tab:nth-child(2)').classList.add('active');
  }
}
```

- [ ] **Step 4: Implement address parsing and toggle**

```javascript
let modbusAddrHex = false;

function modbusToggleAddrMode() {
  modbusAddrHex = document.getElementById('mbAddrMode').checked;
  document.getElementById('mbAddrDecLabel').classList.toggle('active', !modbusAddrHex);
  document.getElementById('mbAddrHexLabel').classList.toggle('active', modbusAddrHex);
}

function modbusParseAddress() {
  const val = document.getElementById('mbAddress').value.trim();
  if (modbusAddrHex) {
    return parseInt(val, 16);
  }
  return parseInt(val, 10);
}
```

- [ ] **Step 5: Implement write data parsing**

```javascript
function modbusParseWriteData(funcCode, quantity) {
  const raw = document.getElementById('mbWriteData').value.trim();
  if (!raw) {
    appendLine('[Modbus] 请输入写入数据', 'error');
    return null;
  }
  const bytes = raw.split(/[\s,]+/).map(s => parseInt(s, 16));
  if (bytes.some(b => isNaN(b) || b < 0 || b > 255)) {
    appendLine('[Modbus] 数据格式无效，请使用 HEX 格式 (如: 00 FF 00 01)', 'error');
    return null;
  }
  return new Uint8Array(bytes);
}
```

- [ ] **Step 6: Wire `modbusFeedResponse` into `readLoop`**

Find the readLoop's data handling line and add Modbus feed after terminal display.

```javascript
// In readLoop(), after handling data display:
if (typeof modbusFeedResponse === 'function') {
  modbusFeedResponse(new Uint8Array(value));
}
```

- [ ] **Step 7: Handle function code change (show/hide write data field)**

```javascript
function modbusOnFuncCodeChange() {
  const fc = parseInt(document.getElementById('mbFuncCode').value);
  const isWrite = fc === 5 || fc === 6 || fc === 15 || fc === 16;
  document.getElementById('mbWriteDataField').style.display = isWrite ? 'block' : 'none';
}
// Wire to onchange on the select element
```

- [ ] **Step 8: Implement response time calculation**

```javascript
let modbusSendTime = 0;

// In modbusSend(), before writer.write():
modbusSendTime = Date.now();

function modbusCalcResponseTime() {
  return (Date.now() - modbusSendTime) + 'ms';
}
```

- [ ] **Step 9: Commit**

### Task 6: Integration Test — End-to-End Modbus Flow

**Files:**
- Modify: `D:\Claude WorkSpace\Web Terminal\WebSerialTerminal.html`

- [ ] **Step 1: Add test mode / verification function**

```javascript
function modbusSelfTest() {
  // Test CRC16
  const test1 = modbusCRC16(new Uint8Array([0x01, 0x03, 0x00, 0x00, 0x00, 0x0A]));
  console.assert(test1[0] === 0xCD && test1[1] === 0xC5, 'CRC16 test 1 failed');
  const test2 = modbusCRC16(new Uint8Array([0x01, 0x06, 0x00, 0x01, 0x00, 0x03]));
  console.assert(test2[0] === 0x98 && test2[1] === 0x0B, 'CRC16 test 2 failed');
  const test3 = modbusCRC16(new Uint8Array([0x11, 0x03, 0x00, 0x6B, 0x00, 0x03]));
  console.assert(test3[0] === 0x87 && test3[1] === 0x76, 'CRC16 test 3 failed');
  console.log('Modbus CRC16 self-test: PASS');
  
  // Test frame construction
  const frame = modbusConstructFrame(1, 3, 0, 10, null);
  console.assert(frame.length === 8, 'Frame length should be 8');
  console.assert(frame[0] === 0x01, 'Slave ID');
  console.assert(frame[1] === 0x03, 'Function code');
  console.assert(frame[2] === 0x00, 'Address high');
  console.assert(frame[3] === 0x00, 'Address low');
  console.assert(frame[4] === 0x00, 'Quantity high');
  console.assert(frame[5] === 0x0A, 'Quantity low (10)');
  console.assert(frame[10] === 0xC5, 'CRC low');
  console.assert(frame[11] === 0xCD, 'CRC high');
  console.log('Modbus frame construction self-test: PASS');
  
  appendLine('[Modbus] 自检通过', 'success');
}
```

- [ ] **Step 2: Wire self-test to a hidden dev mode (or run on console)**

- [ ] **Step 3: Commit**

### Task 7: Final Polish — UX Details

**Files:**
- Modify: `D:\Claude WorkSpace\Web Terminal\WebSerialTerminal.html`

- [ ] **Step 1: Auto-open the Modbus tool when sending from collapsed state**

```javascript
// In modbusSend(), add at the beginning:
function modbusSend() {
  // Auto-expand tool
  const body = document.getElementById('toolModbus');
  if (body.style.display === 'none' || !body.style.display) {
    toggleTool('modbus');
  }
  // ... rest
}
```

- [ ] **Step 2: Clear previous response when sending new request**

```javascript
// In modbusShowTx():
document.getElementById('modbusRxDisplay').style.display = 'none';
document.getElementById('modbusDataDisplay').style.display = 'none';
```

- [ ] **Step 3: Commit**
