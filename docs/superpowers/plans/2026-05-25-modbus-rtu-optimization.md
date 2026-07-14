# Modbus RTU 工具优化 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Modbus RTU 调试工具增加共享串口 / 独立串口两种模式，支持终端冻结 + 独立串口连接。

**Architecture:** 轻量扩展方案。在现有 `WebSerialTerminal.html` 单文件中新增 JS 函数、HTML 控件和少量 CSS，不重构现有核心逻辑。共享模式复用全局 `writer`/`readLoop`，独立模式用独立 `port`/`reader`/`writer`。

**Tech Stack:** 纯 Web Serial API（单 HTML 文件，无依赖）

**File:** `WebSerialTerminal.html`（~3800 行，所有改动在此文件内）

---

### Task 1: 新增状态变量

**Files:**
- Modify: `WebSerialTerminal.html:1984-1992`

- [ ] **Step 1: 在现有 Modbus 状态变量后添加新变量**

在 `let modbusAddrHex = false;`（~3712 行）附近找到。更准确地说，在现有 Modbus 变量区域（~3510 区域已有 `let modbusResponseBuffer = []` 等），增加：

```js
// Modbus mode state
let modbusActive = false;
let modbusPortMode = 'shared'; // 'shared' | 'independent'
let modbusPort = null;
let modbusReader = null;
let modbusWriter = null;
let modbusConnected = false;
let modbusReadLoopRunning = false;
```

插入位置：在 `const MODBUS_LOG_MAX = 100;`（~3594）之后、`function modbusStartWait(frame)` 之前。

- [ ] **Step 2: 验证**

搜索文件确认变量无拼写冲突，确认插入位置正确。

---

### Task 2: 新增 CSS 样式

**Files:**
- Modify: `WebSerialTerminal.html:~1415`（`</style>` 之前）

- [ ] **Step 1: 在 `</style>` 前添加 Modbus 模式新样式**

```css
/* Modbus mode indicator */
#mbModeSelect { margin-bottom: 8px; }
#mbIndependentSection { margin-bottom: 8px; }
#mbIndependentSection .tool-status { margin-bottom: 4px; }

.mb-status-bar {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  background: rgba(0,212,255,0.1);
  border: 1px solid var(--accent-dim);
  border-radius: 3px;
  font-size: 9px;
  color: var(--accent);
  letter-spacing: 1px;
  margin-right: 8px;
}
.mb-status-bar.active { background: rgba(0,255,136,0.1); border-color: var(--green-dim); color: var(--green); }

/* Freeze overlay hint - subtle indicator when terminal is frozen for Modbus */
.modbus-freeze-hint {
  position: absolute;
  top: 8px;
  right: 12px;
  font-size: 9px;
  letter-spacing: 2px;
  color: var(--accent-dim);
  background: rgba(0,0,0,0.6);
  padding: 3px 10px;
  border-radius: 3px;
  border: 1px solid var(--accent-dim);
  z-index: 50;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.3s;
}
.modbus-freeze-hint.show { opacity: 1; }
```

- [ ] **Step 2: 验证**

确认 CSS 语法正确，选择器与 HTML 中使用的 class/id 匹配。

---

### Task 3: 新增 Modbus 面板 HTML 控件

**Files:**
- Modify: `WebSerialTerminal.html:~1825`（Modbus 面板 HTML 区域）

- [ ] **Step 1: 在 Modbus 面板 body 开头插入新模式控件**

当前 Modbus 面板 HTML 结构：
```html
<div class="tool-body" id="toolModbus" style="display:none">
  <div class="tool-field">  ← 从站 ID
```

在此 `tool-body` 开头（`<div class="tool-body" id="toolModbus" style="display:none">` 之后第一行）插入：

```html
        <!-- Modbus mode toggle + mode select -->
        <div class="tool-field" style="border-bottom:1px solid var(--border); padding-bottom:8px; margin-bottom:8px;">
          <label class="toggle-switch" style="justify-content:space-between; width:100%;">
            <span class="toggle-label" id="mbToggleLabel">Modbus 模式</span>
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <input type="checkbox" id="mbActivate" onchange="modbusToggleActive()" hidden>
          </label>
        </div>
        <div id="mbModeSelect" style="display:none;">
          <div class="tool-field" style="margin-bottom:6px;">
            <div class="segmented-control">
              <span class="seg-option active" data-mode="shared" onclick="modbusSetMode('shared')">共享串口</span>
              <span class="seg-option" data-mode="independent" onclick="modbusSetMode('independent')">独立串口</span>
            </div>
          </div>
          <div id="mbIndependentSection" style="display:none;">
            <div class="tool-field">
              <button class="tool-btn" id="mbConnectBtn" onclick="modbusConnectPort()">连接独立串口</button>
            </div>
            <div class="tool-field">
              <div class="tool-status" id="mbPortStatus" style="display:none;">
                <span class="status-dot-sm" id="mbPortDot"></span>
                <span id="mbPortInfo">--</span>
              </div>
            </div>
            <div class="tool-divider"></div>
          </div>
        </div>
```

