# Modbus RTU 主视图 + 循环发送 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add main-area Modbus view (replaces terminal) and cycle-send feature to the Modbus RTU debug tool.

**Architecture:** Pure extension of the single-file `WebSerialTerminal.html`. When Modbus activates, the terminal output area is replaced by a full Modbus debug view with request builder, TX/RX frames, response parser, and log. A new cycle-send system uses `setInterval` with manual start/stop.

**Tech Stack:** Pure Web Serial API (single HTML file, no dependencies)

**File:** `WebSerialTerminal.html` (~4139 lines, all changes in this file)

---

### Task 1: CSS for Modbus Main View

**Files:**
- Modify: `WebSerialTerminal.html:1455` (before `</style>`)

- [ ] **Step 1: Add Modbus main view styles before `</style>`**

Insert after line 1453 (after `.modbus-freeze-hint.show` block, before `</style>` at line 1455):

```css
/* Modbus main view */
.modbus-view {
  display: none;
  flex-direction: column;
  height: 100%;
  width: 100%;
  padding: 12px 16px;
  overflow: hidden;
  gap: 6px;
}
.modbus-view.active { display: flex; }
.modbus-view-section {
  background: rgba(0,0,0,0.25);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 10px;
}
.modbus-view-section-title {
  font-size: 9px;
  color: var(--accent);
  letter-spacing: 2px;
  text-transform: uppercase;
  margin-bottom: 6px;
  opacity: 0.7;
}
.modbus-view-row {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.modbus-view-row .tool-input { height: 26px; font-size: 11px; }
.modbus-view-row .tool-select { height: 26px; font-size: 11px; }
.modbus-view-label {
  font-size: 10px;
  color: var(--text-dim);
  white-space: nowrap;
}
.modbus-view-btn {
  height: 26px;
  padding: 0 14px;
  font-size: 10px;
  letter-spacing: 1px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: rgba(255,255,255,0.05);
  color: var(--text-primary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s;
}
.modbus-view-btn:hover { background: rgba(255,255,255,0.12); }
.modbus-view-btn.primary { background: var(--accent); color: var(--bg-primary); border-color: var(--accent); }
.modbus-view-btn.primary:hover { background: var(--accent-hover); }
.modbus-view-btn.danger { border-color: var(--red); color: var(--red); }
.modbus-view-btn.danger:hover { background: rgba(255,68,68,0.15); }
.modbus-view-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.modbus-view-frames {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.modbus-view-log {
  max-height: 120px;
  overflow-y: auto;
}
.modbus-view .modbus-reg-table { font-size: 10px; }
.modbus-view .modbus-coil-container { gap: 2px; }
.modbus-view .modbus-coil-bit { width: 18px; height: 18px; font-size: 9px; }
.modbus-cycle-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--amber);
  letter-spacing: 1px;
  margin-left: 8px;
}
.modbus-cycle-indicator .pulse {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--amber);
  animation: mbPulse 1s infinite;
}
@keyframes mbPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
```

- [ ] **Step 2: Verify**

Confirm CSS syntax correct, class names match HTML.

---

### Task 2: HTML for Modbus Main View Container

**Files:**
- Modify: `WebSerialTerminal.html:1638` (after `#terminalOutput` div, inside `terminal-wrapper`)

- [ ] **Step 1: Insert `#modbusView` container after `#terminalOutput`**

After line 1638 (`<!-- Welcome message -->` inside `#terminalOutput`), insert:

