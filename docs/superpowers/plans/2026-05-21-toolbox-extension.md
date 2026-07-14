# Toolbox Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-side toolbox panel to WebTerm Pro with four tools (checksum calculator, float converter, ASCII table, TFTP client).

**Architecture:** Single HTML file (`WebSerialTerminal.html`) — add right sidebar HTML/CSS/JS for the first 3 pure-JS tools. Create `tftp-proxy.js` as a Node.js WebSocket↔UDP proxy for TFTP. All new state and functions follow existing code patterns.

**Tech Stack:** Vanilla JS (no frameworks/libraries). Web Crypto API for SHA/MD5. Node.js `ws` + `dgram` for TFTP proxy.

---

### Task 1: Right Sidebar HTML Structure

**Files:**
- Modify: `WebSerialTerminal.html` — add right sidebar markup after line 1234 (after `</div>` closing `terminal-wrapper`)

**Insertion point:** After line 1234 (`</div>` closing `.main > .terminal-wrapper > .input-area > ...`), before line 1236 (`<!-- STATUS BAR -->`).

- [ ] **Step 1: Add right sidebar HTML**

Insert the following HTML block before `<!-- STATUS BAR -->` (line 1236):

```html
<!-- RIGHT TOOLBOX SIDEBAR -->
<div class="right-sidebar" id="rightSidebar">
  <div class="right-sidebar-toggle" id="rightSidebarToggle" onclick="toggleRightSidebar()" title="切换工具箱">☰</div>

  <!-- Checksum Calculator -->
  <div class="tool-section">
    <div class="tool-header" onclick="toggleTool('checksum')">
      <span>⊞ 校验计算</span>
      <span class="tool-arrow" id="arrowChecksum">▼</span>
    </div>
    <div class="tool-body" id="toolChecksum">
      <div class="tool-field">
        <div class="tool-label">校验算法</div>
        <select class="tool-select" id="chkAlgorithm">
          <optgroup label="CRC">
            <option value="crc32">CRC32</option>
            <option value="crc16">CRC16</option>
            <option value="crc8">CRC8</option>
          </optgroup>
          <optgroup label="Hash">
            <option value="md5">MD5</option>
            <option value="sha1">SHA1</option>
            <option value="sha256">SHA256</option>
          </optgroup>
          <optgroup label="Simple">
            <option value="sum8">Sum8</option>
            <option value="sum16">Sum16</option>
            <option value="xor">XOR</option>
          </optgroup>
        </select>
      </div>
      <div class="tool-field">
        <div class="tool-label">输入模式</div>
        <label class="toggle-switch">
          <span class="toggle-label active" id="chkModeLabel">ASCII</span>
          <span class="toggle-track">
            <span class="toggle-thumb"></span>
          </span>
          <span class="toggle-label" id="chkModeLabelHex">HEX</span>
          <input type="checkbox" id="chkInputMode" onchange="toggleInputMode()" hidden>
        </label>
      </div>
      <div class="tool-field">
        <textarea class="tool-textarea" id="chkInput" placeholder="输入数据..." oninput="calcChecksum()" rows="4"></textarea>
        <div class="tool-hint" id="chkHint" style="display:none">HEX 格式：AA BB CC 0D 0A</div>
      </div>
      <div class="tool-result-row">
        <div class="tool-result-box">
          <div class="tool-result-label">HEX</div>
          <div class="tool-result-value" id="chkResultHex" onclick="copyText(this)">--</div>
        </div>
        <div class="tool-result-box">
          <div class="tool-result-label">DEC</div>
          <div class="tool-result-value" id="chkResultDec" onclick="copyText(this)">--</div>
        </div>
      </div>
      <button class="tool-btn" onclick="copyText(document.getElementById('chkResultHex'))">📋 复制结果</button>
    </div>
  </div>

  <!-- Float Converter -->
  <div class="tool-section">
    <div class="tool-header" onclick="toggleTool('float')">
      <span>∑ 浮点数转换</span>
      <span class="tool-arrow" id="arrowFloat">▶</span>
    </div>
    <div class="tool-body" id="toolFloat" style="display:none">
      <div class="tool-field">
        <div class="tool-label">精度</div>
        <div class="segmented-control" id="floatPrecision">
          <span class="seg-option active" data-value="float32" onclick="setFloatPrecision('float32')">float (32-bit)</span>
          <span class="seg-option" data-value="float64" onclick="setFloatPrecision('float64')">double (64-bit)</span>
        </div>
      </div>
      <div class="tool-field">
        <div class="tool-label">浮点数</div>
        <input type="text" class="tool-input" id="floatInput" value="3.14" oninput="calcFloat()" placeholder="输入浮点数">
      </div>
      <div class="tool-result-box" style="margin-bottom:3px">
        <div class="tool-result-label">十六进制</div>
        <div class="tool-result-value mono" id="floatResultHex" onclick="copyText(this)">0x4048F5C3</div>
      </div>
      <div class="tool-result-box" style="margin-bottom:6px">
        <div class="tool-result-label">二进制</div>
        <div class="tool-result-value mono" id="floatResultBin" onclick="copyText(this)">01000000 01001000 11110101 11000011</div>
      </div>
      <div class="tool-divider"></div>
      <div class="tool-field">
        <div class="tool-label">十六进制 → 浮点数</div>
        <div class="tool-inline-group">
          <input type="text" class="tool-input" id="floatHexInput" placeholder="4048F5C3" onchange="calcHexToFloat()">
          <button class="tool-btn-sm" onclick="calcHexToFloat()">→</button>
        </div>
      </div>
      <div class="tool-field">
        <div class="tool-label">整数 → 十六进制</div>
        <div class="tool-inline-group">
          <input type="text" class="tool-input" id="floatIntInput" placeholder="255" onchange="calcIntToHex()">
          <button class="tool-btn-sm" onclick="calcIntToHex()">→</button>
        </div>
      </div>
      <div class="tool-result-box">
        <div class="tool-result-label">结果 (HEX)</div>
        <div class="tool-result-value mono" id="floatReverseResult" onclick="copyText(this)">--</div>
      </div>
    </div>
  </div>

  <!-- ASCII Table -->
  <div class="tool-section">
    <div class="tool-header" onclick="toggleTool('ascii')">
      <span>⎓ ASCII 码表</span>
      <span class="tool-arrow" id="arrowAscii">▶</span>
    </div>
    <div class="tool-body" id="toolAscii" style="display:none">
      <div class="tool-field">
        <input type="text" class="tool-input" id="asciiSearch" placeholder="搜索字符 / Dec / Hex..." oninput="searchAscii()">
      </div>
      <div id="asciiResult" style="display:none; background:#003320; border:1px solid #00cc6a; border-radius:2px; padding:5px 6px; margin-bottom:6px; font-family:var(--font-mono); font-size:11px;">
        <div id="asciiResultContent" style="display:flex; gap:6px; justify-content:space-between;"></div>
      </div>
      <div id="asciiTable">
        <div class="tool-label" style="margin-bottom:2px">控制字符 (0-31)</div>
        <div id="asciiControl" class="ascii-grid-control"></div>
        <div class="tool-label" style="margin:4px 0 2px">可打印字符 (32-126)</div>
        <div id="asciiPrintable" class="ascii-grid-printable"></div>
      </div>
    </div>
  </div>

  <!-- TFTP Client -->
  <div class="tool-section">
    <div class="tool-header" onclick="toggleTool('tftp')">
      <span>⇄ TFTP 客户端</span>
      <span class="tool-arrow" id="arrowTftp">▶</span>
    </div>
    <div class="tool-body" id="toolTftp" style="display:none">
      <div class="tool-field">
        <div class="tool-label">目标地址</div>
        <div class="tool-inline-group">
          <input type="text" class="tool-input" id="tftpHost" value="192.168.1.100" placeholder="IP 地址">
          <input type="text" class="tool-input" id="tftpPort" value="69" style="width:60px;flex:none" placeholder="端口">
        </div>
      </div>
      <div class="tool-field">
        <div class="tool-status" id="tftpProxyStatus">
          <span class="status-dot-sm" id="tftpDot"></span>
          <span id="tftpStatusText">代理未连接</span>
        </div>
        <button class="tool-btn" id="tftpConnectBtn" onclick="connectTftpProxy()">连接代理</button>
      </div>
      <div class="tool-field">
        <div class="tool-label">本地文件</div>
        <div class="tool-inline-group">
          <input type="text" class="tool-input" id="tftpFilename" readonly placeholder="选择文件..." style="flex:1">
          <button class="tool-btn-sm" onclick="document.getElementById('tftpFileInput').click()">浏览</button>
        </div>
        <input type="file" id="tftpFileInput" style="display:none" onchange="onTftpFileSelect(event)">
      </div>
      <button class="tool-btn primary" id="tftpUploadBtn" onclick="startTftpUpload()" disabled>⇧ 上传文件</button>
      <div class="tool-log" id="tftpLog"></div>
      <div class="tftp-progress" id="tftpProgress" style="display:none">
        <div style="display:flex; justify-content:space-between; font-size:9px; color:var(--text-dim);">
          <span>进度</span>
          <span id="tftpProgressPct">0%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" id="tftpProgressFill"></div></div>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add right sidebar toggle button to toolbar**

In the `.toolbar` div (around line 1105-1117), add a new button group:

```html
  <div class="toolbar-group">
    <button class="btn" id="btnRightSidebar" onclick="toggleRightSidebar()" title="切换工具箱">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
      工具箱
    </button>
  </div>