- [ ] **Step 2: 在状态栏添加 Modbus 模式指示器**

在状态栏 HTML（`<div class="statusbar">...</div>`，~1896）中的 `#statusMode` 元素后添加：

```html
  <span class="mb-status-bar" id="mbStatusBar" style="display:none;">⎔ MODBUS</span>
```

插入位置：`<div class="status-item highlight" id="statusMode">ASCII MODE</div>`（~1904）之后。

- [ ] **Step 3: 在 terminal-wrapper 添加冻结提示**

在 `<div class="terminal-wrapper">`（~1597）内部的 `.terminal-output` 元素后添加：

```html
      <div class="modbus-freeze-hint" id="mbFreezeHint">◆ MODBUS ACTIVE — 终端已暂停</div>
```

插入位置：`<div class="terminal-output" id="terminalOutput">`（~1598）之后。

- [ ] **Step 4: 验证**

搜索确认新元素 id 在文件中唯一，无重复。

---

### Task 4: 实现 `modbusToggleActive()` — 主开关

**Files:**
- Modify: `WebSerialTerminal.html:~3510`（Modbus JS 区域）

- [ ] **Step 1: 在 `modbusSelfTest()` 前添加 toggle 函数**

在 `modbusSelfTest()` 函数（~3758）之前插入：