```html
    <!-- Modbus Main View -->
    <div class="modbus-view" id="modbusView">
      <!-- Request Builder -->
      <div class="modbus-view-section" style="flex-shrink:0;">
        <div class="modbus-view-section-title">请求构建器</div>
        <div class="modbus-view-row" style="margin-bottom:4px;">
          <span class="modbus-view-label">从站</span>
          <input type="number" class="tool-input" id="mvSlaveId" value="1" min="1" max="247" style="width:55px; text-align:center;">
          <select class="tool-select" id="mvFuncCode" style="width:160px;" onchange="modbusViewSync()">
            <option value="1">01 - Read Coils</option>
            <option value="2">02 - Read Discrete Inputs</option>
            <option value="3" selected>03 - Read Holding Registers</option>
            <option value="4">04 - Read Input Registers</option>
            <option value="5">05 - Write Single Coil</option>
            <option value="6">06 - Write Single Register</option>
            <option value="15">15 (0F) - Write Multiple Coils</option>
            <option value="16">16 (10) - Write Multiple Registers</option>
          </select>
          <span class="modbus-view-label">地址</span>
          <input type="text" class="tool-input" id="mvAddress" value="0" style="width:60px;">
          <span class="modbus-view-label">数量</span>
          <input type="number" class="tool-input" id="mvQuantity" value="10" min="1" max="2000" style="width:55px; text-align:center;">
        </div>
        <div class="modbus-view-row" style="margin-bottom:4px;">
          <span class="modbus-view-label">写入 (HEX)</span>
          <input type="text" class="tool-input" id="mvWriteData" placeholder="00 FF 00 01..." style="flex:1; max-width:300px;">
          <span class="modbus-view-label">DEC
            <span class="toggle-track" style="display:inline-flex; width:28px; height:14px; margin:0 4px; vertical-align:middle;">
              <span class="toggle-thumb" style="width:12px; height:12px;"></span>
            </span>
            HEX
          </span>
          <label class="toggle-switch" style="flex-shrink:0;">
            <input type="checkbox" id="mvAddrMode" onchange="modbusViewSyncAddrMode()" hidden>
          </label>
          <span class="modbus-view-label" style="margin-left:12px;">循环间隔</span>
          <input type="number" class="tool-input" id="mvCycleInterval" value="1000" min="100" max="60000" style="width:65px; text-align:center;">
          <span class="modbus-view-label">ms</span>
        </div>
        <div class="modbus-view-row">
          <button class="modbus-view-btn primary" id="mvSendBtn" onclick="modbusViewSend()">▶ 发送</button>
          <button class="modbus-view-btn" id="mvCycleBtn" onclick="modbusViewToggleCycle()">⟳ 开始循环</button>
          <button class="modbus-view-btn danger" id="mvStopBtn" onclick="modbusViewStop()" disabled>■ 停止</button>
          <span class="modbus-cycle-indicator" id="mvCycleIndicator" style="display:none;"><span class="pulse"></span> 循环中 <span id="mvCycleCount">0</span></span>
        </div>
      </div>

      <!-- TX/RX Frames -->
      <div class="modbus-view-section modbus-view-frames" id="mvFramesSection">
        <div class="modbus-view-section-title">帧 监视</div>
        <div id="mvTxDisplay" style="margin-bottom:4px;"></div>
        <div id="mvRxDisplay" style="margin-bottom:4px;"></div>
        <div id="mvDataDisplay"></div>
      </div>

      <!-- Log -->
      <div class="modbus-view-section modbus-view-log" style="flex-shrink:0;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
          <span class="modbus-view-section-title" style="margin-bottom:0;">日志</span>
          <span style="font-size:9px; color:var(--text-dim);" id="mvLogCount">0 条</span>
        </div>
        <div class="modbus-log-list" id="mvLogList" style="max-height:80px;"></div>
      </div>
    </div>
```

- [ ] **Step 2: Verify**

Search confirming new element IDs (`mvSlaveId`, `mvFuncCode`, etc.) are unique.

---

### Task 3: JS Cycling State Variables

**Files:**
- Modify: `WebSerialTerminal.html:3725` (after existing modbus state variables)

- [ ] **Step 1: Add cycling state variables after `modbusReadLoopRunning`**

After line 3725 (`let modbusReadLoopRunning = false;`), insert:

```js
// Modbus cycling state
let modbusCycling = false;
let modbusCycleTimer = null;
let modbusCycleCount = 0;
```

- [ ] **Step 2: Verify**

Confirm no variable name conflicts in file.

---

### Task 4: JS — View Switching + Sync Logic

**Files:**
- Modify: `WebSerialTerminal.html:3892` (functions after MODBUS MODE MANAGEMENT section)

- [ ] **Step 1: Add `modbusViewToggle()` and sync functions after `modbusSetMode()`**

After line 3988 (end of `modbusSetMode()`), insert:

```js
// ════════════════════════════════════════════════════════
// MODBUS MAIN VIEW MANAGEMENT
// ════════════════════════════════════════════════════════
function modbusViewToggle(show) {
  const view = document.getElementById('modbusView');
  const term = document.getElementById('terminalOutput');
  if (show) {
    view.classList.add('active');
    term.style.display = 'none';
    // Sync controls from right sidebar
    modbusViewSync();
    // Hide right sidebar Modbus panel
    const mbPanel = document.getElementById('toolModbus');
    if (mbPanel && mbPanel.style.display !== 'none') {
      toggleTool('modbus');
    }
  } else {
    view.classList.remove('active');
    term.style.display = '';
  }
}

function modbusViewSync() {
  // Copy values from main view controls to right sidebar controls
  const map = {
    'mvSlaveId': 'mbSlaveId',
    'mvFuncCode': 'mbFuncCode',
    'mvAddress': 'mbAddress',
    'mvQuantity': 'mbQuantity',
    'mvWriteData': 'mbWriteData'
  };
  for (const [src, dst] of Object.entries(map)) {
    const s = document.getElementById(src);
    const d = document.getElementById(dst);
    if (s && d) d.value = s.value;
  }
  // Sync addr mode
  const mvAddr = document.getElementById('mvAddrMode');
  const mbAddr = document.getElementById('mbAddrMode');
  if (mvAddr && mbAddr) mbAddr.checked = mvAddr.checked;
  modbusToggleAddrMode();
}

function modbusViewSyncAddrMode() {
  const checked = document.getElementById('mvAddrMode').checked;
  document.getElementById('mbAddrMode').checked = checked;
  modbusToggleAddrMode();
}

function modbusViewSend() {
  // Sync controls then send
  modbusViewSync();
  modbusSend();
}

function modbusViewStop() {
  // Stop cycling if active
  if (modbusCycling) {
    modbusStopCycle();
  }
}
```

- [ ] **Step 2: Modify `modbusToggleActive()` to toggle main view**

Replace lines 3892-3938 (`function modbusToggleActive()`) with:

```js
function modbusToggleActive() {
  const active = document.getElementById('mbActivate').checked;
  modbusActive = active;
  document.getElementById('mbModeSelect').style.display = active ? '' : 'none';

  if (!active) {
    // Turning OFF Modbus mode
    if (modbusCycling) modbusStopCycle();
    if (modbusPortMode === 'independent' && modbusConnected) {
      modbusDisconnectPort();
    }
    if (modbusPortMode === 'shared') {
      // Restore terminal
      isPaused = false;
      document.getElementById('inputField').disabled = false;
      document.getElementById('btnSend').disabled = false;
      document.getElementById('mbFreezeHint').classList.remove('show');
    }
    document.getElementById('mbStatusBar').style.display = 'none';
    modbusViewToggle(false);
    showNotification('Modbus 模式已关闭');
    return;
  }

  // Turning ON Modbus mode
  document.getElementById('mbStatusBar').style.display = 'inline-flex';
  modbusViewToggle(true);

  if (modbusPortMode === 'shared') {
    if (!isConnected) {
      showNotification('请先在终端连接串口设备', 'error');
      modbusActive = false;
      document.getElementById('mbActivate').checked = false;
      document.getElementById('mbModeSelect').style.display = 'none';
      document.getElementById('mbStatusBar').style.display = 'none';
      modbusViewToggle(false);
      return;
    }
    // Freeze terminal
    isPaused = true;
    document.getElementById('inputField').disabled = true;
    document.getElementById('btnSend').disabled = true;
    document.getElementById('mbFreezeHint').classList.add('show');
    document.getElementById('mbConnectBtn').style.display = 'none';
    showNotification('Modbus 模式 — 共享串口');
  } else {
    // Independent mode — show connect button
    document.getElementById('mbConnectBtn').style.display = '';
    showNotification('Modbus 模式 — 请连接独立串口');
  }
}
```

- [ ] **Step 3: Verify**

Confirm `modbusViewToggle` is called at all entry/exit points of `modbusToggleActive`.

---

### Task 5: JS — Cycle Functions

**Files:**
- Modify: `WebSerialTerminal.html` (after `modbusViewStop()` from Task 4)

- [ ] **Step 1: Add `modbusStartCycle()` and `modbusStopCycle()`**

Insert after `modbusViewStop()`:

```js
// ════════════════════════════════════════════════════════
// MODBUS CYCLING
// ════════════════════════════════════════════════════════
function modbusViewToggleCycle() {
  if (modbusCycling) {
    modbusStopCycle();
  } else {
    modbusStartCycle();
  }
}

function modbusStartCycle() {
  const interval = parseInt(document.getElementById('mvCycleInterval').value);
  if (isNaN(interval) || interval < 100 || interval > 60000) {
    showNotification('循环间隔需在 100-60000ms 之间', 'error');
    return;
  }

  modbusCycling = true;
  modbusCycleCount = 0;

  // Update UI
  document.getElementById('mvCycleBtn').textContent = '⟳ 循环中...';
  document.getElementById('mvCycleBtn').disabled = true;
  document.getElementById('mvStopBtn').disabled = false;
  document.getElementById('mvCycleIndicator').style.display = 'inline-flex';
  document.getElementById('mvSendBtn').disabled = true;

  // Send immediately first
  modbusViewSend();
  if (modbusCycling) {
    modbusCycleCount = 1;
    document.getElementById('mvCycleCount').textContent = modbusCycleCount;
  }

  // Schedule recurring sends
  if (modbusCycleTimer) clearInterval(modbusCycleTimer);
  modbusCycleTimer = setInterval(() => {
    if (!modbusCycling || !modbusActive) {
      modbusStopCycle();
      return;
    }
    modbusViewSend();
    modbusCycleCount++;
    document.getElementById('mvCycleCount').textContent = modbusCycleCount;
  }, interval);

  showNotification('循环发送已启动，间隔: ' + interval + 'ms');
}

function modbusStopCycle() {
  modbusCycling = false;
  if (modbusCycleTimer) {
    clearInterval(modbusCycleTimer);
    modbusCycleTimer = null;
  }

  // Update UI
  document.getElementById('mvCycleBtn').textContent = '⟳ 开始循环';
  document.getElementById('mvCycleBtn').disabled = false;
  document.getElementById('mvStopBtn').disabled = true;
  document.getElementById('mvCycleIndicator').style.display = 'none';
  document.getElementById('mvSendBtn').disabled = false;

  showNotification('循环发送已停止，共发送: ' + modbusCycleCount + ' 次');
}
```

- [ ] **Step 2: Wire TX/RX display to main view**

The existing `modbusShowResponse()`, `modbusAddLog()`, and frame display functions write to `#modbusTxDisplay`, `#modbusRxDisplay`, etc. in the right sidebar. Need to also update main view displays. Add a helper after the cycle functions:

```js
// Also update main view displays
function modbusViewUpdateTx(html) {
  const el = document.getElementById('mvTxDisplay');
  if (el) el.innerHTML = html;
}
function modbusViewUpdateRx(html) {
  const el = document.getElementById('mvRxDisplay');
  if (el) el.innerHTML = html;
}
function modbusViewUpdateData(html) {
  const el = document.getElementById('mvDataDisplay');
  if (el) el.innerHTML = html;
}
function modbusViewUpdateLog() {
  const list = document.getElementById('mvLogList');
  const count = document.getElementById('mvLogCount');
  if (!list) return;
  list.innerHTML = document.getElementById('modbusLogList').innerHTML;
  if (count) count.textContent = modbusLog.length + ' 条';
}
```

- [ ] **Step 3: Modify `modbusAddLog()` to sync main view log**

Find `modbusAddLog()` function (~3880 area) and add a main view sync at the end. Read the current function first.

---

### Task 6: JS — Integration (Wire existing functions to main view)

**Files:**
- Modify: `WebSerialTerminal.html`

- [ ] **Step 1: Modify `modbusSend()` to update main view TX display**

In `modbusSend()` (~3750 area), after the frame is sent and displayed in `#modbusTxDisplay`, also update `#mvTxDisplay`:

Find the line that sets `modbusTxDisplay` innerHTML (after `modbusStartWait(frame)` call) and add after it:
```js
  // Also update main view
  const mvTx = document.getElementById('mvTxDisplay');
  if (mvTx) mvTx.innerHTML = document.getElementById('modbusTxDisplay').innerHTML;
```

- [ ] **Step 2: Modify `modbusShowResponse()` to update main view RX/data**

In `modbusShowResponse()`, after setting `modbusRxDisplay.innerHTML` and `modbusDataDisplay.innerHTML`, add:
```js
  // Also update main view
  const mvRx = document.getElementById('mvRxDisplay');
  if (mvRx) mvRx.innerHTML = document.getElementById('modbusRxDisplay').innerHTML;
  const mvData = document.getElementById('mvDataDisplay');
  if (mvData) mvData.innerHTML = document.getElementById('modbusDataDisplay').innerHTML;
```