```

- [ ] **Step 3: Verify HTML structure loads without errors**

Open `WebSerialTerminal.html` in Chrome. Open DevTools Console — no JS errors. Right sidebar should not be visible yet (CSS not added).

### Task 2: Right Sidebar CSS

**Files:**
- Modify: `WebSerialTerminal.html` — add CSS before `</style>` (line 997)

- [ ] **Step 1: Add right sidebar and tool styles**

Insert the following CSS block before `</style>` (line 997):

```css
/* ═══════════ RIGHT SIDEBAR / TOOLBOX ═══════════ */
.right-sidebar {
  width: 0;
  flex-shrink: 0;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
  overflow: hidden;
  transition: width 0.3s ease;
  display: flex;
  flex-direction: column;
  position: relative;
  z-index: 5;
}
.right-sidebar.open { width: 240px; }

.right-sidebar-toggle {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 14px; height: 40px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-right: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: 8px;
  z-index: 6;
  border-radius: 4px 0 0 4px;
  transition: right 0.3s, color 0.2s;
}
.right-sidebar.open .right-sidebar-toggle { right: 240px; }
.right-sidebar-toggle:hover { color: var(--accent); }

/* Tool sections */
.tool-section {
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.tool-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  font-size: 10px;
  letter-spacing: 1.5px;
  color: var(--accent-dim);
  cursor: pointer;
  user-select: none;
  background: rgba(0,180,255,0.03);
  transition: background 0.15s;
}
.tool-header:hover { background: rgba(0,180,255,0.08); }
.tool-arrow { font-size: 8px; color: var(--text-dim); transition: transform 0.2s; }
.tool-body {
  padding: 8px 10px;
  font-size: 11px;
}
.tool-field { margin-bottom: 6px; }
.tool-field:last-child { margin-bottom: 0; }
.tool-label {
  font-size: 9px;
  color: var(--text-dim);
  letter-spacing: 1px;
  text-transform: uppercase;
  margin-bottom: 3px;
}
.tool-input {
  width: 100%;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 2px;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 5px 6px;
  outline: none;
  height: 28px;
  transition: border-color 0.2s;
}
.tool-input:focus { border-color: var(--accent-dim); }
.tool-textarea {
  width: 100%;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 2px;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 5px 6px;
  outline: none;
  resize: vertical;
  min-height: 56px;
  transition: border-color 0.2s;
}
.tool-textarea:focus { border-color: var(--accent-dim); }
.tool-hint {
  font-size: 8px;
  color: var(--text-dim);
  margin-top: 2px;
}
.tool-select {
  width: 100%;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 2px;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 4px 6px;
  outline: none;
  height: 28px;
  cursor: pointer;
}
.tool-select:focus { border-color: var(--accent-dim); }