```js
// ════════════════════════════════════════════════════════
// MODBUS MODE MANAGEMENT
// ════════════════════════════════════════════════════════
function modbusToggleActive() {
  const active = document.getElementById('mbActivate').checked;
  modbusActive = active;
  document.getElementById('mbModeSelect').style.display = active ? '' : 'none';

  if (!active) {
    // Turning OFF Modbus mode
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
    showNotification('Modbus 模式已关闭');
    return;
  }

  // Turning ON Modbus mode
  document.getElementById('mbStatusBar').style.display = 'inline-flex';

  if (modbusPortMode === 'shared') {
    if (!isConnected) {
      showNotification('请先在终端连接串口设备', 'error');
      modbusActive = false;
      document.getElementById('mbActivate').checked = false;
      document.getElementById('mbModeSelect').style.display = 'none';
      document.getElementById('mbStatusBar').style.display = 'none';
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

- [ ] **Step 2: 验证**

检查 `modbusToggleActive` 中对 `isConnected`（全局变量）的引用正确，`isPaused` 已在现有代码中定义。

---

### Task 5: 实现 `modbusSetMode()` — 模式切换

**Files:**
- Modify: `WebSerialTerminal.html`（接在 `modbusToggleActive()` 之后）

- [ ] **Step 1: 添加模式切换函数**

```js
function modbusSetMode(mode) {
  if (mode === modbusPortMode) return;

  // Cleanup current mode
  if (modbusPortMode === 'independent' && modbusConnected) {
    modbusDisconnectPort();
  }
  if (modbusPortMode === 'shared' && modbusActive) {
    // Restore terminal before switching
    isPaused = false;
    document.getElementById('inputField').disabled = false;
    document.getElementById('btnSend').disabled = false;
    document.getElementById('mbFreezeHint').classList.remove('show');
  }

  modbusPortMode = mode;

  // Update UI for new mode
  document.querySelectorAll('#mbModeSelect .seg-option').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === mode);
  });

  const indepSection = document.getElementById('mbIndependentSection');
  if (mode === 'independent') {
    indepSection.style.display = '';
    document.getElementById('mbConnectBtn').style.display = '';
    document.getElementById('mbConnectBtn').textContent = '连接独立串口';
    document.getElementById('mbPortStatus').style.display = 'none';
  } else {
    indepSection.style.display = 'none';
    if (modbusActive) {
      // Re-freeze terminal in shared mode
      if (!isConnected) {
        showNotification('请先在终端连接串口设备', 'error');
        modbusActive = false;
        document.getElementById('mbActivate').checked = false;
        document.getElementById('mbModeSelect').style.display = 'none';
        document.getElementById('mbStatusBar').style.display = 'none';
        return;
      }
      isPaused = true;
      document.getElementById('inputField').disabled = true;
      document.getElementById('btnSend').disabled = true;
      document.getElementById('mbFreezeHint').classList.add('show');
    }
  }
  showNotification(mode === 'shared' ? '已切换为共享串口模式' : '已切换为独立串口模式');
}
```

- [ ] **Step 2: 验证**

确认 segmented control 的 DOM 结构与 HTML 中定义的匹配（`data-mode` 属性）。

---

### Task 6: 实现独立串口连接/断开

**Files:**
- Modify: `WebSerialTerminal.html`（接在 `modbusSetMode()` 之后）

- [ ] **Step 1: 添加 `modbusConnectPort()`**

```js
async function modbusConnectPort() {
  try {
    modbusPort = await navigator.serial.requestPort();
    const baudRate = parseInt(document.getElementById('baudRate').value);
    const dataBits = parseInt(document.getElementById('dataBits').value);
    const stopBits = parseInt(document.getElementById('stopBits').value);
    const parity = document.getElementById('parity').value;
    const flowControl = document.getElementById('flowControl').value;

    await modbusPort.open({ baudRate, dataBits, stopBits, parity, flowControl });

    modbusConnected = true;
    modbusWriter = modbusPort.writable.getWriter();

    const info = modbusPort.getInfo();
    const portStr = info.usbVendorId
      ? `VID:${info.usbVendorId.toString(16).toUpperCase().padStart(4,'0')} PID:${info.usbProductId.toString(16).toUpperCase().padStart(4,'0')}`
      : 'Serial Port';

    // Update status
    const dot = document.getElementById('mbPortDot');
    const infoEl = document.getElementById('mbPortInfo');
    dot.classList.add('on');
    infoEl.textContent = `${portStr} @ ${baudRate}`;
    document.getElementById('mbPortStatus').style.display = '';
    document.getElementById('mbConnectBtn').textContent = '断开独立串口';

    showNotification('独立串口已连接', 'success');
    modbusReadLoop();
  } catch (e) {
    if (e.name !== 'NotFoundError') {
      showNotification('独立串口连接失败: ' + e.message, 'error');
    }
    modbusPort = null;
    modbusConnected = false;
  }
}
```

- [ ] **Step 2: 添加 `modbusDisconnectPort()`**

```js
async function modbusDisconnectPort() {
  modbusConnected = false;
  modbusReadLoopRunning = false;

  try {
    if (modbusReader) {
      try { await modbusReader.cancel(); } catch(e) {}
      for (let i = 0; i < 50 && modbusReader; i++) { await sleep(10); }
      modbusReader = null;
    }
    if (modbusWriter) {
      try { modbusWriter.releaseLock(); } catch(e) {}
      modbusWriter = null;
    }
    if (modbusPort) {
      try { await modbusPort.close(); } catch(e) {}
      modbusPort = null;
    }
  } catch(e) {}

  // Update UI
  document.getElementById('mbPortDot').classList.remove('on');
  document.getElementById('mbPortInfo').textContent = '--';
  document.getElementById('mbConnectBtn').textContent = '连接独立串口';
  showNotification('独立串口已断开');
}
```

- [ ] **Step 3: 添加 `modbusReadLoop()`**

```js
async function modbusReadLoop() {
  modbusReadLoopRunning = true;
  try {
    while (modbusPort && modbusPort.readable && modbusConnected) {
      modbusReader = modbusPort.readable.getReader();
      try {
        while (modbusConnected) {
          const { value, done } = await modbusReader.read();
          if (done) break;
          if (!value || !modbusActive) continue;

          // Feed directly to Modbus response parser
          modbusFeedResponse(value);
        }
      } catch (e) {
        if (e.name !== 'AbortError' && modbusConnected) {
          showNotification('独立串口读取错误: ' + e.message, 'error');
        }
      } finally {
        try { modbusReader.releaseLock(); } catch(e) {}
        modbusReader = null;
      }
    }
  } catch(e) {}
  modbusReadLoopRunning = false;

  // Unexpected disconnect
  if (modbusConnected) {
    modbusConnected = false;
    document.getElementById('mbPortDot').classList.remove('on');
    document.getElementById('mbPortInfo').textContent = '已断开';
    document.getElementById('mbConnectBtn').textContent = '连接独立串口';
    showNotification('独立串口连接已中断', 'error');
  }
}
```

- [ ] **Step 4: 验证**

确认 `modbusReadLoop` 与主 `readLoop()` 结构一致，使用相同的 `modbusFeedResponse()` 解析器。

---

### Task 7: 修改现有函数

**Files:**
- Modify: `WebSerialTerminal.html`

- [ ] **Step 1: 修改 `modbusSend()` — 根据模式选择 writer**

在 `modbusSend()`（~3557）中，找到 `writer.write(frame)` 这一行，改为条件选择：

```js
  // 原有 writer.write(frame) 改为：
  const targetWriter = (modbusPortMode === 'independent' && modbusConnected) ? modbusWriter : writer;
  targetWriter.write(frame).then(() => {
    modbusSendTime = Date.now();
    if (typeof modbusStartWait === 'function') modbusStartWait(frame);
  }).catch(err => appendLine('err', `[Modbus] 发送失败: ${err.message}`));