- [ ] **Step 3: Modify `modbusAddLog()` to update main view log**

In `modbusAddLog()`, at the end of the function, add:
```js
  // Sync main view log
  const mvList = document.getElementById('mvLogList');
  const mvCount = document.getElementById('mvLogCount');
  if (mvList) mvList.innerHTML = document.getElementById('modbusLogList').innerHTML;
  if (mvCount) mvCount.textContent = modbusLog.length + ' 条';
```

- [ ] **Step 4: Stop cycling on disconnect/mode change**

In `disconnectPort()` (~2645), after the existing Modbus shared mode auto-exit, add cycling stop:

Find the existing modbus block in `disconnectPort()`:
```js
  if (modbusActive && modbusPortMode === 'shared') {
    document.getElementById('mbActivate').checked = false;
    modbusToggleActive();
  }
```

After this block, add:
```js
  // Stop cycling on disconnect
  if (modbusCycling) modbusStopCycle();
```

In `modbusSetMode()` (~3941), add cycling stop when switching modes. Insert after `if (mode === modbusPortMode) return;`:
```js
  if (modbusCycling) modbusStopCycle();
```

In `modbusDisconnectPort()` (~4029), add cycling stop at the beginning:
```js
  if (modbusCycling) modbusStopCycle();
```

- [ ] **Step 5: Verify all integration points**

Search for all functions that should stop cycling: disconnectPort, modbusToggleActive (off), modbusSetMode, modbusDisconnectPort. Ensure each calls `modbusStopCycle()`.

---

### Task 7: Right Sidebar Cycle Button Integration

**Files:**
- Modify: `WebSerialTerminal.html`

- [ ] **Step 1: Add cycle button to right sidebar Modbus panel**

In the right sidebar Modbus panel (~1972 area, near the send button), add cycle controls after the send button row:

Find:
```html
            <button class="tool-btn primary" id="mbSendBtn" onclick="modbusSend()" style="flex:1;">▶ 发送</button>
            <label class="toggle-switch" style="flex-shrink:0;">
```

Insert a cycle button between them:
```html
            <button class="tool-btn" id="mbCycleBtn" onclick="modbusSidebarCycle()" style="flex:1;">⟳ 循环</button>
```

At the end of the Modbus panel body (before `</div>` closing `toolModbus`), add hidden cycle status:
```html
        <div id="mbCycleStatus" style="display:none; font-size:9px; color:var(--amber); padding:4px 0; text-align:center;">
          <span class="pulse" style="display:inline-block; width:4px; height:4px; border-radius:50%; background:var(--amber; animation:mbPulse 1s infinite;"></span>
          循环中: <span id="mbSidebarCycleCount">0</span>
        </div>
```

- [ ] **Step 2: Add `modbusSidebarCycle()` function**

In the JS area (after cycling functions), add:
```js
function modbusSidebarCycle() {
  // Forward to main view cycle toggle
  modbusViewToggleCycle();
}
```

- [ ] **Step 3: Verify**

Confirm sidebar cycle button only visible when Modbus is active and main view is shown.

---

### Task 8: Integration Verification

- [ ] **Step 1: Page load check**

Open `WebSerialTerminal.html` in browser, confirm:
1. No JS errors on load
2. Normal terminal display unchanged when Modbus off
3. Right sidebar Modbus panel toggle works

- [ ] **Step 2: Main view check**

1. Connect serial port
2. Activate Modbus shared mode
3. Confirm terminal output hides, Modbus main view appears
4. Confirm request builder controls functional
5. Confirm TX/RX display area visible
6. Confirm log area visible

- [ ] **Step 3: Cycle check**

1. In main view, set cycle interval to 1000ms
2. Click "开始循环" → confirm immediate send + recurring sends
3. Confirm "循环中" indicator shows with count
4. Click "停止" → confirm cycling stops
5. Re-activate → confirm cycling does NOT resume

- [ ] **Step 4: Deactivate check**

1. Cycling active → deactivate Modbus
2. Confirm cycling stops
3. Confirm terminal output reappears
4. Confirm Modbus view hidden

- [ ] **Step 5: Edge cases**

1. Cycle interval < 100 or > 60000 → show error
2. Disconnect serial while cycling → cycle stops
3. Switch modes while cycling → cycle stops
4. Close Modbus panel while active → auto-exit, cycle stops