/* Toggle switch */
.toggle-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}
.toggle-track {
  position: relative;
  width: 36px;
  height: 18px;
  background: var(--border);
  border-radius: 9px;
  transition: background 0.25s;
}
.toggle-thumb {
  position: absolute;
  top: 2px; left: 2px;
  width: 14px; height: 14px;
  background: var(--accent);
  border-radius: 50%;
  transition: transform 0.25s;
  box-shadow: 0 0 6px rgba(0,212,255,0.4);
}
.toggle-switch input:checked ~ .toggle-track { background: var(--border-bright); }
.toggle-switch input:checked ~ .toggle-track .toggle-thumb { transform: translateX(18px); }
.toggle-label {
  font-size: 10px;
  color: var(--text-dim);
  font-weight: 400;
  transition: color 0.2s;
}
.toggle-label.active { color: var(--accent); font-weight: 600; }

/* Segmented control */
.segmented-control {
  display: flex;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px;
  position: relative;
}
.seg-option {
  flex: 1;
  text-align: center;
  padding: 3px 0;
  font-size: 10px;
  color: var(--text-dim);
  letter-spacing: 0.5px;
  cursor: pointer;
  border-radius: 3px;
  transition: all 0.2s;
  position: relative;
  z-index: 1;
}
.seg-option.active {
  background: var(--bg-elevated);
  color: var(--accent);
  box-shadow: 0 0 8px rgba(0,212,255,0.15);
}

/* Result boxes */
.tool-result-row {
  display: flex;
  gap: 3px;
  margin-bottom: 6px;
}
.tool-result-box {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 2px;
  padding: 5px 6px;
  flex: 1;
}
.tool-result-label {
  font-size: 8px;
  color: var(--text-dim);
  letter-spacing: 1px;
  margin-bottom: 2px;
}
.tool-result-value {
  font-family: var(--font-mono);
  font-size: 11px;
  word-break: break-all;
  cursor: pointer;
  color: var(--green);
  transition: opacity 0.15s;
}
.tool-result-value:hover { opacity: 0.7; }
.tool-result-value.mono { color: var(--green); }

/* Buttons */
.tool-btn {
  width: 100%;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 2px;
  color: var(--text-dim);
  font-size: 10px;
  letter-spacing: 1px;
  padding: 5px;
  cursor: pointer;
  text-transform: uppercase;
  transition: all 0.15s;
}
.tool-btn:hover { border-color: var(--accent-dim); color: var(--accent); background: var(--accent-glow); }
.tool-btn.primary {
  background: linear-gradient(135deg, #00334d, #004466);
  border-color: var(--accent);
  color: var(--accent);
  padding: 6px;
  font-size: 11px;
  letter-spacing: 2px;
}
.tool-btn.primary:hover { box-shadow: 0 0 12px rgba(0,212,255,0.3); }
.tool-btn.primary:disabled { opacity: 0.35; cursor: not-allowed; box-shadow: none; }
.tool-btn-sm {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 2px;
  color: var(--text-dim);
  font-size: 11px;
  padding: 3px 10px;
  cursor: pointer;
  white-space: nowrap;
  height: 28px;
}
.tool-btn-sm:hover { border-color: var(--accent-dim); color: var(--accent); }
.tool-inline-group {
  display: flex;
  gap: 3px;
}
.tool-inline-group .tool-input { flex: 1; }
.tool-divider {
  border-top: 1px solid var(--border);
  margin: 8px 0;
}

/* Status indicator */
.tool-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.status-dot-sm {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--red);
  flex-shrink: 0;
  transition: all 0.3s;
}
.status-dot-sm.on { background: var(--green); box-shadow: 0 0 6px var(--green); }

/* TFTP log */
.tool-log {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 2px;
  padding: 5px 6px;
  margin-top: 6px;
  max-height: 80px;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-dim);
}
.tool-log div.sys { color: var(--accent); font-style: italic; }
.tool-log div.ok { color: var(--green); }
.tool-log div.err { color: var(--red); }
.tool-log div.info { color: var(--text-primary); }