```

并且修改开头的检查，由 `if (!isConnected)` 改为：

```js
  const hasWriter = (modbusPortMode === 'independent') ? modbusConnected : isConnected;
  if (!hasWriter) { showNotification('Modbus: 串口未连接', 'error'); return; }
```

- [ ] **Step 2: 修改 `modbusFeedResponse()` — 共享模式才处理**

`modbusFeedResponse()`（~3609）中的 `if (!modbusPendingRequest) return;` 保持不变，它已经控制了只有等待响应时才处理。不需要额外修改——因为共享模式时主 readLoop 不暂停 `modbusFeedResponse` 调用（第 2722 行），独立模式时由独立 readLoop 调用。

但需要加一个保护：独立模式下主 readLoop 不应调用 `modbusFeedResponse`。

在 `readLoop()` 中（~2722）修改调用行：

```js
  // 原：if (typeof modbusFeedResponse === 'function') modbusFeedResponse(value);
  // 改为：
  if (typeof modbusFeedResponse === 'function' && modbusPortMode !== 'independent') modbusFeedResponse(value);
```

- [ ] **Step 3: 修改 `disconnectPort()` — 共享模式时自动关闭 Modbus**

在 `disconnectPort()` 函数（~2645）开头，`isConnected = false;` 之后添加：

```js
  // If Modbus shared mode is active, turn it off
  if (modbusActive && modbusPortMode === 'shared') {
    document.getElementById('mbActivate').checked = false;
    modbusToggleActive();
  }
```

- [ ] **Step 4: 修改 `toggleTool('modbus')` — 收起面板时退出 Modbus**

在 `toggleTool()` 函数（~2148）末尾添加：

```js
function toggleTool(name) {
  // ... existing code ...
  const body = document.getElementById('tool' + name.charAt(0).toUpperCase() + name.slice(1));
  const arrow = document.getElementById('arrow' + name.charAt(0).toUpperCase() + name.slice(1));
  if (body) body.style.display = toolStates[name] ? '' : 'none';
  if (arrow) arrow.textContent = toolStates[name] ? '▼' : '▶';

  // NEW: If modbus panel is being collapsed while active, turn off modbus mode
  if (name === 'modbus' && !toolStates[name] && modbusActive) {
    document.getElementById('mbActivate').checked = false;
    modbusToggleActive();
  }
}
```

- [ ] **Step 5: 验证**

逐项确认所有修改不破坏原有逻辑路径。

---

### Task 8: 集成验证

**Files:**
- Modify: `WebSerialTerminal.html`

- [ ] **Step 1: 页面加载完整性检查**

在浏览器中打开 `WebSerialTerminal.html`，确认：
1. 页面无 JS 错误
2. 右工具箱 Modbus 面板折叠/展开正常
3. 新模式控件正确渲染

- [ ] **Step 2: 共享模式功能检查**

1. 连接串口设备
2. 打开 Modbus 面板 → 点击 Modbus 模式开关
3. 验证终端暂停（输入禁用、显示暂停、状态栏显示 MODBUS）
4. 发一条 Modbus 请求 → 验证 TX/RX 帧正常显示
5. 关闭 Modbus 模式 → 验证终端恢复
6. 终端断开 → 验证 Modbus 自动退出

- [ ] **Step 3: 独立模式功能检查**

1. 终端连接一个串口设备（随便），正常工作
2. 打开 Modbus → 切换到独立模式
3. 点击「连接独立串口」→ 选另一个串口设备
4. 验证终端继续正常收发，不受影响
5. Modbus 发送请求 → 验证正常收发
6. 断开独立串口 → 验证面板显示断开
7. 关闭 Modbus → 终端仍正常工作

- [ ] **Step 4: 边界情况检查**

1. 共享模式 → 切独立模式 → 终端恢复，出现连接按钮
2. 独立模式已连接 → 切共享模式 → 独立端口被断开
3. 未连接终端时打开共享模式 → 提示错误并自动关闭
4. Modbus 活跃时折叠面板 → 自动退出 Modbus 模式