/* Progress bar */
.progress-bar {
  height: 4px;
  background: var(--border);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 2px;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--green));
  border-radius: 2px;
  transition: width 0.3s ease;
}

/* ASCII table grids */
.ascii-grid-control {
  font-family: var(--font-mono);
  font-size: 9px;
  max-height: 110px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 2px;
}
.ascii-grid-control .ascii-row {
  display: flex;
  padding: 1px 4px;
}
.ascii-grid-control .ascii-row:nth-child(odd) { background: rgba(0,0,0,0.15); }
.ascii-grid-control .ascii-cell { flex-shrink: 0; }
.ascii-grid-control .ascii-cell-dec { width: 28px; color: var(--text-dim); }
.ascii-grid-control .ascii-cell-hex { width: 28px; color: var(--green-dim); }
.ascii-grid-control .ascii-cell-char { width: 30px; color: var(--amber); }
.ascii-grid-control .ascii-cell-desc { flex: 1; color: var(--text-secondary); }

.ascii-grid-printable {
  display: flex;
  flex-wrap: wrap;
  border: 1px solid var(--border);
  border-radius: 2px;
  max-height: 120px;
  overflow-y: auto;
}
.ascii-grid-printable .ascii-char {
  width: 12.5%;
  text-align: center;
  padding: 2px 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-primary);
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: 2px;
  transition: all 0.1s;
}
.ascii-grid-printable .ascii-char:hover {
  background: var(--accent-glow);
  color: var(--accent);
  border-color: var(--accent-dim);
}
.ascii-grid-printable .ascii-char.highlight {
  background: rgba(255,121,198,0.15);
  color: var(--green);
}
```

- [ ] **Step 2: Verify CSS renders**

Open file in Chrome. Right sidebar still hidden (width: 0). Toggle button not yet functional. No CSS errors.

### Task 3: Right Sidebar JS — Toggle Logic and State

**Files:**
- Modify: `WebSerialTerminal.html`

- [ ] **Step 1: Add state variables after line 1320**

Insert after `let readLoopRunning = false;` (line 1320):

```js
// Right sidebar
let rightSidebarOpen = false;
let toolStates = { checksum: true, float: false, ascii: false, tftp: false };
```

- [ ] **Step 2: Add toggle and init functions**

Insert after the `printWelcome()` function block (after line 1383):

```js
// ════════════════════════════════════════════════════════
// RIGHT SIDEBAR / TOOLBOX
// ════════════════════════════════════════════════════════
function toggleRightSidebar() {
  rightSidebarOpen = !rightSidebarOpen;
  document.getElementById('rightSidebar').classList.toggle('open', rightSidebarOpen);
}

function toggleTool(name) {
  toolStates[name] = !toolStates[name];
  const body = document.getElementById('tool' + name.charAt(0).toUpperCase() + name.slice(1));
  const arrow = document.getElementById('arrow' + name.charAt(0).toUpperCase() + name.slice(1));
  if (body) body.style.display = toolStates[name] ? '' : 'none';
  if (arrow) arrow.textContent = toolStates[name] ? '▼' : '▶';
}
```

- [ ] **Step 3: Init tool states in DOMContentLoaded**

In the `DOMContentLoaded` listener (after `updateSidebarToggle();` at line 1353), add:

```js
  // Init toolbox — checksum open by default, others closed
  toggleTool('checksum');
```

- [ ] **Step 4: Verify toggles work**

Open in Chrome. Click toolbar "工具箱" button — right sidebar slides open. Click again — closes. Click tool headers to expand/collapse sections.

### Task 4: Checksum Calculator JS

**Files:**
- Modify: `WebSerialTerminal.html` — add functions after `// RIGHT SIDEBAR / TOOLBOX` section

- [ ] **Step 1: Add input mode toggle**

```js
function toggleInputMode() {
  const isHex = document.getElementById('chkInputMode').checked;
  document.getElementById('chkHint').style.display = isHex ? '' : 'none';
  document.getElementById('chkModeLabel').classList.toggle('active', !isHex);
  document.getElementById('chkModeLabelHex').classList.toggle('active', isHex);
  calcChecksum();
}
```

- [ ] **Step 2: Add CRC lookup tables and helpers**

```js
// CRC tables
let crc8Table = null, crc16Table = null, crc32Table = null;

function initCrcTables() {
  if (crc8Table) return;
  crc8Table = new Uint32Array(256);
  crc16Table = new Uint32Array(256);
  crc32Table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc8 = i, crc16 = i, crc32 = i;
    for (let j = 0; j < 8; j++) {
      crc8 = (crc8 & 0x80) ? ((crc8 << 1) ^ 0x07) : (crc8 << 1);
      crc16 = (crc16 & 0x8000) ? ((crc16 << 1) ^ 0x8005) : (crc16 << 1);
      crc32 = (crc32 & 1) ? ((crc32 >>> 1) ^ 0xEDB88320) : (crc32 >>> 1);
    }
    crc8Table[i] = crc8 & 0xFF;
    crc16Table[i] = crc16 & 0xFFFF;
    crc32Table[i] = crc32;
  }
}

function crc8(data) {
  initCrcTables();
  let c = 0;
  for (const b of data) c = crc8Table[(c ^ b) & 0xFF];
  return c & 0xFF;
}

function crc16(data) {
  initCrcTables();
  let c = 0;
  for (const b of data) c = (c >>> 8) ^ crc16Table[(c ^ b) & 0xFF];
  return c & 0xFFFF;
}

function crc32(data) {
  initCrcTables();
  let c = 0xFFFFFFFF;
  for (const b of data) c = (c >>> 8) ^ crc32Table[(c ^ b) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}
```

- [ ] **Step 3: Add simple checksum helpers**

```js
function sum8(data) { let s = 0; for (const b of data) s = (s + b) & 0xFF; return s; }
function sum16(data) { let s = 0; for (const b of data) s = (s + b) & 0xFFFF; return s; }
function xorSum(data) { let x = 0; for (const b of data) x ^= b; return x & 0xFF; }
```

- [ ] **Step 4: Add main calcChecksum function**

```js
async function calcChecksum() {
  const input = document.getElementById('chkInput').value;
  const algo = document.getElementById('chkAlgorithm').value;
  const isHex = document.getElementById('chkInputMode').checked;
  const hexEl = document.getElementById('chkResultHex');
  const decEl = document.getElementById('chkResultDec');

  if (!input.trim()) { hexEl.textContent = '--'; decEl.textContent = '--'; return; }

  let bytes;
  if (isHex) {
    const hex = input.replace(/\s+/g, '');
    if (!/^[0-9A-Fa-f]*$/.test(hex) || hex.length % 2 !== 0) {
      hexEl.textContent = '格式错误'; decEl.textContent = '格式错误';
      return;
    }
    bytes = new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
  } else {
    bytes = new TextEncoder().encode(input);
  }

  let result;
  switch (algo) {
    case 'crc8': result = crc8(bytes); break;
    case 'crc16': result = crc16(bytes); break;
    case 'crc32': result = crc32(bytes); break;
    case 'sum8': result = sum8(bytes); break;
    case 'sum16': result = sum16(bytes); break;
    case 'xor': result = xorSum(bytes); break;
    case 'md5':
    case 'sha1':
    case 'sha256': {
      const hashAlgo = { md5: 'MD5', sha1: 'SHA-1', sha256: 'SHA-256' }[algo];
      try {
        const hashBuf = await crypto.subtle.digest(hashAlgo, bytes);
        const hashArr = new Uint8Array(hashBuf);
        result = Array.from(hashArr).map(b => b.toString(16).padStart(2,'0')).join('');
      } catch (e) {
        // Fallback: simple hash placeholder — uses crypto.subtle which supports SHA-1 and SHA-256 natively
        hexEl.textContent = 'Error'; decEl.textContent = 'Error';
        return;
      }
      hexEl.textContent = '0x' + result;
      decEl.textContent = result.length > 16 ? result : parseInt(result, 16).toString();
      return;
    }
    default: hexEl.textContent = '--'; decEl.textContent = '--'; return;
  }

  hexEl.textContent = (algo === 'crc32' || algo === 'sum16')
    ? '0x' + result.toString(16).toUpperCase().padStart(4,'0')
    : '0x' + result.toString(16).toUpperCase().padStart(2,'0');
  decEl.textContent = result.toString();
}
```

- [ ] **Step 5: Add copy helper**

```js
function copyText(el) {
  const text = el.textContent || el.innerText;
  navigator.clipboard.writeText(text).then(() => {
    const orig = el.style.color;
    el.style.color = 'var(--amber)';
    setTimeout(() => el.style.color = orig, 400);
  }).catch(() => {});
}
```

- [ ] **Step 6: Verify checksum tool**

In Chrome, expand checksum tool. Type "hello" ASCII CRC32 — should show `0x8B1D995F` / `2333817183`. Toggle HEX mode, type "48 65" — result should match "He".

### Task 5: Float Converter JS

**Files:**
- Modify: `WebSerialTerminal.html` — add functions after checksum functions

- [ ] **Step 1: Add float precision state and toggle**

```js
let floatPrecision = 'float32';

function setFloatPrecision(val) {
  floatPrecision = val;
  document.querySelectorAll('#floatPrecision .seg-option').forEach(el => {
    el.classList.toggle('active', el.dataset.value === val);
  });
  calcFloat();
}
```

- [ ] **Step 2: Add conversion functions**

```js
function calcFloat() {
  const val = document.getElementById('floatInput').value.trim();
  const hexEl = document.getElementById('floatResultHex');
  const binEl = document.getElementById('floatResultBin');

  if (!val || isNaN(parseFloat(val))) { hexEl.textContent = '--'; binEl.textContent = '--'; return; }

  const num = parseFloat(val);
  const isDouble = floatPrecision === 'float64';

  if (isDouble) {
    const buf = new ArrayBuffer(8);
    new Float64Array(buf)[0] = num;
    const bytes = new Uint8Array(buf);
    const hex = Array.from(bytes).map(b => b.toString(16).toUpperCase().padStart(2,'0')).reverse().join('');
    hexEl.textContent = '0x' + hex;
    binEl.textContent = formatBin(hex, 64);
  } else {
    const buf = new ArrayBuffer(4);
    new Float32Array(buf)[0] = num;
    const bytes = new Uint8Array(buf);
    const hex = Array.from(bytes).map(b => b.toString(16).toUpperCase().padStart(2,'0')).reverse().join('');
    hexEl.textContent = '0x' + hex;
    binEl.textContent = formatBin(hex, 32);
  }
}

function formatBin(hex, bits) {
  let bin = '';
  for (const ch of hex) {
    bin += parseInt(ch, 16).toString(2).padStart(4, '0');
  }
  bin = bin.padStart(bits, '0').slice(0, bits);
  const parts = [];
  for (let i = 0; i < bin.length; i += 4) parts.push(bin.slice(i, i + 4));
  return parts.join(' ');
}
```

- [ ] **Step 3: Add reverse conversion functions**

```js
function calcHexToFloat() {
  const input = document.getElementById('floatHexInput').value.trim().replace(/^0x/i, '');
  const resultEl = document.getElementById('floatReverseResult');
  if (!input || !/^[0-9A-Fa-f]+$/.test(input)) { resultEl.textContent = '--'; return; }

  const isDouble = floatPrecision === 'float64';
  const expectedLen = isDouble ? 16 : 8;

  if (input.length !== expectedLen) {
    resultEl.textContent = '需要 ' + expectedLen + ' 位十六进制';
    return;
  }

  const bytes = new Uint8Array(input.match(/.{2}/g).map(b => parseInt(b, 16)).reverse());
  const buf = bytes.buffer;

  if (isDouble) {
    resultEl.textContent = new Float64Array(buf)[0].toString();
  } else {
    resultEl.textContent = new Float32Array(buf)[0].toString();
  }
}

function calcIntToHex() {
  const input = document.getElementById('floatIntInput').value.trim();
  const resultEl = document.getElementById('floatReverseResult');
  const val = parseInt(input);
  if (isNaN(val)) { resultEl.textContent = '--'; return; }

  const bits = floatPrecision === 'float64' ? 64 : 32;
  const hex = (val >>> 0).toString(16).toUpperCase().padStart(bits / 4, '0');
  resultEl.textContent = '0x' + hex;
}
```

- [ ] **Step 4: Add initial values call to DOMContentLoaded**

In `DOMContentLoaded`, after toolbox inits:

```js
  // Init float converter default values
  calcFloat();
```

- [ ] **Step 5: Verify float converter**

Open in Chrome. Default "3.14" float32 → hex `0x4048F5C3`, bin grouped. Switch to double — result changes. Type hex `4048F5C3` in reverse → shows `3.14`. Type `255` in int → shows `0x000000FF`.

### Task 6: ASCII Table JS

**Files:**
- Modify: `WebSerialTerminal.html`

- [ ] **Step 1: Add ASCII table generation and search**

```js
const ASCII_CONTROL = [
  'NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL',
  'BS',  'HT',  'LF',  'VT',  'FF',  'CR',  'SO',  'SI',
  'DLE', 'DC1', 'DC2', 'DC3', 'DC4', 'NAK', 'SYN', 'ETB',
  'CAN', 'EM',  'SUB', 'ESC', 'FS',  'GS',  'RS',  'US'
];
const ASCII_DESC = [
  '空字符', '标题开始', '正文开始', '正文结束',
  '传输结束', '查询', '确认', '响铃',
  '退格', '水平制表符', '换行', '垂直制表符',
  '换页', '回车', '移出', '移入',
  '数据链路转义', '设备控制1', '设备控制2', '设备控制3',
  '设备控制4', '否定', '同步空闲', '传输块结束',
  '取消', '介质结束', '替换', '转义',
  '文件分隔符', '组分隔符', '记录分隔符', '单元分隔符'
];

function renderAsciiTable() {
  const ctrlEl = document.getElementById('asciiControl');
  ctrlEl.innerHTML = '';
  // Header
  const header = document.createElement('div');
  header.className = 'ascii-row';
  header.innerHTML = '<span class="ascii-cell ascii-cell-dec">DEC</span><span class="ascii-cell ascii-cell-hex">HEX</span><span class="ascii-cell ascii-cell-char">CHR</span><span class="ascii-cell ascii-cell-desc">描述</span>';
  ctrlEl.appendChild(header);

  for (let i = 0; i < 32; i++) {
    const row = document.createElement('div');
    row.className = 'ascii-row';
    row.innerHTML = '<span class="ascii-cell ascii-cell-dec">' + i.toString().padStart(2,'0') +
      '</span><span class="ascii-cell ascii-cell-hex">0x' + i.toString(16).toUpperCase().padStart(2,'0') +
      '</span><span class="ascii-cell ascii-cell-char">' + ASCII_CONTROL[i] +
      '</span><span class="ascii-cell ascii-cell-desc">' + ASCII_DESC[i] + '</span>';
    row.onclick = () => { document.getElementById('asciiSearch').value = i.toString(); searchAscii(); };
    ctrlEl.appendChild(row);
  }

  const printEl = document.getElementById('asciiPrintable');
  printEl.innerHTML = '';
  for (let i = 32; i <= 126; i++) {
    const el = document.createElement('div');
    el.className = 'ascii-char';
    el.textContent = i === 32 ? '␣' : String.fromCharCode(i);
    el.title = 'Dec: ' + i + ' Hex: 0x' + i.toString(16).toUpperCase() + ' Bin: ' + i.toString(2).padStart(8,'0');
    el.onclick = () => { document.getElementById('asciiSearch').value = i.toString(); searchAscii(); };
    printEl.appendChild(el);
  }
}

function searchAscii() {
  const q = document.getElementById('asciiSearch').value.trim();
  const resultEl = document.getElementById('asciiResult');
  const contentEl = document.getElementById('asciiResultContent');
  const tableEl = document.getElementById('asciiTable');

  if (!q) {
    resultEl.style.display = 'none';
    tableEl.style.display = '';
    return;
  }

  // Determine search type
  let code = -1;
  if (/^\d+$/.test(q)) code = parseInt(q);
  else if (/^0x[0-9A-Fa-f]+$/.test(q)) code = parseInt(q, 16);
  else if (q.length === 1) code = q.charCodeAt(0);

  if (code < 0 || code > 127) {
    resultEl.style.display = 'none';
    tableEl.style.display = '';
    return;
  }

  tableEl.style.display = 'none';
  resultEl.style.display = '';
  const ch = code === 32 ? '␣' : (code <= 31 ? ASCII_CONTROL[code] : String.fromCharCode(code));
  const desc = code <= 31 ? ASCII_DESC[code] : (code === 127 ? '删除' : '可打印字符');
  contentEl.innerHTML =
    '<span><span style="color:var(--text-dim)">Dec</span> <span style="color:var(--green)">' + code + '</span></span>' +
    '<span><span style="color:var(--text-dim)">Hex</span> <span style="color:var(--accent)">0x' + code.toString(16).toUpperCase().padStart(2,'0') + '</span></span>' +
    '<span><span style="color:var(--text-dim)">Bin</span> <span style="color:var(--amber)">' + code.toString(2).padStart(8,'0') + '</span></span>' +
    '<span><span style="color:var(--text-dim)">Char</span> <span style="color:var(--green);font-size:14px;">' + ch + '</span></span>';
}
```

- [ ] **Step 2: Add init call to DOMContentLoaded**

```js
  renderAsciiTable();
```

- [ ] **Step 3: Verify ASCII table**

Open in Chrome. Expand ASCII tool — control chars listed with dec/hex/name/description, printable chars in 8-col grid. Search "65" — shows result card for 'A'. Search "A" — same. Clear search — table reappears.

### Task 7: TFTP Proxy (Node.js)

**Files:**
- Create: `tftp-proxy.js` in project root

- [ ] **Step 1: Write tftp-proxy.js**

```js
const { WebSocketServer } = require('ws');
const dgram = require('dgram');

const WS_PORT = 52345;
const SOCKET_TIMEOUT = 10000;
const BLOCK_SIZE = 512;

const wss = new WebSocketServer({ port: WS_PORT });
console.log('[TFTP Proxy] WebSocket server on port', WS_PORT);

wss.on('connection', (ws) => {
  console.log('[TFTP Proxy] Client connected');

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log('[TFTP Proxy] Received:', msg.type);

      if (msg.type === 'upload') {
        await handleUpload(ws, msg.addr, msg.port || 69, msg.filename, msg.data);
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown command: ' + msg.type }));
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  ws.on('close', () => console.log('[TFTP Proxy] Client disconnected'));
});

async function handleUpload(ws, addr, port, filename, base64Data) {
  const buf = Buffer.from(base64Data, 'base64');
  const totalBlocks = Math.ceil(buf.length / BLOCK_SIZE) || 1;
  let blockNum = 1;
  let offset = 0;
  const socket = dgram.createSocket('udp4');

  // Send WRQ
  const wrq = buildWRQ(filename, 'octet');
  socket.send(wrq, port, addr);

  let timeoutId;
  let confirmed = false;

  const cleanup = () => {
    clearTimeout(timeoutId);
    try { socket.close(); } catch(e) {}
  };

  const setTimer = () => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      ws.send(JSON.stringify({ type: 'error', message: 'Timeout waiting for ACK for block ' + blockNum }));
      cleanup();
    }, SOCKET_TIMEOUT);
  };

  socket.on('message', (resp) => {
    const opcode = resp.readUInt16BE(0);
    if (opcode === 4) {
      // ACK received
      const ackBlock = resp.readUInt16BE(2);

      if (!confirmed && blockNum === 1) {
        confirmed = true;
        ws.send(JSON.stringify({ type: 'progress', sent: 0, total: buf.length }));
      }

      if (ackBlock === (blockNum - 1) || (!confirmed && ackBlock === 0)) {
        if (!confirmed) {
          confirmed = true;
          ws.send(JSON.stringify({ type: 'progress', sent: 0, total: buf.length }));
        }

        // Send next data block
        const chunk = buf.slice(offset, offset + BLOCK_SIZE);
        if (chunk.length > 0 || blockNum === 1) {
          const dataPkt = buildData(blockNum, chunk);
          socket.send(dataPkt, port, addr);
          ws.send(JSON.stringify({ type: 'progress', sent: Math.min(offset + BLOCK_SIZE, buf.length), total: buf.length }));
          offset += BLOCK_SIZE;
          blockNum++;
          setTimer();
        }

        // Last block sent
        if (chunk.length < BLOCK_SIZE) {
          ws.send(JSON.stringify({ type: 'complete', filename }));
          cleanup();
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

  setTimer();
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
```

- [ ] **Step 2: Create package.json for proxy**

```js
{ "name": "tftp-proxy", "version": "1.0.0", "private": true, "dependencies": { "ws": "^8.16.0" } }
```

- [ ] **Step 3: Install dependencies and verify**

```bash
cd "D:\Claude WorkSpace\Web Terminal"
npm install
```

```bash
node tftp-proxy.js
```

Expected: `[TFTP Proxy] WebSocket server on port 52345`

### Task 8: TFTP Client JS (Browser Side)

**Files:**
- Modify: `WebSerialTerminal.html` — add TFTP functions after ASCII table functions

- [ ] **Step 1: Add TFTP state variables**

Add after existing state variables (line 1320 area):

```js
// TFTP
let tftpWs = null;
let tftpFileData = null;
let tftpFileName = '';
```

- [ ] **Step 2: Add TFTP WebSocket functions**

```js
function connectTftpProxy() {
  const btn = document.getElementById('tftpConnectBtn');
  if (tftpWs && tftpWs.readyState === WebSocket.OPEN) {
    tftpWs.close();
    return;
  }

  try {
    tftpWs = new WebSocket('ws://localhost:52345');

    tftpWs.onopen = () => {
      updateTftpStatus(true);
      btn.textContent = '断开代理';
      tftpLog('sys', '◈ 代理已连接');
      document.getElementById('tftpUploadBtn').disabled = !tftpFileData;
    };

    tftpWs.onclose = () => {
      updateTftpStatus(false);
      btn.textContent = '连接代理';
      tftpLog('sys', '○ 代理已断开');
      document.getElementById('tftpUploadBtn').disabled = true;
      tftpWs = null;
    };

    tftpWs.onerror = () => {
      tftpLog('err', '✖ WebSocket 连接失败');
      tftpWs.close();
    };

    tftpWs.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case 'progress':
            document.getElementById('tftpProgress').style.display = '';
            const pct = Math.round((msg.sent / msg.total) * 100);
            document.getElementById('tftpProgressFill').style.width = pct + '%';
            document.getElementById('tftpProgressPct').textContent = pct + '%';
            tftpLog('info', '▶ 已发送 ' + formatBytes(msg.sent) + ' / ' + formatBytes(msg.total));
            break;
          case 'complete':
            tftpLog('ok', '✔ 上传完成: ' + msg.filename);
            document.getElementById('tftpProgressFill').style.width = '100%';
            document.getElementById('tftpProgressPct').textContent = '100%';
            break;
          case 'error':
            tftpLog('err', '✖ ' + msg.message);
            break;
        }
      } catch(e) {}
    };
  } catch (e) {
    tftpLog('err', '✖ 连接失败: ' + e.message);
  }
}

function updateTftpStatus(connected) {
  const dot = document.getElementById('tftpDot');
  const text = document.getElementById('tftpStatusText');
  dot.classList.toggle('on', connected);
  text.textContent = connected ? '代理已连接' : '代理未连接';
  text.style.color = connected ? '' : '';
}

function tftpLog(type, msg) {
  const log = document.getElementById('tftpLog');
  const div = document.createElement('div');
  div.className = type;
  div.textContent = msg;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
```

- [ ] **Step 3: Add file selection and upload functions**

```js
function onTftpFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  tftpFileName = file.name;
  document.getElementById('tftpFilename').value = file.name;

  const reader = new FileReader();
  reader.onload = (e) => {
    const arr = new Uint8Array(e.target.result);
    tftpFileData = arr;
    document.getElementById('tftpUploadBtn').disabled = !(tftpWs && tftpWs.readyState === WebSocket.OPEN);
    tftpLog('sys', '✔ 已选择文件: ' + file.name + ' (' + formatBytes(arr.length) + ')');
  };
  reader.readAsArrayBuffer(file);
  event.target.value = '';
}

function startTftpUpload() {
  if (!tftpWs || tftpWs.readyState !== WebSocket.OPEN) {
    tftpLog('err', '✖ 代理未连接');
    return;
  }
  if (!tftpFileData) {
    tftpLog('err', '✖ 未选择文件');
    return;
  }

  const host = document.getElementById('tftpHost').value.trim();
  const port = parseInt(document.getElementById('tftpPort').value) || 69;
  if (!host) { tftpLog('err', '✖ 请输入目标 IP'); return; }

  // Clear previous progress
  document.getElementById('tftpProgress').style.display = '';
  document.getElementById('tftpProgressFill').style.width = '0%';
  document.getElementById('tftpProgressPct').textContent = '0%';
  tftpLog('info', '▶ 正在上传 ' + tftpFileName + ' ...');

  // Convert file data to base64
  let binary = '';
  for (const b of tftpFileData) binary += String.fromCharCode(b);
  const base64 = btoa(binary);

  tftpWs.send(JSON.stringify({
    type: 'upload',
    addr: host,
    port: port,
    filename: tftpFileName,
    data: base64
  }));
}
```

- [ ] **Step 4: Verify TFTP tool**

Start `node tftp-proxy.js`. Click "连接代理" — status turns green, log shows "代理已连接". Select a file. Enter target IP. Click "上传文件" — progress bar advances, log shows progress.

### Task 9: Integration Verification

- [ ] **Step 1: Full feature walkthrough**

1. Open `WebSerialTerminal.html` in Chrome
2. Click toolbar "工具箱" button — right sidebar opens
3. Verify all 4 tool headers visible, checksum expanded by default
4. Test checksum: ASCII "hello" CRC32 → `0x8B1D995F`. Try HEX mode, change algorithms
5. Test float: 3.14 → hex `0x4048F5C3`. Switch to double. Reverse convert `4048F5C3` → 3.14
6. Test ASCII: browse table, search "65" → shows 'A' details
7. Test TFTP: start `tftp-proxy.js`, connect, select file, enter IP, upload
8. Close right sidebar — terminal area fills space
9. Verify existing features still work: serial connect, macros, settings, log save

- [ ] **Step 2: Verify no console errors**

Open DevTools Console — no errors on load, expand/collapse tools, input changes, etc.
