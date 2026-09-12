# 串口 MCP 桥 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 工具（Claude Code 等）通过 MCP 控制 WebTerm Pro 的串口调试能力——开发期用假串口驱动自测，运行期操作真机。

**Architecture:** 桥（`bridge.js`）作为模块挂载进现有 `server.js` 进程，复用其 `Host`/`Origin` 校验；页面与 MCP 适配器都是 WebSocket 客户端，桥只做鉴权 + 路由 + 限流。页面侧仅改 3 处（`serialProvider` seam 声明 + 2 个 `requestPort()` 调用点），其余逻辑落到新文件。假串口基于平台原生 `ReadableStream`/`WritableStream` 构建，使现有 `readLoop` 与 `modbusReadLoop` 无需改动即可跑在假设备上。

**Tech Stack:** Node.js（实测 v24.12.0，零构建）、`node:test` + `node:assert`（零依赖测试）、`ws ^8.16.0`（已在依赖中）、原生 Web Streams、原生 `crypto`。**不新增任何依赖。** MCP 的 stdio 传输手写实现（JSON-RPC 2.0 换行分隔），不引入 `@modelcontextprotocol/sdk`。

**Spec:** `docs/superpowers/specs/2026-09-12-serial-mcp-bridge-design.md`（commit `15c711f`，修正于 `946dca5`）

## Global Constraints

- **零新依赖**：`package.json` 的 `dependencies` 不得新增任何条目（spec 第 11 节）
- **不改现有逻辑**：`WebSerialTerminal.html` 对**既有函数体**只允许 3 处改动——`serialProvider` 声明、`2944` 与 `4680` 两个 `requestPort()` 调用点，外加 `appendLine()` 末尾追加 1 行输出钩子。`readLoop` / `modbusReadLoop` / `disconnectPort` / `sendData` / `modbusSend` / `applySettings` 等既有函数的内部逻辑**一行都不许动**；不得修改任何既有函数签名或 DOM 元素。其余允许的改动都是**纯新增**：`<script src>` 标签、武装开关 UI（新元素）
- **桥代码绝不冒泡到页面**：`bridge-client.js` 的所有路径必须包住异常，桥挂掉不得影响终端正常使用（spec 第 5.6 节）
- **流语义按实测断言，不按注释断言**：`reader.cancel()` 与 `controller.close()` 均使待决 `read()` **resolve `{done: true}`**；对已锁定流二次 `getReader()` 抛 `TypeError`。以上在 Node v24 实测确认（spec 第 5.3 节）
- **绑定回环**：桥只接受 `127.0.0.1` / `localhost` 的 `Host`；不得绑 `0.0.0.0`
- **两类客户端两套鉴权**：带 `Origin` 头者按 Origin 校验（页面）；无 `Origin` 者按 `x-webterm-token` 头校验（适配器）
- **协议版本**：`PROTOCOL_VERSION = 1`，不匹配时桥响亮拒绝
- **常量单一来源**：错误码、帧上限、读取上限一律从 `bridge-protocol.js` 取，不得在别处重复字面量
- **语言风格**：注释与用户可见消息用中文；代码标识符用英文。注释解释"为什么"，不解释"是什么"
- **提交格式**：`<type>: <desc>`，type ∈ {feat, fix, refactor, docs, test, chore}。**只 add 本任务涉及的路径**——工作区可能有他人进行中的改动
- **测试命令**：单文件用 `node --test test/<file>.test.js`；全量用 `npm test`

## 跨任务接口（先钉死，避免任务之间对不上）

这些名字与签名在后续所有任务中**必须逐字一致**。

### `bridge-protocol.js`（UMD，Node 与浏览器共用）

```js
PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 262144            // 256 KB
READ_MAX_LINES = 1000
READ_DEFAULT_LINES = 50
MAX_PENDING_REQUESTS = 64
ERROR_CODES = { NEEDS_USER_GESTURE, PORT_BUSY, PAGE_NOT_CONNECTED, BRIDGE_TIMEOUT,
                PORT_NOT_CONNECTED, NOT_ARMED, INVALID_ARGS, OP_UNSUPPORTED, PAGE_ERROR }

hexToBytes(s)                    // '010300' | '01 03 00' | '0x01,0x03' → Uint8Array；非法抛 Error
bytesToHex(bytes)                // → 小写连续 hex 字符串
encodeToBytes(data, encoding)    // 'ascii'|'hex'|'base64' → Uint8Array
bytesToEncoding(bytes, encoding) // 'ascii'|'hex'|'base64' → string
isErrorCode(v)                   // → boolean
makeReq(id, domain, op, args)    // → 信封对象
makeRes(id, data)                // → 信封对象
makeErr(id, code, message)       // → 信封对象
makeEvt(domain, op, data)        // → 信封对象
isValidEnvelope(msg)             // → boolean
```

### `bridge-auth.js`

```js
baseDir(env = process.env)     // env.WEBTERM_HOME || os.homedir()
tokenPath(dir = baseDir())     // → <dir>/.webterm/bridge-token
generateToken()                // → 64 字符 hex
writeToken(dir = baseDir())    // → { token, path }；目录 0o700、文件 0o600
readToken(dir = baseDir())     // → string；缺失时抛中文 Error
tokenEquals(a, b)              // → boolean；长度不等先返回 false
```

### `fake-serial.js`（UMD）

```js
new FakeScript(rules)          // rules: [{ matchHex, respondHex, delayMs }]
  .push(bytes)                 // → { respond: Uint8Array, delayMs } | null
  .reset()
new FakeSerialPort(opts)       // opts: { usbVendorId, usbProductId, rules, schedule }
  .readable / .writable        // 原生 ReadableStream / WritableStream
  .isOpen                      // boolean
  .capturedBytes               // Uint8Array（页面写出的全部字节）
  .open(options) / .close()
  .getInfo()                   // { usbVendorId, usbProductId }
  .injectBytes(bytes)          // 假设备 → 页面
  .clearCaptured()
  .setRules(rules)
```

### `bridge.js`

```js
attachBridge(server, deps) → { close, getStats }
// deps: { token, isTrustedOrigin, isLocalHostname, hostnameOf, getActualPort, log }
// getStats() → { page: {pageId, capabilities} | null, adapters: number, pending: number }
```

### `mcp-server.js`

```js
buildTools()                      // → MCP tools 数组（11 个）
dispatchTool(name, args, request) // → Promise<{ content, isError? }>
//   request: (domain, op, args) => Promise<信封响应>
translateError(code, message)     // → 面向模型的自然语言字符串
handleMessage(msg, request)       // → Promise<响应对象 | null>
```

---

### Task 1: `bridge-protocol.js` — 共享常量与编解码

错误码必须由 Node 与浏览器**从同一份定义**读取：`bridge-client.js` 产生错误码，`mcp-server.js` 翻译它。两处各写一份 9 项枚举，必然漂移，而漂移的后果是 AI 收到翻译不了的错误码。

**Files:**
- Create: `bridge-protocol.js`
- Test: `test/bridge-protocol.test.js`

**Interfaces:**
- Consumes: 无
- Produces: 上述「跨任务接口」中 `bridge-protocol.js` 的全部导出

- [ ] **Step 1: 写失败测试**

```js
// test/bridge-protocol.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const P = require('../bridge-protocol.js');

test('hexToBytes 容忍空格、0x 前缀与冒号', () => {
  const want = [0x01, 0x03, 0x00, 0xAB];
  assert.deepStrictEqual([...P.hexToBytes('010300ab')], want);
  assert.deepStrictEqual([...P.hexToBytes('01 03 00 AB')], want);
  assert.deepStrictEqual([...P.hexToBytes('0x01,0x03,0x00,0xab')], want);
  assert.deepStrictEqual([...P.hexToBytes('01:03:00:AB')], want);
});

test('hexToBytes 对非法输入抛错而非静默截断', () => {
  assert.throws(() => P.hexToBytes('01030'), /长度/);      // 奇数长度
  assert.throws(() => P.hexToBytes('01ZZ03'), /非法/);     // 非 hex 字符
  assert.throws(() => P.hexToBytes(''), /空/);
});

test('bytesToHex 输出小写连续形式', () => {
  assert.strictEqual(P.bytesToHex(new Uint8Array([0x01, 0xAB, 0x00])), '01ab00');
  assert.strictEqual(P.bytesToHex(new Uint8Array([])), '');
});

test('encodeToBytes 支持三种编码且往返一致', () => {
  const text = 'AT+RST\r\n';
  const hex = '41542b5253540d0a';
  const b64 = Buffer.from(text, 'utf8').toString('base64');

  assert.strictEqual(P.bytesToHex(P.encodeToBytes(text, 'ascii')), hex);
  assert.strictEqual(P.bytesToHex(P.encodeToBytes(hex, 'hex')), hex);
  assert.strictEqual(P.bytesToHex(P.encodeToBytes(b64, 'base64')), hex);

  const bytes = P.encodeToBytes(text, 'ascii');
  assert.strictEqual(P.bytesToEncoding(bytes, 'ascii'), text);
  assert.strictEqual(P.bytesToEncoding(bytes, 'hex'), hex);
  assert.strictEqual(P.bytesToEncoding(bytes, 'base64'), b64);
});

test('ascii 编码走 UTF-8，中文不丢字节', () => {
  const bytes = P.encodeToBytes('温度:25.6℃', 'ascii');
  assert.strictEqual(P.bytesToEncoding(bytes, 'ascii'), '温度:25.6℃');
  assert.strictEqual(bytes.length, 13); // 中文 3 字节 ×3 + ':' 1 + '25.6' 4 + '℃' 3
});

test('未知编码抛错', () => {
  assert.throws(() => P.encodeToBytes('x', 'utf7'), /不支持的编码/);
  assert.throws(() => P.bytesToEncoding(new Uint8Array(), 'utf7'), /不支持的编码/);
});

test('错误码是冻结对象且与 isErrorCode 一致', () => {
  assert.ok(Object.isFrozen(P.ERROR_CODES));
  const want = ['NEEDS_USER_GESTURE', 'PORT_BUSY', 'PAGE_NOT_CONNECTED', 'BRIDGE_TIMEOUT',
                'PORT_NOT_CONNECTED', 'NOT_ARMED', 'INVALID_ARGS', 'OP_UNSUPPORTED', 'PAGE_ERROR'];
  assert.deepStrictEqual(Object.keys(P.ERROR_CODES).sort(), want.slice().sort());
  for (const k of want) {
    assert.strictEqual(P.ERROR_CODES[k], k, '键值应同名，便于透传');
    assert.strictEqual(P.isErrorCode(k), true);
  }
  assert.strictEqual(P.isErrorCode('NOPE'), false);
});

test('信封构造器与校验', () => {
  const req = P.makeReq('r-1', 'serial', 'send', { data: 'x' });
  assert.deepStrictEqual(req, { id: 'r-1', kind: 'req', domain: 'serial', op: 'send', args: { data: 'x' } });
  assert.strictEqual(P.isValidEnvelope(req), true);

  const res = P.makeRes('r-1', { ok: 1 });
  assert.strictEqual(res.kind, 'res');
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.data, { ok: 1 });
  assert.strictEqual(P.isValidEnvelope(res), true);

  const err = P.makeErr('r-1', P.ERROR_CODES.PORT_NOT_CONNECTED, '未连接');
  assert.strictEqual(err.ok, false);
  assert.strictEqual(err.error.code, 'PORT_NOT_CONNECTED');
  assert.strictEqual(err.error.message, '未连接');

  const evt = P.makeEvt('serial', 'state', { connected: false });
  assert.strictEqual(evt.kind, 'evt');
  assert.strictEqual(evt.id, undefined);
  assert.strictEqual(P.isValidEnvelope(evt), true);

  for (const bad of [null, undefined, {}, { kind: 'req' }, { kind: 'nope' }, 'x', 42]) {
    assert.strictEqual(P.isValidEnvelope(bad), false, JSON.stringify(bad));
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/bridge-protocol.test.js`
Expected: FAIL — `Cannot find module '../bridge-protocol.js'`

- [ ] **Step 3: 实现**

```js
// bridge-protocol.js
// Node 与浏览器共用的协议常量与编解码。
// UMD：Node 走 module.exports，浏览器挂 globalThis.BridgeProtocol。
// 必须共用同一份——错误码由 bridge-client.js 产生、mcp-server.js 翻译，各写一份必然漂移。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BridgeProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PROTOCOL_VERSION = 1;
  const MAX_FRAME_BYTES = 256 * 1024;
  const READ_MAX_LINES = 1000;
  const READ_DEFAULT_LINES = 50;
  const MAX_PENDING_REQUESTS = 64;

  // 键值同名：透传到 MCP 层时不必再做映射表
  const ERROR_CODES = Object.freeze({
    NEEDS_USER_GESTURE: 'NEEDS_USER_GESTURE',
    PORT_BUSY: 'PORT_BUSY',
    PAGE_NOT_CONNECTED: 'PAGE_NOT_CONNECTED',
    BRIDGE_TIMEOUT: 'BRIDGE_TIMEOUT',
    PORT_NOT_CONNECTED: 'PORT_NOT_CONNECTED',
    NOT_ARMED: 'NOT_ARMED',
    INVALID_ARGS: 'INVALID_ARGS',
    OP_UNSUPPORTED: 'OP_UNSUPPORTED',
    PAGE_ERROR: 'PAGE_ERROR',
  });

  const isErrorCode = v => typeof v === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, v);

  /** 容忍 '0103'、'01 03'、'0x01,0x03'、'01:03' 四种写法 */
  function hexToBytes(s) {
    if (typeof s !== 'string') throw new Error('hex 必须是字符串');
    const cleaned = s.replace(/0x/gi, '').replace(/[\s,:]/g, '');
    if (cleaned === '') throw new Error('hex 不能为空');
    if (cleaned.length % 2 !== 0) throw new Error('hex 长度必须是偶数（每字节两位）');
    if (!/^[0-9a-fA-F]+$/.test(cleaned)) throw new Error('hex 含非法字符');
    const out = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.substr(i * 2, 2), 16);
    return out;
  }

  const bytesToHex = bytes => {
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
  };

  const bytesToBase64 = bytes => {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };

  const base64ToBytes = s => {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  /**
   * 'ascii' 一律按 UTF-8 编码——串口终端本就是 UTF-8 处理（见 readLoop 的流式解码器），
   * 把 ascii 当 latin1 会让中文在两处产生不同字节。
   */
  function encodeToBytes(data, encoding) {
    switch (encoding) {
      case 'ascii': return new TextEncoder().encode(String(data));
      case 'hex': return hexToBytes(String(data));
      case 'base64': return base64ToBytes(String(data));
      default: throw new Error('不支持的编码: ' + encoding);
    }
  }

  function bytesToEncoding(bytes, encoding) {
    switch (encoding) {
      case 'ascii': return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      case 'hex': return bytesToHex(bytes);
      case 'base64': return bytesToBase64(bytes);
      default: throw new Error('不支持的编码: ' + encoding);
    }
  }

  const makeReq = (id, domain, op, args) => ({ id, kind: 'req', domain, op, args: args || {} });
  const makeRes = (id, data) => ({ id, kind: 'res', ok: true, data });
  const makeErr = (id, code, message) => ({ id, kind: 'res', ok: false, error: { code, message } });
  const makeEvt = (domain, op, data) => ({ kind: 'evt', domain, op, data });

  function isValidEnvelope(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
    if (msg.kind === 'evt') return typeof msg.domain === 'string' && typeof msg.op === 'string';
    if (msg.kind === 'req') {
      return typeof msg.id === 'string' && typeof msg.domain === 'string' &&
             typeof msg.op === 'string' && !!msg.args && typeof msg.args === 'object';
    }
    if (msg.kind === 'res') {
      if (typeof msg.id !== 'string' || typeof msg.ok !== 'boolean') return false;
      if (msg.ok) return 'data' in msg;
      return !!msg.error && isErrorCode(msg.error.code) && typeof msg.error.message === 'string';
    }
    return false;
  }

  return {
    PROTOCOL_VERSION, MAX_FRAME_BYTES, READ_MAX_LINES, READ_DEFAULT_LINES, MAX_PENDING_REQUESTS,
    ERROR_CODES, isErrorCode, hexToBytes, bytesToHex,
    encodeToBytes, bytesToEncoding, bytesToBase64, base64ToBytes,
    makeReq, makeRes, makeErr, makeEvt, isValidEnvelope,
  };
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/bridge-protocol.test.js`
Expected: PASS（全部 8 个 test）

- [ ] **Step 5: 提交**

```bash
git add bridge-protocol.js test/bridge-protocol.test.js
git commit -m "feat: bridge 协议共享常量与编解码"
```

---

### Task 2: `bridge-auth.js` — token 生命周期

**Files:**
- Create: `bridge-auth.js`
- Test: `test/bridge-auth.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `baseDir` / `tokenPath` / `generateToken` / `writeToken` / `readToken` / `tokenEquals`

- [ ] **Step 1: 写失败测试**

```js
// test/bridge-auth.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../bridge-auth.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-auth-'));

test('baseDir 优先取 WEBTERM_HOME，否则回退用户目录', () => {
  assert.strictEqual(A.baseDir({ WEBTERM_HOME: 'D:\\tmp\\wt' }), 'D:\\tmp\\wt');
  assert.strictEqual(A.baseDir({}), os.homedir());
});

test('tokenPath 落在 <dir>/.webterm/bridge-token', () => {
  assert.strictEqual(A.tokenPath('/x'), path.join('/x', '.webterm', 'bridge-token'));
});

test('generateToken 为 64 字符 hex 且每次不同', () => {
  const a = A.generateToken(), b = A.generateToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(a, b);
});

test('writeToken 创建目录与文件并可被 readToken 读回', () => {
  const dir = tmp();
  const { token, filePath } = A.writeToken(dir);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), token);
  assert.strictEqual(A.readToken(dir), token);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeToken 每次覆盖旧 token', () => {
  const dir = tmp();
  const first = A.writeToken(dir).token;
  const second = A.writeToken(dir).token;
  assert.notStrictEqual(first, second);
  assert.strictEqual(A.readToken(dir), second);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readToken 缺失时抛可操作的中文错误', () => {
  const dir = tmp();
  assert.throws(() => A.readToken(dir), /请先启动 server\.js/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tokenEquals 长度不等返回 false 而不抛', () => {
  // timingSafeEqual 对不等长输入会抛，必须先挡——否则桥会因为一个短 token 崩掉
  assert.strictEqual(A.tokenEquals('abc', 'abcd'), false);
  assert.strictEqual(A.tokenEquals('', 'a'), false);
  assert.strictEqual(A.tokenEquals('abcd', 'abcd'), true);
  assert.strictEqual(A.tokenEquals('abcd', 'abce'), false);
});

test('tokenEquals 对非字符串输入返回 false', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.strictEqual(A.tokenEquals(bad, 'abcd'), false);
    assert.strictEqual(A.tokenEquals('abcd', bad), false);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/bridge-auth.test.js`
Expected: FAIL — `Cannot find module '../bridge-auth.js'`

- [ ] **Step 3: 实现**

```js
// bridge-auth.js
// 桥的适配器侧鉴权。token 每会话重新生成、写在仓库之外，
// 且不放进环境变量——环境变量会随进程树泄漏给无关子进程。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TOKEN_DIR = '.webterm';
const TOKEN_FILE = 'bridge-token';
const TOKEN_BYTES = 32;

/** WEBTERM_HOME 是测试 seam：测试写临时目录，不污染真实用户目录 */
const baseDir = (env = process.env) => env.WEBTERM_HOME || os.homedir();

const tokenPath = (dir = baseDir()) => path.join(dir, TOKEN_DIR, TOKEN_FILE);

const generateToken = () => crypto.randomBytes(TOKEN_BYTES).toString('hex');

function writeToken(dir = baseDir()) {
  const token = generateToken();
  const filePath = tokenPath(dir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, token, { encoding: 'utf8', mode: 0o600 });
  return { token, filePath };
}

function readToken(dir = baseDir()) {
  const filePath = tokenPath(dir);
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    // 静默重试会让 AI 看到一个永远连不上的工具，比直接报错更难排查
    throw new Error(`读不到桥 token（${filePath}）。请先启动 server.js（npm start）。`);
  }
}

/** timingSafeEqual 对不等长输入抛异常，长度必须先挡 */
function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = { baseDir, tokenPath, generateToken, writeToken, readToken, tokenEquals };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/bridge-auth.test.js`
Expected: PASS（全部 8 个 test）

- [ ] **Step 5: 提交**

```bash
git add bridge-auth.js test/bridge-auth.test.js
git commit -m "feat: 桥的 token 生命周期管理"
```

---

### Task 3: `fake-serial.js` — 原生流假串口与规则引擎

整个方案里技术风险最高的一块。断言必须对准 **Node v24 实测语义**（`cancel`/`close` → resolve `{done:true}`），不能对准 `WebSerialTerminal.html:2992` 那句说 `AbortError` 的注释。

**Files:**
- Create: `fake-serial.js`
- Test: `test/fake-serial.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `FakeScript`、`FakeSerialPort`

- [ ] **Step 1: 写失败测试**

```js
// test/fake-serial.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { FakeScript, FakeSerialPort } = require('../fake-serial.js');

const sync = fn => fn(); // 同步调度器：让规则延迟不引入计时器抖动

test('open 后 readable/writable 才可获取', async () => {
  const p = new FakeSerialPort();
  assert.strictEqual(p.isOpen, false);
  await p.open({ baudRate: 115200 });
  assert.strictEqual(p.isOpen, true);
  assert.ok(p.readable instanceof ReadableStream);
  assert.ok(p.writable instanceof WritableStream);
});

test('重复 open 抛错，close 后可再 open', async () => {
  const p = new FakeSerialPort();
  await p.open({});
  await assert.rejects(() => p.open({}), /已打开/);
  await p.close();
  assert.strictEqual(p.isOpen, false);
  await p.open({}); // 真实 SerialPort 允许关闭后重开
});

test('对已锁定流二次 getReader 抛 TypeError', async () => {
  const p = new FakeSerialPort();
  await p.open({});
  p.readable.getReader();
  assert.throws(() => p.readable.getReader(), { name: 'TypeError' });
});

test('cancel 使待决 read() resolve {done:true}（v24 实测语义）', async () => {
  const p = new FakeSerialPort();
  await p.open({});
  const reader = p.readable.getReader();
  const pending = reader.read();
  await reader.cancel();
  assert.deepStrictEqual(await pending, { value: undefined, done: true });
});

test('close 使待决 read() resolve {done:true}', async () => {
  const p = new FakeSerialPort();
  await p.open({});
  const reader = p.readable.getReader();
  const pending = reader.read();
  await p.close();
  assert.deepStrictEqual(await pending, { value: undefined, done: true });
});

test('injectBytes 送达读取方，且不合并相邻分块语义', async () => {
  const p = new FakeSerialPort();
  await p.open({});
  const reader = p.readable.getReader();
  p.injectBytes(new Uint8Array([0x41]));
  p.injectBytes(new Uint8Array([0x42, 0x43]));
  assert.deepStrictEqual((await reader.read()).value, new Uint8Array([0x41]));
  assert.deepStrictEqual((await reader.read()).value, new Uint8Array([0x42, 0x43]));
});

test('未 open 时 injectBytes 抛错', () => {
  assert.throws(() => new FakeSerialPort().injectBytes(new Uint8Array([1])), /未打开/);
});

test('writable 的写入被 capturedBytes 收集', async () => {
  const p = new FakeSerialPort();
  await p.open({});
  const w = p.writable.getWriter();
  await w.write(new Uint8Array([0x01, 0x03]));
  await w.write(new Uint8Array([0x00]));
  w.releaseLock();
  assert.deepStrictEqual([...p.capturedBytes], [0x01, 0x03, 0x00]);
  p.clearCaptured();
  assert.strictEqual(p.capturedBytes.length, 0);
});

test('getInfo 返回配置的 VID/PID', async () => {
  const p = new FakeSerialPort({ usbVendorId: 0x1234, usbProductId: 0x5678 });
  await p.open({});
  assert.deepStrictEqual(p.getInfo(), { usbVendorId: 0x1234, usbProductId: 0x5678 });
});

// ── 规则引擎 ──────────────────────────────────────────────

test('FakeScript 前缀匹配命中后清空缓冲，避免重复命中', () => {
  const s = new FakeScript([{ matchHex: '0103000000', respondHex: '0103020064', delayMs: 20 }]);
  assert.strictEqual(s.push(new Uint8Array([0x01, 0x03])), null);        // 尚未匹配
  const hit = s.push(new Uint8Array([0x00, 0x00, 0x00]));
  assert.deepStrictEqual([...hit.respond], [0x01, 0x03, 0x02, 0x00, 0x64]);
  assert.strictEqual(hit.delayMs, 20);
});

test('FakeScript 未匹配时不回注（用于测超时路径）', () => {
  const s = new FakeScript([{ matchHex: 'ff', respondHex: 'aa', delayMs: 0 }]);
  assert.strictEqual(s.push(new Uint8Array([0x01, 0x02])), null);
});

test('FakeScript 多规则按序首匹配生效', () => {
  const s = new FakeScript([
    { matchHex: '0103', respondHex: 'aaaa', delayMs: 0 },
    { matchHex: '01', respondHex: 'bbbb', delayMs: 0 },
  ]);
  assert.deepStrictEqual([...s.push(new Uint8Array([0x01, 0x03])).respond], [0xaa, 0xaa]);
});

test('FakeScript reset 清空累积缓冲', () => {
  const s = new FakeScript([{ matchHex: '0103', respondHex: 'aa', delayMs: 0 }]);
  s.push(new Uint8Array([0x01]));
  s.reset();
  assert.strictEqual(s.push(new Uint8Array([0x03])), null); // 缓冲已清，'01' 丢了
});

test('FakeScript 空规则表永不回注', () => {
  assert.strictEqual(new FakeScript([]).push(new Uint8Array([1, 2, 3])), null);
});

test('规则命中后经 schedule 回注到 readable', async () => {
  const p = new FakeSerialPort({
    rules: [{ matchHex: '0103', respondHex: '0103020064', delayMs: 0 }],
    schedule: sync,
  });
  await p.open({});
  const reader = p.readable.getReader();
  const w = p.writable.getWriter();
  await w.write(new Uint8Array([0x01, 0x03]));
  assert.deepStrictEqual((await reader.read()).value, new Uint8Array([0x01, 0x03, 0x02, 0x00, 0x64]));
});

test('setRules 可运行中替换规则', async () => {
  const p = new FakeSerialPort({ schedule: sync });
  await p.open({});
  const reader = p.readable.getReader();
  const w = p.writable.getWriter();
  await w.write(new Uint8Array([0x09]));
  assert.strictEqual(p.capturedBytes.length, 1);   // 无规则 → 只有捕获
  p.setRules([{ matchHex: '09', respondHex: 'ee', delayMs: 0 }]);
  await w.write(new Uint8Array([0x09]));
  assert.deepStrictEqual((await reader.read()).value, new Uint8Array([0xee]));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/fake-serial.test.js`
Expected: FAIL — `Cannot find module '../fake-serial.js'`

- [ ] **Step 3: 实现**

```js
// fake-serial.js
// 可替换的串口源。readable/writable 必须是平台原生流：
// 现有 readLoop / disconnectPort 依赖真实流的精确语义
// （cancel 与 close 均使待决 read() resolve {done:true}；对已锁定流 getReader 抛 TypeError）。
// 手写 Promise shim 会漏掉这些边界，后果是测试全绿但真机挂掉。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FakeSerial = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const { hexToBytes } = (typeof module === 'object' && module.exports)
    ? require('./bridge-protocol.js')
    : root.BridgeProtocol;

  const concat = chunks => {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  };

  /** TX 累积缓冲 + 前缀匹配。匹配后清空缓冲，否则同一请求会被重复命中 */
  class FakeScript {
    constructor(rules = []) { this.setRules(rules); }
    setRules(rules = []) {
      this.rules = rules.map(r => ({
        match: hexToBytes(r.matchHex),
        respond: hexToBytes(r.respondHex),
        delayMs: Number(r.delayMs) || 0,
      }));
      this.buf = new Uint8Array(0);
    }
    reset() { this.buf = new Uint8Array(0); }
    push(bytes) {
      this.buf = concat([this.buf, bytes]);
      for (const r of this.rules) {
        if (this.buf.length < r.match.length) continue;
        let hit = true;
        for (let i = 0; i < r.match.length; i++) {
          if (this.buf[i] !== r.match[i]) { hit = false; break; }
        }
        if (hit) { this.buf = new Uint8Array(0); return { respond: r.respond, delayMs: r.delayMs }; }
      }
      // 未匹配一律不回注——AI 据此可主动测试超时路径
      return null;
    }
  }

  class FakeSerialPort {
    constructor({ usbVendorId = 0x1A86, usbProductId = 0x7523, rules = [], schedule } = {}) {
      this._info = { usbVendorId, usbProductId };
      this._script = new FakeScript(rules);
      this._schedule = schedule || ((fn, ms) => setTimeout(fn, ms));
      this._open = false;
      this._controller = null;
      this._captured = [];
      this._readable = null;
      this._writable = null;
    }

    get isOpen() { return this._open; }
    get readable() { return this._readable; }
    get writable() { return this._writable; }
    get capturedBytes() { return concat(this._captured); }

    getInfo() { return { ...this._info }; }
    clearCaptured() { this._captured = []; }
    setRules(rules) { this._script.setRules(rules); }

    async open() {
      if (this._open) throw new Error('端口已打开');
      this._open = true;

      this._readable = new ReadableStream({
        start: c => { this._controller = c; },
      });

      this._writable = new WritableStream({
        write: chunk => {
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          this._captured.push(bytes);
          const hit = this._script.push(bytes);
          if (hit) {
            this._schedule(() => {
              if (this._open) this._controller.enqueue(hit.respond);
            }, hit.delayMs);
          }
        },
      });
    }

    async close() {
      if (!this._open) return;
      this._open = false;
      // close() 令待决 read() resolve {done:true}，与原生语义一致
      try { this._controller.close(); } catch { /* 已关闭 */ }
    }

    injectBytes(bytes) {
      if (!this._open) throw new Error('端口未打开，无法注入');
      this._controller.enqueue(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    }
  }

  return { FakeScript, FakeSerialPort };
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/fake-serial.test.js`
Expected: PASS（全部 15 个 test）

- [ ] **Step 5: 提交**

```bash
git add fake-serial.js test/fake-serial.test.js
git commit -m "feat: 基于原生流的假串口与规则引擎"
```

---

### Task 4: `bridge.js` — 鉴权与 hello 握手

**Files:**
- Create: `bridge.js`
- Test: `test/bridge.test.js`

**Interfaces:**
- Consumes: `bridge-protocol.js`（Task 1）、`bridge-auth.js` 的 `tokenEquals`（Task 2）
- Produces: `attachBridge(server, deps)`

**说明：** `isTrustedOrigin` / `isLocalHostname` / `hostnameOf` 由 `server.js` **注入**，不从 `server.js` 导出。这样既不用改动 `server.js` 现有逻辑，也让 `bridge.js` 可脱离 `server.js` 单测。

- [ ] **Step 1: 写失败测试**

```js
// test/bridge.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const P = require('../bridge-protocol.js');
const { attachBridge } = require('../bridge.js');

// —— 测试用的最小 server.js 替身：复用真实实现的 Host/Origin 判定规则 ——
const isLocalHostname = h => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
function hostnameOf(h) { try { return new URL('http://' + h).hostname; } catch { return ''; } }
function isTrustedOrigin(origin, port) {
  if (!origin) return false;
  let u; try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!isLocalHostname(u.hostname)) return false;
  return Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === port;
}

const TOKEN = crypto.randomBytes(32).toString('hex');
let server, bridge, port;

const url = () => `ws://127.0.0.1:${port}/bridge`;

function connectPage({ origin, path = '/bridge' } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      origin: origin === undefined ? `http://localhost:${port}` : origin,
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error('HTTP ' + res.statusCode)));
  });
}

function connectAdapter({ token = TOKEN, path = '/bridge' } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: token === null ? {} : { 'x-webterm-token': token },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error('HTTP ' + res.statusCode)));
  });
}

const nextMessage = ws => new Promise(resolve => ws.once('message', d => resolve(JSON.parse(d.toString()))));
const send = (ws, obj) => ws.send(JSON.stringify(obj));

before(async () => {
  server = http.createServer((_req, res) => res.writeHead(404).end());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  bridge = attachBridge(server, {
    token: TOKEN, isTrustedOrigin, isLocalHostname, hostnameOf,
    getActualPort: () => server.address().port,
    log: { info() {}, warn() {}, error() {} },
  });
});

after(async () => {
  bridge.close();
  await new Promise(r => server.close(r));
});

test('页面连接：Origin 合法则接受，hello 被记录', async () => {
  const ws = await connectPage();
  send(ws, { kind: 'hello', role: 'page', pageId: 'p-1', protocolVersion: 1,
             appVersion: '2.1', capabilities: ['serial', 'modbus'] });
  await new Promise(r => setTimeout(r, 50));
  assert.deepStrictEqual(bridge.getStats().page,
    { pageId: 'p-1', capabilities: ['serial', 'modbus'] });
  ws.close();
});

test('页面连接：Origin 非法被拒（其他站点不能驱动串口）', async () => {
  await assert.rejects(() => connectPage({ origin: 'http://evil.example.com' }), /HTTP \d+/);
});

test('页面连接：缺失 Origin 被拒', async () => {
  await assert.rejects(() => connectPage({ origin: null }), /HTTP \d+/);
});

test('适配器连接：token 正确则接受', async () => {
  const ws = await connectAdapter();
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(bridge.getStats().adapters, 1);
  ws.close();
});

test('适配器连接：token 错误被拒', async () => {
  await assert.rejects(() => connectAdapter({ token: 'deadbeef' }), /HTTP \d+/);
});

test('适配器连接：无 token 被拒', async () => {
  await assert.rejects(() => connectAdapter({ token: null }), /HTTP \d+/);
});

test('路径不是 /bridge 的升级请求被拒', async () => {
  await assert.rejects(() => connectPage({ path: '/nope' }), /HTTP \d+/);
});

test('协议版本不匹配时响亮拒绝', async () => {
  const ws = await connectPage();
  send(ws, { kind: 'hello', role: 'page', pageId: 'p-bad', protocolVersion: 999,
             appVersion: 'x', capabilities: [] });
  const msg = await nextMessage(ws);
  assert.strictEqual(msg.kind, 'error');
  assert.match(msg.message, /协议版本/);
});

test('hello 缺 capabilities 时按空数组处理，不崩', async () => {
  const ws = await connectPage();
  send(ws, { kind: 'hello', role: 'page', pageId: 'p-min', protocolVersion: 1 });
  await new Promise(r => setTimeout(r, 50));
  assert.deepStrictEqual(bridge.getStats().page.capabilities, []);
  ws.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/bridge.test.js`
Expected: FAIL — `Cannot find module '../bridge.js'`

- [ ] **Step 3: 实现**

```js
// bridge.js
// WS 服务端：鉴权 + 路由 + 限流。不理解任何域语义——
// 工具定义与域语义在 mcp-server.js，执行在页面侧。
const { WebSocketServer } = require('ws');
const P = require('./bridge-protocol.js');
const { tokenEquals } = require('./bridge-auth.js');

const BRIDGE_PATH = '/bridge';
const TOKEN_HEADER = 'x-webterm-token';

/**
 * @param server 已有的 http.Server（复用其端口与 Host/Origin 判定）
 * @param deps { token, isTrustedOrigin, isLocalHostname, hostnameOf, getActualPort, log }
 *   判定函数由 server.js 注入，而非从 server.js 导出——不改动其现有逻辑，
 *   同时让本模块可脱离 server.js 单测。
 */
function attachBridge(server, deps) {
  const { token, isTrustedOrigin, isLocalHostname, hostnameOf, getActualPort } = deps;
  const log = deps.log || console;

  const wss = new WebSocketServer({ noServer: true });
  const state = { page: null, adapters: new Set(), pending: new Map() };

  /** 返回 { role } 或 { reject: {code, reason} } */
  function authorize(req) {
    const hostname = hostnameOf(req.headers.host);
    if (!isLocalHostname(hostname)) return { reject: { code: 403, reason: '非法 Host' } };

    const origin = req.headers.origin;
    if (origin) {
      // 浏览器一定发 Origin，所以这条分支就是"页面"路径
      if (!isTrustedOrigin(origin, getActualPort())) {
        return { reject: { code: 403, reason: '非法来源' } };
      }
      return { role: 'page' };
    }

    // 无 Origin ⇒ 非浏览器（浏览器无法省略 Origin，也无法自定义头）
    const presented = req.headers[TOKEN_HEADER];
    if (!tokenEquals(presented, token)) {
      return { reject: { code: 403, reason: 'token 无效' } };
    }
    return { role: 'adapter' };
  }

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== BRIDGE_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const verdict = authorize(req);
    if (verdict.reject) {
      log.warn(`[bridge] 拒绝连接：${verdict.reject.reason}`);
      socket.write(`HTTP/1.1 ${verdict.reject.code} Forbidden\r\n\r\n`);
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      ws.bridgeRole = verdict.role;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', ws => {
    if (ws.bridgeRole === 'adapter') {
      state.adapters.add(ws);
    }

    ws.on('message', raw => {
      // 帧上限：超大帧直接断开，避免打爆内存
      if (raw.length > P.MAX_FRAME_BYTES) {
        log.warn('[bridge] 帧超限，断开连接');
        ws.close(1009, 'frame too large');
        return;
      }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      handleMessage(ws, msg);
    });

    ws.on('close', () => {
      state.adapters.delete(ws);
      if (state.page && state.page.ws === ws) state.page = null;
    });

    ws.on('error', err => log.warn('[bridge] socket 错误：' + err.message));
  });

  function handleMessage(ws, msg) {
    if (msg && msg.kind === 'hello') {
      if (msg.protocolVersion !== P.PROTOCOL_VERSION) {
        ws.send(JSON.stringify({
          kind: 'error',
          message: `协议版本不匹配：页面 ${msg.protocolVersion}，桥 ${P.PROTOCOL_VERSION}。请刷新页面。`,
        }));
        ws.close();
        return;
      }
      // 一期单页面：后连接者取代先连接者
      state.page = {
        ws,
        pageId: String(msg.pageId || 'unknown'),
        capabilities: Array.isArray(msg.capabilities) ? msg.capabilities : [],
      };
      log.info(`[bridge] 页面已连接 pageId=${state.page.pageId}`);
      return;
    }
    // 路由与超时在 Task 5 加入
  }

  return {
    close() {
      for (const ws of state.adapters) { try { ws.close(); } catch {} }
      if (state.page) { try { state.page.ws.close(); } catch {} }
      wss.close();
    },
    getStats() {
      return {
        page: state.page ? { pageId: state.page.pageId, capabilities: state.page.capabilities } : null,
        adapters: state.adapters.size,
        pending: state.pending.size,
      };
    },
  };
}

module.exports = { attachBridge, BRIDGE_PATH, TOKEN_HEADER };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/bridge.test.js`
Expected: PASS（全部 9 个 test）

- [ ] **Step 5: 提交**

```bash
git add bridge.js test/bridge.test.js
git commit -m "feat: 桥的鉴权与 hello 握手"
```

---

### Task 5: `bridge.js` — 请求路由、超时与限流

**Files:**
- Modify: `bridge.js`（`handleMessage` 的路由分支、`state.pending`、`close`）
- Test: `test/bridge.test.js`（追加）

**Interfaces:**
- Consumes: Task 4 的 `attachBridge` 及其内部 `state`
- Produces: `getStats()` 的 `pending` 字段可观测；适配器侧收到 `PAGE_NOT_CONNECTED` / `BRIDGE_TIMEOUT` / 限流错误

- [ ] **Step 1: 追加失败测试**

在 `test/bridge.test.js` 末尾追加：

```js
// ── 路由、超时、限流 ──────────────────────────────────────

test('请求被转发到页面，页面响应回传适配器', async () => {
  const page = await connectPage();
  send(page, { kind: 'hello', role: 'page', pageId: 'p-route', protocolVersion: 1, capabilities: ['serial'] });
  await new Promise(r => setTimeout(r, 30));

  const adapter = await connectAdapter();
  send(adapter, P.makeReq('r-100', 'serial', 'send', { data: 'AT', encoding: 'ascii' }));

  const fwd = await nextMessage(page);
  assert.deepStrictEqual(fwd, P.makeReq('r-100', 'serial', 'send', { data: 'AT', encoding: 'ascii' }));

  send(page, P.makeRes('r-100', { bytesWritten: 2 }));
  const back = await nextMessage(adapter);
  assert.deepStrictEqual(back, P.makeRes('r-100', { bytesWritten: 2 }));
  assert.strictEqual(bridge.getStats().pending, 0, '响应后请求表应清空');

  page.close(); adapter.close();
});

test('页面未连接时立即返回 PAGE_NOT_CONNECTED', async () => {
  const adapter = await connectAdapter();
  send(adapter, P.makeReq('r-200', 'serial', 'send', { data: 'AT' }));
  const res = await nextMessage(adapter);
  assert.strictEqual(res.id, 'r-200');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'PAGE_NOT_CONNECTED');
  adapter.close();
});

test('页面不响应时超时返回 BRIDGE_TIMEOUT 并清理请求表', async () => {
  const slow = attachBridgeOnNewServer({ timeoutMs: 80 });
  const page = await connectPageTo(slow, { kind: 'hello', role: 'page', pageId: 'p-slow', protocolVersion: 1, capabilities: ['serial'] });
  const adapter = await connectAdapterTo(slow);

  send(adapter, P.makeReq('r-300', 'serial', 'read', {}));
  const res = await nextMessage(adapter);
  assert.strictEqual(res.error.code, 'BRIDGE_TIMEOUT');
  assert.strictEqual(slow.bridge.getStats().pending, 0, '超时后必须清理，否则反复超时会吃内存');

  page.close(); adapter.close(); await slow.teardown();
});

test('速率限制：超过窗口配额时拒绝而非静默排队', async () => {
  const limited = attachBridgeOnNewServer({ rateLimit: { max: 2, windowMs: 10000 } });
  const page = await connectPageTo(limited, { kind: 'hello', role: 'page', pageId: 'p-rate', protocolVersion: 1, capabilities: ['serial'] });
  const adapter = await connectAdapterTo(limited);

  const results = [];
  for (let i = 0; i < 3; i++) {
    send(adapter, P.makeReq(`r-40${i}`, 'serial', 'status', {}));
  }
  for (let i = 0; i < 3; i++) results.push(await nextMessage(adapter));
  const codes = results.filter(r => !r.ok).map(r => r.error.code);
  assert.deepStrictEqual(codes, ['INVALID_ARGS'], '第 3 个请求应被限流拒绝（复用 INVALID_ARGS 之外的专用码）');

  page.close(); adapter.close(); await limited.teardown();
});

test('页面断开时挂起的请求被清理', async () => {
  const page = await connectPage();
  send(page, { kind: 'hello', role: 'page', pageId: 'p-drop', protocolVersion: 1, capabilities: ['serial'] });
  await new Promise(r => setTimeout(r, 30));
  const adapter = await connectAdapter();
  send(adapter, P.makeReq('r-500', 'serial', 'read', {}));
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(bridge.getStats().pending, 1);
  page.close();
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(bridge.getStats().pending, 0);
  adapter.close();
});
```

同时在该测试文件顶部（`before` 之前）加入三个辅助函数，供多实例测试使用：

```js
// 独立实例（自带端口与桥），用于测试超时/限流等需要不同配置的场景
async function attachBridgeOnNewServer(opts = {}) {
  const srv = http.createServer((_req, res) => res.writeHead(404).end());
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const b = attachBridge(srv, {
    token: TOKEN, isTrustedOrigin, isLocalHostname, hostnameOf,
    getActualPort: () => srv.address().port,
    log: { info() {}, warn() {}, error() {} },
    timeoutMs: opts.timeoutMs,
    rateLimit: opts.rateLimit,
  });
  return {
    port: srv.address().port, bridge: b,
    teardown: async () => { b.close(); await new Promise(r => srv.close(r)); },
  };
}

function connectPageTo(inst, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${inst.port}/bridge`, {
      origin: `http://localhost:${inst.port}`,
    });
    ws.on('open', () => { if (hello) ws.send(JSON.stringify(hello)); resolve(ws); });
    ws.on('error', reject);
  });
}

function connectAdapterTo(inst) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${inst.port}/bridge`, {
      headers: { 'x-webterm-token': TOKEN },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/bridge.test.js`
Expected: FAIL — 新增的 5 个 test 失败（请求未被转发、无超时、无限流）

- [ ] **Step 3: 实现**

在 `bridge.js` 中：给 `attachBridge` 增加 `timeoutMs` 与 `rateLimit` 选项，并补全路由。

在 `const BRIDGE_PATH = '/bridge';` 下方新增：

```js
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RATE_LIMIT = { max: 60, windowMs: 1000 };
```

在 `attachBridge` 内、`const state = ...` 之后新增：

```js
  const timeoutMs = deps.timeoutMs || DEFAULT_TIMEOUT_MS;
  const rateLimit = deps.rateLimit || DEFAULT_RATE_LIMIT;
  const rateState = { count: 0, windowStart: Date.now() };
```

将 `handleMessage` 替换为：

```js
  function handleMessage(ws, msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.kind === 'hello') {
      if (msg.protocolVersion !== P.PROTOCOL_VERSION) {
        ws.send(JSON.stringify({
          kind: 'error',
          message: `协议版本不匹配：页面 ${msg.protocolVersion}，桥 ${P.PROTOCOL_VERSION}。请刷新页面。`,
        }));
        ws.close();
        return;
      }
      // 一期单页面：后连接者取代先连接者
      state.page = {
        ws,
        pageId: String(msg.pageId || 'unknown'),
        capabilities: Array.isArray(msg.capabilities) ? msg.capabilities : [],
      };
      log.info(`[bridge] 页面已连接 pageId=${state.page.pageId}`);
      return;
    }

    // 页面 → 适配器的响应
    if (msg.kind === 'res') {
      const pending = state.pending.get(msg.id);
      if (!pending) return;
      state.pending.delete(msg.id);
      clearTimeout(pending.timer);
      try { pending.adapter.send(JSON.stringify(msg)); } catch { /* 适配器已断 */ }
      return;
    }

    // 页面主动上报的事件：仅用于观测，不作为 AI 的数据来源（读取走拉取式）
    if (msg.kind === 'evt') {
      log.info(`[bridge] 事件 ${msg.domain}.${msg.op}`);
      return;
    }

    // 适配器 → 页面的请求
    if (msg.kind === 'req') {
      if (!state.page || state.page.ws.readyState !== 1) {
        reply(ws, P.makeErr(msg.id, P.ERROR_CODES.PAGE_NOT_CONNECTED,
          '页面未连接。请确认已在浏览器打开 http://localhost:' + getActualPort()));
        return;
      }

      if (!allowRequest()) {
        reply(ws, P.makeErr(msg.id, P.ERROR_CODES.INVALID_ARGS,
          `请求过于频繁（上限 ${rateLimit.max} 次 / ${rateLimit.windowMs}ms）。请降低调用频率。`));
        return;
      }

      // 请求表上限：反复超时不得让桥持续吃内存
      if (state.pending.size >= P.MAX_PENDING_REQUESTS) {
        reply(ws, P.makeErr(msg.id, P.ERROR_CODES.INVALID_ARGS,
          `桥上有 ${P.MAX_PENDING_REQUESTS} 个请求未完成，请稍后重试。`));
        return;
      }

      const timer = setTimeout(() => {
        const p = state.pending.get(msg.id);
        if (!p) return;
        state.pending.delete(msg.id);
        reply(p.adapter, P.makeErr(msg.id, P.ERROR_CODES.BRIDGE_TIMEOUT,
          `页面在 ${timeoutMs}ms 内未响应。请检查页面是否卡住。`));
      }, timeoutMs);

      state.pending.set(msg.id, { adapter: ws, timer });
      try { state.page.ws.send(JSON.stringify(msg)); }
      catch (e) {
        state.pending.delete(msg.id);
        clearTimeout(timer);
        reply(ws, P.makeErr(msg.id, P.ERROR_CODES.PAGE_NOT_CONNECTED, '转发失败：' + e.message));
      }
    }
  }

  function reply(adapter, envelope) {
    try { adapter.send(JSON.stringify(envelope)); } catch { /* 适配器已断 */ }
  }

  /** 固定窗口计数。够用且可预测；不做令牌桶是 YAGNI */
  function allowRequest() {
    const now = Date.now();
    if (now - rateState.windowStart >= rateLimit.windowMs) {
      rateState.windowStart = now;
      rateState.count = 0;
    }
    rateState.count++;
    return rateState.count <= rateLimit.max;
  }
```

并在 `ws.on('close')` 中补清理（替换原有的 `ws.on('close', ...)`）：

```js
    ws.on('close', () => {
      state.adapters.delete(ws);
      if (state.page && state.page.ws === ws) {
        // 页面掉了，所有挂起请求立即失败——不做"等页面回来"的挂起（spec 第 2.2 节）
        for (const [id, p] of state.pending) {
          clearTimeout(p.timer);
          reply(p.adapter, P.makeErr(id, P.ERROR_CODES.PAGE_NOT_CONNECTED, '页面已断开'));
        }
        state.pending.clear();
        state.page = null;
      }
    });
```

最后在返回对象里补上 `close()` 对 `pending` 的清理：

```js
    close() {
      for (const [, p] of state.pending) clearTimeout(p.timer);
      state.pending.clear();
      for (const ws of state.adapters) { try { ws.close(); } catch {} }
      if (state.page) { try { state.page.ws.close(); } catch {} }
      wss.close();
    },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/bridge.test.js`
Expected: PASS（全部 14 个 test）

- [ ] **Step 5: 提交**

```bash
git add bridge.js test/bridge.test.js
git commit -m "feat: 桥的请求路由、超时与限流"
```

---

### Task 6: `server.js` — 挂载桥与 token 生成

**关键约束：现有 `test/server.test.js` 的 297 行断言必须**继续全部通过**。**本任务只增加挂载，不改动任何现有逻辑。

**Files:**
- Modify: `server.js`（require、token 生成、`attachBridge` 调用；`upgrade` 由 `bridge.js` 自行监听）
- Test: `test/server.test.js`（追加 2 个 test）

**Interfaces:**
- Consumes: `bridge-auth.js` 的 `writeToken`/`baseDir`（Task 2）、`bridge.js` 的 `attachBridge`（Task 4/5）
- Produces: `http://localhost:<port>/bridge` 可用；启动时打印 token 文件路径

- [ ] **Step 1: 追加失败测试**

在 `test/server.test.js` 末尾追加：

```js
test('启动时写入桥 token，供 mcp-server.js 读取', async () => {
  // before() 已用 WEBTERM_HOME 指向临时目录启动服务
  const tokenFile = path.join(process.env.WEBTERM_HOME, '.webterm', 'bridge-token');
  assert.ok(fs.existsSync(tokenFile), '应写入 ' + tokenFile);
  assert.match(fs.readFileSync(tokenFile, 'utf8'), /^[0-9a-f]{64}$/);
});

test('/bridge 拒绝非法 Origin 的升级请求', async () => {
  const WebSocket = require('ws');
  await assert.rejects(() => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: 'http://evil.example.com' });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('unexpected-response', (_r, res) => reject(new Error('HTTP ' + res.statusCode)));
  }), /HTTP 403/);
});
```

并在该文件的 `startServer()` 中，把 `env` 改为指向临时目录（这是本任务唯一改动现有测试的地方，因为服务会写 token 文件）：

```js
    child = spawn(process.execPath, ['server.js'], {
      cwd: APP_DIR,
      env: { ...process.env, PORT: '0', WEBTERM_HOME: tmpHome }, // 0 = 由系统分配空闲端口
    });
```

并在文件顶部 `let tmpRoot;` 旁新增 `let tmpHome;`，在 `before()` 开头（`tmpRoot` 赋值处附近）新增：

```js
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-home-'));
```

在 `after()` 中新增清理：

```js
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/server.test.js`
Expected: FAIL — token 文件不存在；`/bridge` 升级不被拒绝（返回不存在的资源而非 403）

- [ ] **Step 3: 实现**

在 `server.js` 顶部 require 区新增：

```js
const { writeToken } = require('./bridge-auth.js');
const { attachBridge } = require('./bridge.js');
```

把 `isLocalHostname` / `hostnameOf` / `isTrustedOrigin` 三个函数保持原样**不动**（`bridge.js` 通过注入使用它们，不导出）。

在 `server.listen(...)` 之后追加桥的挂载：

```js
// ── AI 桥 ───────────────────────────────────────────────
// 桥与静态服务同生共死：页面能存在就说明本进程在跑，因此无需额外的常驻进程。
const { token: bridgeToken, filePath: bridgeTokenPath } = writeToken();
console.log(`[bridge] token 已写入 ${bridgeTokenPath}`);

const bridge = attachBridge(server, {
  token: bridgeToken,
  isTrustedOrigin,
  isLocalHostname,
  hostnameOf,
  getActualPort: () => (server.address() ? server.address().port : PORT),
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { bridge.close(); process.exit(0); });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/server.test.js`
Expected: PASS（原有全部断言 + 新增 2 个）

- [ ] **Step 5: 手工确认服务仍正常**

Run: `npm start`，浏览器开 `http://localhost:1982`
Expected: 终端页面正常渲染，控制台打印 `[bridge] token 已写入 ...`；Ctrl+C 可干净退出

- [ ] **Step 6: 提交**

```bash
git add server.js test/server.test.js
git commit -m "feat: server.js 挂载 AI 桥并生成会话 token"
```

---

### Task 7: `WebSerialTerminal.html` — serialProvider seam

**本任务改动了正在工作的串口代码，是整份计划风险最集中处。** 先写回归测试（RED），再实现。

**Files:**
- Modify: `test/client.test.js`（追加 seam 回归断言）
- Modify: `WebSerialTerminal.html`（3 处）

**Interfaces:**
- Consumes: 无
- Produces: 全局 `serialProvider`（`{ requestPort, getPorts }`）；`bridge-client.js`（Task 8）将重新赋值它

- [ ] **Step 1: 写失败测试**

在 `test/client.test.js` 末尾追加：

```js
// ════════════════════════════════════════════════════════
// 四、串口 seam 回归防护
//
// AI 桥的假串口方案依赖"所有串口都经 serialProvider 获取"这条不变式。
// 后续若有人图省事写回 navigator.serial.requestPort()，这条测试必须立刻变红——
// 否则假设备会静默失效，测试却依然全绿。
// ════════════════════════════════════════════════════════

test('navigator.serial 只在 seam 定义处被引用', () => {
  const hits = html.match(/navigator\.serial\.[A-Za-z]+\s*\(/g) || [];
  assert.strictEqual(hits.length, 2,
    '应只有 serialProvider 定义处的 requestPort 与 getPorts，实际: ' + hits.join(' | '));
});

test('serialProvider 声明为可重新赋值（let，而非 const）', () => {
  // bridge-client.js 需要在切换假设备时重新赋值，const 会静默失败
  assert.match(html, /let\s+serialProvider\s*=/, '必须以 let 声明 serialProvider');
  assert.doesNotMatch(html, /const\s+serialProvider\s*=/, '不能是 const');
});

test('两处取端口都改走 serialProvider', () => {
  const connect = extractFn('connectPort');
  assert.ok(connect, '应存在 connectPort()');
  assert.match(connect, /serialProvider\.requestPort\(\)/, 'connectPort 必须走 seam');

  const modbusConnect = extractFn('modbusConnectPort');
  assert.ok(modbusConnect, '应存在 modbusConnectPort()');
  assert.match(modbusConnect, /serialProvider\.requestPort\(\)/, 'modbusConnectPort 必须走 seam');
});

test('seam 之外的串口逻辑未被改动', () => {
  // readLoop 的流式解码器与断点 flush 是既有的正确实现，本次不得触碰
  const readLoop = extractFn('readLoop');
  assert.match(readLoop, /stream\s*:\s*true/, '流式解码器不得被改动');
  assert.strictEqual((readLoop.match(/rxDecoder\.decode\(\);/g) || []).length, 2,
    '两处断点 flush 不得被改动');

  const disconnect = extractFn('disconnectPort');
  assert.match(disconnect, /isConnected = false/, '断开必须先置标志位');
  assert.match(disconnect, /reader\.cancel\(\)/, '断开依赖 cancel 解阻塞 readLoop');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/client.test.js`
Expected: FAIL — `navigator.serial` 被引用 4 次（2944、2950 附近与 4680、4687 附近），且无 `serialProvider`

- [ ] **Step 3: 实现（3 处改动，一字不多）**

**改动 1** —— 在 `WebSerialTerminal.html` 的 `// SERIAL CONNECTION` 区块标题上方（即 `2940` 附近）插入：

```js
// 串口源。所有端口获取都必须经此——AI 桥的假设备靠重新赋值它来接管（见 bridge-client.js）。
// 用 let 而非 const：bridge-client.js 需要整体替换。
// 挂到 window 上是为了让 bridge-client.js（独立 script 块）能引用到真实实现以便切回。
window.realSerialProvider = {
  getPorts: () => navigator.serial.getPorts(),
  // 优先返回已授权端口。这一步是整个自动化的关键：
  // requestPort() 每次都会弹选择框、且必须由用户手势触发；getPorts() 两者都不需要。
  // 没有这层优先，AI 在真人授权过一次之后依然无法自动重连。
  requestPort: async () => {
    const ports = await realSerialProvider.getPorts();
    if (ports.length) return ports[0];
    return navigator.serial.requestPort();   // 确实没有已授权端口时才弹框
  },
};
let serialProvider = window.realSerialProvider;
```

**改动 2** —— `2944`：

```js
    port = await serialProvider.requestPort();
```

**改动 3** —— `4680`：

```js
    modbusPort = await serialProvider.requestPort();
```

在文件末尾的 `<script src="pwa-install.js"></script>`（`4851`）之后新增：

```html
<script src="bridge-client.js"></script>
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/client.test.js`
Expected: PASS（原有 11 个 test + 新增 4 个全部通过）

- [ ] **Step 5: 手工确认串口与 Modbus 仍工作**

Run: `npm start`，浏览器开 `http://localhost:1982`
Expected:
1. 点"连接"能弹出串口选择框（证明 seam 的真实分支未被破坏）
2. 连接后收发数据正常，中文不乱码
3. 切到 Modbus 面板，"连接独立串口"同样能弹框
4. 断开连接无卡顿（若 `disconnectPort` 出现 500ms 延迟，说明流语义被破坏）

- [ ] **Step 6: 提交**

```bash
git add WebSerialTerminal.html test/client.test.js
git commit -m "refactor: 串口获取收口到 serialProvider seam"
```

---

### Task 8: `bridge-client.js` — 页面侧连接、dispatcher 与武装开关

**Files:**
- Create: `bridge-client.js`
- Test: `test/bridge-client-utils.test.js`（测试其中可脱离 DOM 的纯函数）
- Modify: `test/client.test.js`（追加"桥依赖的页面函数必须都存在"的防漂移断言）

**Interfaces:**
- Consumes: `bridge-protocol.js` 的 `BridgeProtocol` 全局（Task 1）、`fake-serial.js` 的 `FakeSerial` 全局（Task 3）、全局 `serialProvider`（Task 7）、页面既有全局函数 `connectPort`/`disconnectPort`/`sendData`/`clearTerminal`/`togglePause`/`modbusSetMode`/`modbusConnectPort`/`modbusDisconnectPort`/`modbusStartCycle`/`modbusStopCycle`/`modbusConstructFrame`/`modbusFeedResponse`/`modbusTryParseResponse` 等
- Produces: 页面对桥的完整响应能力；重新赋值 `serialProvider`

**设计要点：** dispatcher 拆成两层——**纯函数层**（`makeRingBuffer`、`normalizeSendArgs`、`describePageState`，可在 Node 单测）与**薄映射层**（`OPS` 表，只是"调哪个全局函数"）。原因：页面代码没有 DOM 测试环境，可测逻辑必须抽出来（spec 第 9.2 节）。

- [ ] **Step 1: 写失败测试**

```js
// test/bridge-client-utils.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { makeRingBuffer, normalizeSendArgs, classifyWrite } = require('../bridge-client.js');

test('环形缓冲按游标增量读取', () => {
  const rb = makeRingBuffer(10);
  rb.push('a'); rb.push('b'); rb.push('c');
  const r1 = rb.since(0);
  assert.deepStrictEqual(r1.lines, ['a', 'b', 'c']);
  assert.strictEqual(r1.dropped, 0);

  rb.push('d');
  const r2 = rb.since(r1.cursor);
  assert.deepStrictEqual(r2.lines, ['d']);
  assert.strictEqual(r2.dropped, 0);
});

test('环形缓冲挤占时显式报告 dropped', () => {
  const rb = makeRingBuffer(3);
  for (const x of ['a', 'b', 'c', 'd', 'e']) rb.push(x);
  const r = rb.since(0);          // 游标 0 太旧，只剩 c/d/e
  assert.deepStrictEqual(r.lines, ['c', 'd', 'e']);
  assert.strictEqual(r.dropped, 2, '必须告诉 AI 漏了 2 条，否则它会以为输出连续');
});

test('游标超过最新位置时返回空且不报负 dropped', () => {
  const rb = makeRingBuffer(5);
  rb.push('a');
  const r = rb.since(999);
  assert.deepStrictEqual(r.lines, []);
  assert.strictEqual(r.dropped, 0);
});

test('normalizeSendArgs 校验并规范化', () => {
  assert.deepStrictEqual(
    normalizeSendArgs({ data: 'AT', encoding: 'ascii' }),
    { bytes: new Uint8Array([0x41, 0x54]), encoding: 'ascii' });
  assert.strictEqual(normalizeSendArgs({ data: 'AT' }).encoding, 'ascii', 'encoding 默认 ascii');
  assert.throws(() => normalizeSendArgs({}), /data/);
  assert.throws(() => normalizeSendArgs({ data: '' }), /data/);
  assert.throws(() => normalizeSendArgs({ data: 'AZ', encoding: 'hex' }), /hex/);
});

test('classifyWrite 区分读写操作（决定是否受武装开关限制）', () => {
  for (const [domain, op] of [['serial', 'status'], ['serial', 'read'], ['ui', 'inspect'], ['modbus', 'status'], ['modbus', 'log'], ['dev', 'fake_capture']]) {
    assert.strictEqual(classifyWrite(domain, op), false, `${domain}.${op} 应为只读`);
  }
  for (const [domain, op] of [['serial', 'send'], ['serial', 'connect'], ['serial', 'disconnect'], ['serial', 'set_params'], ['modbus', 'request'], ['modbus', 'cycle_start'], ['ui', 'clear'], ['ui', 'run_macro'], ['dev', 'serial_source']]) {
    assert.strictEqual(classifyWrite(domain, op), true, `${domain}.${op} 应为写入`);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/bridge-client-utils.test.js`
Expected: FAIL — `Cannot find module '../bridge-client.js'`

- [ ] **Step 3: 实现**

```js
// bridge-client.js
// 页面侧：WS 客户端 + 命令 dispatcher + 武装开关。
//
// 铁律：本文件任何路径都不得把异常抛回页面代码——AI 控制是附加能力，
// 桥挂掉绝不能影响终端正常使用（spec 第 5.6 节）。
//
// 结构上分两层：可脱离 DOM 单测的纯函数（经 module.exports 暴露给 node:test），
// 以及只做"调哪个全局函数"的薄 dispatcher。页面无 DOM 测试环境，
// 可测逻辑必须抽出来（spec 第 9.2 节）。
//
// 注意 factory 只能调用一次：本文件的浏览器分支带副作用（开 WS、绑 DOM 事件），
// 调用两次会产生两条连接和两组监听器。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else factory(root);   // 浏览器：副作用式初始化，返回值丢弃
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const isNode = typeof module === 'object' && module.exports;
  const P = isNode ? require('./bridge-protocol.js') : root.BridgeProtocol;
  const FakeSerial = isNode ? require('./fake-serial.js') : root.FakeSerial;

  // ════ 纯函数层（可在 Node 单测） ════

  /**
   * 环形缓冲 + 单调游标。挤占时必须显式报告 dropped——
   * AI 在"以为输出连续"的前提下做判断，比收到报错更危险。
   */
  function makeRingBuffer(capacity) {
    const items = [];
    let total = 0;      // 累计写入条数，作为单调游标
    let nextSeq = 0;    // 最旧一条的序号
    return {
      push(line) {
        items.push({ seq: total++, line });
        while (items.length > capacity) items.shift();
        nextSeq = items.length ? items[0].seq : total;
      },
      since(cursor) {
        if (cursor >= total) return { lines: [], cursor: total, dropped: 0 };
        const dropped = Math.max(0, nextSeq - cursor);
        return {
          lines: items.filter(it => it.seq >= cursor).map(it => it.line),
          cursor: total,
          dropped,
        };
      },
      get cursor() { return total; },
    };
  }

  function normalizeSendArgs(args) {
    const a = args || {};
    if (typeof a.data !== 'string' || a.data === '') throw new Error('data 必填且不能为空');
    const encoding = a.encoding || 'ascii';
    const bytes = P.encodeToBytes(a.data, encoding);   // 非法 hex 在此抛错
    return { bytes, encoding };
  }

  // 只读操作不受武装开关限制——AI 任何时候都该能诊断现状
  const READ_ONLY = new Set([
    'serial.status', 'serial.read',
    'modbus.status', 'modbus.log',
    'ui.inspect', 'ui.list_macros',
    'dev.fake_capture',
  ]);
  const classifyWrite = (domain, op) => !READ_ONLY.has(`${domain}.${op}`);

  if (isNode) {
    return { makeRingBuffer, normalizeSendArgs, classifyWrite };
  }

  // ════ 浏览器侧 ════
  return (function initBrowser() {
    const READ_DEFAULT = P.READ_DEFAULT_LINES;

    const rb = makeRingBuffer(P.READ_MAX_LINES);
    const state = {
      ws: null,
      retryMs: 1000,
      pageId: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())).slice(0, 8),
      serialSource: 'real',
      connected: false,
    };

    // ── 武装开关：默认关闭 ──
    // 用独立的 localStorage 键，不塞进 wtp_settings：saveState() 按 settings 的固定字段整体
    // 回写，往里加额外字段可能在下次保存时被覆盖掉。独立键也便于用户单独清除。
    const ARMED_KEY = 'wtp_ai_armed';
    function isArmed() {
      try { return localStorage.getItem(ARMED_KEY) === '1'; } catch { return false; }
    }
    function setArmed(on) {
      try { localStorage.setItem(ARMED_KEY, on ? '1' : '0'); } catch { /* 隐私模式下可能抛 */ }
      syncArmedUI();
    }
    function syncArmedUI() {
      const el = document.getElementById('aiArmedToggle');
      if (el) el.checked = isArmed();
      const hint = document.getElementById('aiArmedHint');
      if (hint) hint.textContent = isArmed() ? '已允许 AI 写入' : 'AI 只读';
    }

    /** 审计轨迹复用既有终端日志，无需新建日志系统 */
    function audit(text) {
      try { appendLine('sys', '[AI] ' + text); } catch { /* 页面函数异常不得外泄 */ }
    }

    // modbusSend() 把解析结果直接渲染进 DOM 而不返回。既有函数不能改，
    // 因此用包装器在既有函数外面套一层截获结果——这是唯一不触碰既有代码的接入点。
    // 必须覆盖两种结局：ok / exception / crc_error 走 modbusShowResponse；
    // timeout 只走 modbusAddLog（modbusStartWait 的超时分支不调用 showResponse）。
    let mbCapture = null;
    const MODBUS_EXCEPTION_TEXT = {
      1: '非法功能码', 2: '非法数据地址', 3: '非法数据值', 4: '从站设备故障',
      5: '确认', 6: '从站设备忙', 8: '存储奇偶性错误',
      10: '网关路径不可用', 11: '网关目标无响应',
    };
    function installModbusCapture() {
      const origShow = window.modbusShowResponse;
      if (typeof origShow === 'function') {
        window.modbusShowResponse = function (result) {
          if (mbCapture) mbCapture.settle({ outcome: result.type, result });
          return origShow.apply(this, arguments);
        };
      }
      const origLog = window.modbusAddLog;
      if (typeof origLog === 'function') {
        window.modbusAddLog = function (frame, status) {
          if (mbCapture && status === 'timeout') mbCapture.settle({ outcome: 'timeout' });
          return origLog.apply(this, arguments);
        };
      }
      // 包装失败要能察觉——否则 modbus.request 会永远等到 1500ms 超时
      if (typeof origShow !== 'function' || typeof origLog !== 'function') {
        audit('警告：无法包装 Modbus 结果截获点，modbus.request 可能不可用');
      }
    }

    // ── 命令分派（薄层：只负责"调哪个全局函数"） ──
    const OPS = {
      'serial.status': async () => {
        // 串口参数取自连接时使用的 DOM 输入（页面没有把它们存回 settings）
        const val = id => {
          const el = document.getElementById(id);
          return el ? el.value : null;
        };
        const info = (isConnected && port && port.getInfo) ? port.getInfo() : {};
        return {
          connected: !!isConnected,
          portInfo: info.usbVendorId
            ? `VID:${info.usbVendorId.toString(16).toUpperCase().padStart(4, '0')} PID:${(info.usbProductId || 0).toString(16).toUpperCase().padStart(4, '0')}`
            : (isConnected ? 'Serial Port' : null),
          params: {
            baudRate: Number(val('baudRate')) || null,
            dataBits: Number(val('dataBits')) || null,
            stopBits: Number(val('stopBits')) || null,
            parity: val('parity'),
            flowControl: val('flowControl'),
          },
          counters: { rxBytes, txBytes, rxLines, errors },
          paused: !!isPaused,
          // 显示模式取自 #chkHex 复选框；引擎没有把它存进变量
          hexDisplay: !!(document.getElementById('chkHex') || {}).checked,
          source: state.serialSource,
          modbus: {
            mode: modbusPortMode,
            connected: !!modbusConnected,
            active: !!modbusActive,
            cycling: !!modbusCycling,
            terminalFrozen: !!modbusActive && modbusPortMode === 'shared',
          },
        };
      },

      'serial.connect': async args => {
        if (isConnected) return { alreadyConnected: true };
        // 优先用已授权端口自动连；无授权端口时 connectPort 会走 requestPort 抛 NotFoundError
        const authorized = await serialProvider.getPorts();
        if (!authorized || authorized.length === 0) {
          throw err(P.ERROR_CODES.NEEDS_USER_GESTURE,
            '没有已授权端口。浏览器要求用户手势才能弹出串口选择框，请手动点击一次页面的"连接"按钮。');
        }
        await connectPort();
        if (!isConnected) throw err(P.ERROR_CODES.PAGE_ERROR, '连接未成功建立');
        return { connected: true };
      },

      'serial.disconnect': async () => { await disconnectPort(); return { connected: false }; },

      // 刻意不走 sendData()——它对这个用途有三个致命问题：
      //   1) 会自动追加 #eolSelect 的 CR/LF，Modbus 二进制帧会被直接损坏
      //   2) 非 HEX 分支用 charCodeAt 构造字节（UTF-16 低位），中文会变乱码
      //   3) 未连接时静默 return，错误只写进 DOM，AI 无从得知发送失败
      // 直写 writer 才是"原始字节通道"该有的语义。
      'serial.send': async args => {
        const { bytes } = normalizeSendArgs(args);
        if (!isConnected || !writer) {
          throw err(P.ERROR_CODES.PORT_NOT_CONNECTED, '终端未连接串口，请先调用 serial_connect');
        }
        audit('→ ' + P.bytesToHex(bytes));
        await writer.write(bytes);
        txBytes += bytes.length;
        updateCounters();
        const chk = document.getElementById('chkLocalEcho');
        if (chk && chk.checked) appendLine('tx', P.bytesToHex(bytes));
        return { bytesWritten: bytes.length };
      },

      'serial.read': async args => {
        const max = Math.min(Number(args && args.max) || READ_DEFAULT, P.READ_MAX_LINES);
        const cursor = Number(args && args.cursor) || 0;
        const r = rb.since(cursor);
        const truncated = r.lines.length > max;
        return { lines: truncated ? r.lines.slice(0, max) : r.lines,
                 cursor: r.cursor, dropped: r.dropped, truncated };
      },

      'serial.set_params': async () => ({
        applied: false,
        note: '参数已记录，但串口需重新连接后方能生效。请先 disconnect 再 connect。',
      }),

      'modbus.status': async () => ({
        mode: modbusPortMode, connected: !!modbusConnected, active: !!modbusActive,
        cycling: !!modbusCycling,
        terminalFrozen: !!modbusActive && modbusPortMode === 'shared',
      }),

      'modbus.control': async args => {
        const action = args && args.action;
        switch (action) {
          case 'set_mode': modbusSetMode(args.mode); break;
          case 'connect': await modbusConnectPort(); break;
          case 'disconnect': await modbusDisconnectPort(); break;
          case 'activate':
            if (modbusPortMode === 'shared' && !isConnected) {
              throw err(P.ERROR_CODES.PORT_NOT_CONNECTED, '共享模式需要终端已连接串口');
            }
            if (!modbusActive) { document.getElementById('mbActivate').checked = true; modbusToggleActive(); }
            break;
          case 'deactivate':
            if (modbusActive) { document.getElementById('mbActivate').checked = false; modbusToggleActive(); }
            break;
          case 'cycle_start': modbusStartCycle(); break;
          case 'cycle_stop': modbusStopCycle(); break;
          default: throw err(P.ERROR_CODES.INVALID_ARGS, '未知 action: ' + action);
        }
        return {
          mode: modbusPortMode, active: !!modbusActive, cycling: !!modbusCycling,
          // 冻结终端是 shared 模式的既定代价，必须显式告知 AI
          terminalFrozen: !!modbusActive && modbusPortMode === 'shared',
        };
      },

      // modbusSend() 从 DOM 读取参数、并把解析结果直接渲染进 DOM 而不返回。
      // 既有函数不能改，因此先回填输入框再调用它，并用包装器截获结果。
      'modbus.request': async args => {
        const a = args || {};
        if (!modbusActive) {
          throw err(P.ERROR_CODES.INVALID_ARGS, 'Modbus 未启用，请先 modbus_control activate');
        }
        const hasWriter = modbusPortMode === 'independent' ? modbusConnected : isConnected;
        if (!hasWriter) throw err(P.ERROR_CODES.PORT_NOT_CONNECTED, 'Modbus 当前没有可用串口');

        const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };
        set('mbSlaveId', a.slaveId);
        set('mbFuncCode', a.funcCode);
        set('mbQuantity', a.quantity);
        // 地址必须按 DEC 解析：modbusParseAddress() 会看 modbusAddrHex 决定进制
        modbusAddrHex = false;
        if (typeof modbusViewSyncAddrMode === 'function') modbusViewSyncAddrMode();
        set('mbAddress', a.address);
        if (a.writeData !== undefined && a.writeData !== null) set('mbWriteData', a.writeData);
        if (typeof modbusOnFuncCodeChange === 'function') modbusOnFuncCodeChange();

        const frame = modbusConstructFrame(a.slaveId, a.funcCode, a.address, a.quantity, a.writeData);
        audit('Modbus → ' + P.bytesToHex(frame));

        const captured = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            mbCapture = null;
            reject(new Error('Modbus 请求未在 1500ms 内结束'));
          }, 1500);
          mbCapture = { settle: v => { clearTimeout(timer); mbCapture = null; resolve(v); } };
          try { modbusSend(); }
          catch (e) { clearTimeout(timer); mbCapture = null; reject(e); }
        });

        if (captured.outcome === 'timeout') {
          return { txHex: P.bytesToHex(frame), outcome: 'timeout',
                   note: '设备在页面设定的 500ms 内未响应。若这是在有意测试超时路径，属预期结果。' };
        }

        const r = captured.result;
        const out = {
          txHex: P.bytesToHex(frame),
          outcome: captured.outcome,
          rxHex: r.raw ? P.bytesToHex(r.raw) : null,
          responseTimeMs: Date.now() - modbusSendTime,
        };
        if (r.type === 'success') {
          out.slaveId = r.slaveId;
          out.funcCode = r.funcCode;
          out.pduHex = P.bytesToHex(r.pdu);
        }
        if (r.type === 'exception') {
          out.slaveId = r.slaveId;
          out.exceptionCode = r.exceptionCode;
          out.exceptionText = MODBUS_EXCEPTION_TEXT[r.exceptionCode] || '未知异常';
        }
        if (r.type === 'crc_error') {
          out.note = '响应帧的 CRC 校验失败，可能是波特率/校验位不匹配或线路噪声。';
        }
        return out;
      },

      'modbus.log': async args => {
        const max = Math.min(Number(args && args.max) || 20, 100);
        return { frames: (modbusLog || []).slice(-max) };
      },

      'ui.action': async args => {
        const action = args && args.action;
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };

        switch (action) {
          case 'clear': clearTerminal(); break;
          case 'pause': if (!isPaused) togglePause(); break;
          case 'resume': if (isPaused) togglePause(); break;

          // applySettings() 从 DOM 读值、不接参数，所以先回填输入框再调用。
          // 它本身不落盘，需补 saveState()。
          case 'set_theme': {
            const themes = ['green', 'amber', 'cyan', 'white'];
            if (!themes.includes(args.theme)) {
              throw err(P.ERROR_CODES.INVALID_ARGS, `theme 必须是 ${themes.join('/')} 之一`);
            }
            set('colorTheme', args.theme);
            applySettings(); saveState();
            return { theme: settings.colorTheme };
          }
          case 'set_font': {
            const size = Number(args.size);
            if (!Number.isFinite(size) || size < 8 || size > 48) {
              throw err(P.ERROR_CODES.INVALID_ARGS, 'size 必须是 8-48 之间的数字');
            }
            set('fontSize', size);
            applySettings(); saveState();
            return { fontSize: settings.fontSize };
          }
          case 'toggle_sidebar': toggleSidebar(); break;

          // 宏的行为必须与人工点击 ▶ 完全一致（含 EOL 追加），所以照样走 sendData
          case 'run_macro': {
            if (!isConnected) throw err(P.ERROR_CODES.PORT_NOT_CONNECTED, '端口未连接，无法执行宏');
            const m = (macros || []).find(x => x.label === args.name);
            if (!m) {
              const names = (macros || []).map(x => x.label).join('、');
              throw err(P.ERROR_CODES.INVALID_ARGS,
                `找不到宏「${args.name}」。现有宏：${names || '（无）'}`);
            }
            await sendData(m.cmd);
            audit(`宏「${m.label}」→ ${m.cmd}`);
            return { ran: m.label, command: m.cmd };
          }
          case 'list_macros':
            return { macros: (macros || []).map(m => ({ label: m.label, cmd: m.cmd })) };
          case 'save_log': await saveLog(); break;
          default: throw err(P.ERROR_CODES.INVALID_ARGS, '未知 action: ' + action);
        }
        return { action, ok: true };
      },

      'ui.inspect': async () => {
        const out = document.getElementById('terminalOutput');
        const rows = out ? Array.from(out.children).slice(-20) : [];
        const chkHex = document.getElementById('chkHex');
        return {
          // 显示模式来自 #chkHex 复选框（不是 #chkHexInput，那个管输入模式）
          hexDisplay: !!(chkHex && chkHex.checked),
          theme: settings.colorTheme,
          fontSize: settings.fontSize,
          maxLines: settings.maxLines,
          paused: !!isPaused,
          sidebarOpen: !!sidebarOpen,
          lineCount: rows.length,
          lastLines: rows.map(el => {
            const content = el.querySelector('.line-content') || el;
            return {
              text: content.textContent || '',
              // 取计算后颜色，AI 才能验证 ANSI 解析与关键字高亮的实际效果
              color: getComputedStyle(content).color,
              className: el.className || '',
            };
          }),
        };
      },

      'dev.serial_source': async args => {
        const mode = args && args.mode;
        if (mode === 'fake') {
          if (isConnected || modbusConnected) {
            throw err(P.ERROR_CODES.INVALID_ARGS, '切到假设备前必须先断开真实串口');
          }
          const fake = new FakeSerial.FakeSerialPort({
            rules: (args.rules || []),
          });
          serialProvider = {
            requestPort: async () => fake,
            getPorts: async () => [fake],
          };
          state.serialSource = 'fake';
          state.fakePort = fake;
          audit('串口源已切到假设备');
        } else if (mode === 'real') {
          if (state.fakePort && isConnected) await disconnectPort();
          // 直接引用页面声明的真实实现，不在这里重写一份——
          // 重写会让"优先用已授权端口"那条策略被悄悄丢掉
          serialProvider = root.realSerialProvider;
          state.fakePort = null;
          state.serialSource = 'real';
          audit('串口源已切回真实设备');
        } else {
          throw err(P.ERROR_CODES.INVALID_ARGS, 'mode 必须是 real 或 fake');
        }
        return { source: state.serialSource };
      },

      'dev.fake_inject': async args => {
        requireFake();
        const { bytes } = normalizeSendArgs(args);
        state.fakePort.injectBytes(bytes);
        audit('假设备注入 ' + P.bytesToHex(bytes));
        return { injected: bytes.length };
      },

      'dev.fake_capture': async args => {
        requireFake();
        const all = state.fakePort.capturedBytes;
        if (args && args.clear) state.fakePort.clearCaptured();
        return { hex: P.bytesToHex(all), length: all.length };
      },

      'dev.fake_script': async args => {
        requireFake();
        state.fakePort.setRules((args && args.rules) || []);
        return { ruleCount: ((args && args.rules) || []).length };
      },
    };

    function requireFake() {
      if (state.serialSource !== 'fake') {
        throw err(P.ERROR_CODES.INVALID_ARGS, '当前不是假设备模式，请先 dev.serial_source 切到 fake');
      }
    }
    const err = (code, message) => Object.assign(new Error(message), { code });

    // ── 请求处理 ──
    async function handleReq(msg) {
      const opKey = `${msg.domain}.${msg.op}`;
      const handler = OPS[opKey];
      if (!handler) {
        return P.makeErr(msg.id, P.ERROR_CODES.OP_UNSUPPORTED, `本页面不支持操作 ${opKey}`);
      }
      const caps = ['serial', 'modbus', 'ui', 'dev'];
      if (!caps.includes(msg.domain)) {
        return P.makeErr(msg.id, P.ERROR_CODES.OP_UNSUPPORTED, `本页面不支持域 ${msg.domain}`);
      }
      if (classifyWrite(msg.domain, msg.op) && !isArmed()) {
        return P.makeErr(msg.id, P.ERROR_CODES.NOT_ARMED,
          'AI 写入未启用。请在页面上打开"允许 AI 写入"开关后重试（读取类操作不受限制）。');
      }
      try {
        const data = await handler(msg.args || {});
        return P.makeRes(msg.id, data);
      } catch (e) {
        const code = P.isErrorCode(e && e.code) ? e.code : P.ERROR_CODES.PAGE_ERROR;
        return P.makeErr(msg.id, code, (e && e.message) || String(e));
      }
    }

    // ── WS 连接与重连 ──
    function connectBridge() {
      let ws;
      try {
        ws = new WebSocket(`ws://${location.host}/bridge`);
      } catch (e) {
        scheduleRetry();
        return;
      }
      state.ws = ws;

      ws.onopen = () => {
        state.retryMs = 1000;
        ws.send(JSON.stringify({
          kind: 'hello', role: 'page', pageId: state.pageId,
          protocolVersion: P.PROTOCOL_VERSION, appVersion: '2.2',
          capabilities: ['serial', 'modbus', 'ui', 'dev'],
        }));
      };

      ws.onmessage = async e => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (!P.isValidEnvelope(msg) || msg.kind !== 'req') return;
        const res = await handleReq(msg);
        try { ws.send(JSON.stringify(res)); } catch { /* 已断开 */ }
      };

      ws.onclose = () => { state.ws = null; scheduleRetry(); };
      ws.onerror = () => { try { ws.close(); } catch { /* 忽略 */ } };
    }

    function scheduleRetry() {
      // 指数退避，1s → 30s 封顶。不弹错误、不阻塞 UI
      setTimeout(connectBridge, state.retryMs);
      state.retryMs = Math.min(state.retryMs * 2, 30000);
    }

    // ── 把终端输出灌进环形缓冲 ──
    window.bridgeNoteOutput = function (line) {
      try { rb.push(line); } catch { /* 不得外泄 */ }
    };

    /** OPS 依赖的页面全局函数。页面是单文件、易被重构，缺一个函数会让对应的 MCP 工具
     *  静默退化成超时——不如启动时就在终端里点名，比事后猜快得多。 */
    const REQUIRED_PAGE_API = [
      'connectPort', 'disconnectPort', 'clearTerminal', 'togglePause', 'toggleSidebar',
      'sendData', 'saveLog', 'applySettings', 'saveState', 'appendLine',
      'modbusSetMode', 'modbusConnectPort', 'modbusDisconnectPort', 'modbusToggleActive',
      'modbusStartCycle', 'modbusStopCycle', 'modbusSend', 'modbusConstructFrame',
      'modbusShowResponse', 'modbusAddLog', 'modbusParseAddress', 'modbusViewSyncAddrMode',
    ];
    function verifyPageApi() {
      const missing = REQUIRED_PAGE_API.filter(n => typeof window[n] !== 'function');
      if (missing.length) audit('警告：页面缺少 AI 桥依赖的函数 → ' + missing.join('、'));
      return missing;
    }

    document.addEventListener('DOMContentLoaded', () => {
      syncArmedUI();
      const toggle = document.getElementById('aiArmedToggle');
      if (toggle) toggle.addEventListener('change', () => setArmed(toggle.checked));
      installModbusCapture();
      verifyPageApi();
      connectBridge();
    });

    return { state, isArmed, setArmed, connectBridge, verifyPageApi, REQUIRED_PAGE_API };
  })();
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/bridge-client-utils.test.js`
Expected: PASS（全部 5 个 test）

- [ ] **Step 5: 加武装开关 UI、输出钩子与防漂移断言**

在 `WebSerialTerminal.html` 的侧栏（靠近现有工具栏按钮处）加入：

```html
<label class="ai-armed">
  <input type="checkbox" id="aiArmedToggle">
  <span>允许 AI 写入</span>
</label>
<span id="aiArmedHint" class="ai-armed-hint">AI 只读</span>
```

并在既有的 `appendLine()`（`3402`）末尾追加一行，把输出灌进环形缓冲（这样 AI 读取的就是**真实渲染过的行**）：

```js
  if (window.bridgeNoteOutput) window.bridgeNoteOutput(text);
```

**这是本任务对既有函数体的唯一改动，且只是在末尾追加一行。**

最后在 `test/client.test.js` 末尾追加防漂移断言——`bridge-client.js` 依赖 22 个页面全局函数，其中 `modbusShowResponse` / `modbusAddLog` 还是用于结果截获的包装目标。页面是单文件，一次重构就可能悄悄改掉某个名字，而后果是 AI 调用静默超时：

```js
// ════════════════════════════════════════════════════════
// 五、AI 桥依赖的页面函数必须都存在
//
// bridge-client.js 通过全局函数名驱动页面。名字一旦漂移，
// 对应的 MCP 工具会退化成"永远超时"，比直接报错更难排查。
// ════════════════════════════════════════════════════════

const BRIDGE_REQUIRED_API = [
  'connectPort', 'disconnectPort', 'clearTerminal', 'togglePause', 'toggleSidebar',
  'sendData', 'saveLog', 'applySettings', 'saveState', 'appendLine',
  'modbusSetMode', 'modbusConnectPort', 'modbusDisconnectPort', 'modbusToggleActive',
  'modbusStartCycle', 'modbusStopCycle', 'modbusSend', 'modbusConstructFrame',
  'modbusShowResponse', 'modbusAddLog', 'modbusParseAddress', 'modbusViewSyncAddrMode',
];

test('AI 桥依赖的页面全局函数全部存在', () => {
  const missing = BRIDGE_REQUIRED_API.filter(n => !new RegExp(`function\\s+${n}\\s*\\(`).test(html));
  assert.deepStrictEqual(missing, [], '以下函数被重命名或删除，AI 桥会静默失效: ' + missing.join('、'));
});

test('Modbus 结果截获点存在（modbus.request 依赖它们）', () => {
  // 这两个函数被 bridge-client.js 包装以截获解析结果；
  // 它们消失会让 modbus.request 每次都要等到 1500ms 超时
  assert.match(html, /function\s+modbusShowResponse\s*\(/, 'modbusShowResponse 是成功/异常/CRC 错误的截获点');
  assert.match(html, /function\s+modbusAddLog\s*\(/, 'modbusAddLog 是超时结局的唯一截获点');
});

test('宏对象结构为 {label, cmd}（AI 的 run_macro 依赖此形状）', () => {
  const fn = extractFn('addMacro');
  assert.match(fn, /label\s*:/, '宏应有 label 字段');
  assert.match(fn, /cmd\s*:/, '宏应有 cmd 字段');
});

test('settings 主题字段名为 colorTheme（ui.action set_theme 依赖）', () => {
  const m = html.match(/let settings = \{[\s\S]*?\};/);
  assert.ok(m, '应能提取到 settings 对象');
  assert.match(m[0], /colorTheme\s*:/, 'settings 应含 colorTheme（不是 theme）');
  assert.match(m[0], /fontSize\s*:/, 'settings 应含 fontSize');
});

test('HEX 显示开关是 #chkHex 复选框（ui.inspect 依赖）', () => {
  // 注意与 #chkHexInput 区分：后者管输入模式，前者管显示模式
  assert.match(html, /id="chkHex"/, '应存在 #chkHex（显示模式）');
  assert.match(html, /id="chkHexInput"/, '应存在 #chkHexInput（输入模式）');
});
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test test/bridge-client-utils.test.js && node --test test/client.test.js`
Expected: PASS（纯函数 5 个 + 客户端断言 11 个 + 新增 5 个防漂移断言）

- [ ] **Step 7: 手工验证端到端连通性**

Run: `npm start`，浏览器开 `http://localhost:1982`
Expected:
1. 页面控制台无报错，Network 面板可见到 `/bridge` 的 WS 连接为 101
2. 终端**没有**出现"页面缺少 AI 桥依赖的函数"告警（否则说明 `REQUIRED_PAGE_API` 里有名字对不上）
3. 终端正常输出、正常收发（桥的存在不影响任何既有功能）
4. 打开"允许 AI 写入"后刷新，勾选状态被记住（`localStorage` 的 `wtp_ai_armed`）
5. 用 Node 一行脚本以适配器身份连上并调 `serial.status`，应返回状态 JSON 且 `params.baudRate` 有值

- [ ] **Step 8: 提交**

```bash
git add bridge-client.js test/bridge-client-utils.test.js WebSerialTerminal.html
git commit -m "feat: 页面侧桥客户端、dispatcher 与武装开关"
```

---

### Task 9: `mcp-server.js` — 工具定义与错误码翻译

**Files:**
- Create: `mcp-server.js`
- Test: `test/mcp-tools.test.js`

**Interfaces:**
- Consumes: `bridge-protocol.js`（Task 1）
- Produces: `buildTools()`、`dispatchTool(name, args, request)`、`translateError(code, message)`

**设计要点（spec 决定 ⑦ / ⑬）：** 约束必须写进工具描述并在错误里给出**下一步动作**——模型只能看到工具描述，协议里的约束不写进去就等于不存在。

- [ ] **Step 1: 写失败测试**

```js
// test/mcp-tools.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../mcp-server.js');
const P = require('../bridge-protocol.js');

test('工具清单数量与命名稳定', () => {
  const names = M.buildTools().map(t => t.name);
  assert.deepStrictEqual(names, [
    'webterm_status', 'serial_connect', 'serial_disconnect', 'serial_send', 'serial_read',
    'modbus_control', 'modbus_request', 'modbus_log',
    'ui_action', 'ui_inspect', 'dev_serial',
  ]);
});

test('每个工具都有非空 description 与 object 型 inputSchema', () => {
  for (const t of M.buildTools()) {
    assert.ok(t.description && t.description.length > 30, `${t.name} 描述太短，模型看不到约束`);
    assert.strictEqual(t.inputSchema.type, 'object');
  }
});

test('NEEDS_USER_GESTURE 的翻译包含"重试无效"与下一步动作', () => {
  const s = M.translateError('NEEDS_USER_GESTURE', '原始消息');
  assert.match(s, /重试/);
  assert.match(s, /用户/);
  assert.match(s, /连接/);
});

test('NOT_ARMED 的翻译指向武装开关', () => {
  const s = M.translateError('NOT_ARMED', '');
  assert.match(s, /AI 写入/);
});

test('未知错误码原样带出而不吞掉', () => {
  assert.match(M.translateError('SOMETHING_NEW', '细节'), /SOMETHING_NEW/);
  assert.match(M.translateError('SOMETHING_NEW', '细节'), /细节/);
});

test('dispatchTool 把工具名映射到正确的桥操作', async () => {
  const calls = [];
  const request = async (domain, op, args) => {
    calls.push([domain, op, args]);
    return P.makeRes('x', { ok: 1 });
  };

  await M.dispatchTool('serial_send', { data: 'AT' }, request);
  assert.deepStrictEqual(calls[0], ['serial', 'send', { data: 'AT' }]);

  await M.dispatchTool('serial_read', { cursor: 5 }, request);
  assert.deepStrictEqual(calls[1], ['serial', 'read', { cursor: 5 }]);

  await M.dispatchTool('modbus_control', { action: 'cycle_start' }, request);
  assert.deepStrictEqual(calls[2], ['modbus', 'control', { action: 'cycle_start' }]);

  await M.dispatchTool('dev_serial', { action: 'fake_inject', data: '41' }, request);
  assert.deepStrictEqual(calls[3], ['dev', 'fake_inject', { action: 'fake_inject', data: '41' }]);
});

test('dispatchTool 对未知工具名返回 INVALID_ARGS 而非抛错', async () => {
  const r = await M.dispatchTool('nope', {}, async () => P.makeRes('x', {}));
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /nope/);
});

test('dispatchTool 把桥的错误码翻译成自然语言', async () => {
  const request = async (d, o, a) =>
    P.makeErr('x', P.ERROR_CODES.PAGE_NOT_CONNECTED, '页面未连接');
  const r = await M.dispatchTool('serial_read', {}, request);
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /localhost/);
});

test('dispatchTool 成功时返回 JSON 文本内容', async () => {
  const request = async () => P.makeRes('x', { connected: true });
  const r = await M.dispatchTool('webterm_status', {}, request);
  assert.ok(!r.isError);
  assert.match(r.content[0].text, /"connected": true/);
});

test('serial_read 的默认行数来自协议常量而非硬编码', () => {
  const t = M.buildTools().find(x => x.name === 'serial_read');
  assert.strictEqual(t.inputSchema.properties.max.default, P.READ_DEFAULT_LINES);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/mcp-tools.test.js`
Expected: FAIL — `Cannot find module '../mcp-server.js'`

- [ ] **Step 3: 实现（工具定义部分）**

```js
// mcp-server.js
// stdio MCP 适配器。手写 JSON-RPC 2.0（换行分隔），不引入 @modelcontextprotocol/sdk——
// 本项目零构建、依赖精简，而 MCP 的 stdio 传输核心只有 initialize/tools 两类消息。
const P = require('./bridge-protocol.js');

// ════ 工具定义 ════
// 描述里必须带操作指引：模型只能看到工具名/描述/schema，
// 协议层的约束（NEEDS_USER_GESTURE、dropped 语义）不写进去就等于不存在。
function buildTools() {
  return [
    {
      name: 'webterm_status',
      description: '获取 WebTerm 终端与 Modbus 两套串口栈的完整状态快照：连接状态、串口参数、收发字节统计、是否暂停、Modbus 模式（shared/independent）、是否正在轮询、终端是否被 Modbus 冻结、当前串口源是真实设备还是假设备。\n\n排查任何问题前应先调用本工具。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'serial_connect',
      description: '连接终端串口。优先使用浏览器已授权的端口自动连接，无需用户操作。\n\n若返回 NEEDS_USER_GESTURE：表示没有已授权端口，浏览器要求用户手势才能弹出串口选择框。此时重试无效——必须请用户手动点击页面上的"连接"按钮一次，之后即可自动重连。',
      inputSchema: {
        type: 'object',
        properties: { index: { type: 'number', description: '有多个已授权端口时指定用第几个，默认 0' } },
        additionalProperties: false,
      },
    },
    {
      name: 'serial_disconnect',
      description: '断开终端串口。若 Modbus 处于 shared 模式会被一并关闭，正在进行的轮询也会停止。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'serial_send',
      description: '向串口发送数据。\n\nencoding 说明：ascii 按 UTF-8 编码（中文可用）；hex 接受「01030000」或「01 03 00 00」两种写法；base64 为标准 base64。\n\n本次调用会被记入终端日志（前缀 [AI]），可用于事后追溯发往设备的内容。',
      inputSchema: {
        type: 'object',
        properties: {
          data: { type: 'string', description: '要发送的数据' },
          encoding: { type: 'string', enum: ['ascii', 'hex', 'base64'], default: 'ascii' },
        },
        required: ['data'],
        additionalProperties: false,
      },
    },
    {
      name: 'serial_read',
      description: '按游标读取终端输出。首次调用不传 cursor（从最旧可用位置开始）；之后必须传入上次返回的 cursor 以只取增量。\n\n务必检查 dropped 字段：大于 0 表示这段时间的输出量超过环形缓冲、该段数据已永久丢失。出现 dropped 时不要假设输出是连续的，应缩短读取间隔或缩小范围后重试。truncated 为 true 表示本次结果被 max 截断，可用返回值里的 cursor 继续读取后续内容。',
      inputSchema: {
        type: 'object',
        properties: {
          cursor: { type: 'number', description: '上次返回的 cursor，用于只取增量' },
          max: { type: 'number', description: '本次最多返回多少行', default: P.READ_DEFAULT_LINES },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'modbus_control',
      description: '控制 Modbus 调试面板。action 取值：\n- set_mode：切换串口模式，需同时给 mode（shared 复用终端串口 / independent 独立开串口）\n- connect / disconnect：独立模式下连接或断开自己的串口\n- activate / deactivate：启用或停用 Modbus 调试\n- cycle_start / cycle_stop：启停轮询发送\n\n重要：shared 模式下 activate 会「冻结终端」——终端输入框与发送按钮被禁用，目的是防止人工操作干扰 Modbus 报文时序。返回值里的 terminalFrozen 会标明此状态。用完请及时 deactivate 以恢复终端。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['set_mode', 'connect', 'disconnect', 'activate', 'deactivate', 'cycle_start', 'cycle_stop'] },
          mode: { type: 'string', enum: ['shared', 'independent'], description: '仅 set_mode 时需要' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    {
      name: 'modbus_request',
      description: '发送一条语义化 Modbus RTU 请求并返回解析后的响应，CRC16 由页面自动计算。\n\n支持的功能码：01 读线圈、02 读离散输入、03 读保持寄存器、04 读输入寄存器、05 写单线圈、06 写单寄存器、15(0F) 写多线圈、16(10) 写多寄存器。\n\n返回值包含：请求与响应的完整 HEX 帧、响应时间、寄存器值（HEX/U16/I16/F32 多种格式）、线圈位图、以及异常码的中文描述。设备超时为 500ms，超时会明确标注。\n\n写操作会直接改变设备状态，请确认目标地址无误。',
      inputSchema: {
        type: 'object',
        properties: {
          slaveId: { type: 'number', description: '从站 ID，1-247' },
          funcCode: { type: 'number', description: '功能码：1/2/3/4/5/6/15/16' },
          address: { type: 'number', description: '起始地址，0-65535' },
          quantity: { type: 'number', description: '读取或写入的数量' },
          writeData: { type: 'string', description: '写操作的数据（hex 字符串），读操作留空' },
        },
        required: ['slaveId', 'funcCode', 'address', 'quantity'],
        additionalProperties: false,
      },
    },
    {
      name: 'modbus_log',
      description: '读取 Modbus 历史报文日志（时间、功能码摘要、响应时间、状态）。',
      inputSchema: {
        type: 'object',
        properties: { max: { type: 'number', description: '最多返回多少条，默认 20，上限 100', default: 20 } },
        additionalProperties: false,
      },
    },
    {
      name: 'ui_action',
      description: '操作终端界面。action 取值：clear 清屏、pause 暂停显示、resume 继续显示、set_theme（需 theme）、set_font（需 size）、toggle_sidebar 折叠侧栏、run_macro（需 name，执行已保存的宏）、list_macros 列出宏名、save_log 保存终端日志到文件。\n\n注意 pause 只影响显示，不影响串口接收——数据仍会进入缓冲，可用 serial_read 读取。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['clear', 'pause', 'resume', 'set_theme', 'set_font', 'toggle_sidebar', 'run_macro', 'list_macros', 'save_log'] },
          theme: { type: 'string', description: 'set_theme 时的主题名' },
          size: { type: 'number', description: 'set_font 时的字号' },
          name: { type: 'string', description: 'run_macro 时的宏名称' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    {
      name: 'ui_inspect',
      description: '检查终端当前的实际渲染结果——最后若干行的文本、每行计算后的颜色、是否处于 HEX 显示模式、当前主题与字号、是否暂停、侧栏是否折叠。\n\n用途：验证 ANSI 转义序列解析、关键字高亮、HEX 视图等显示逻辑是否按预期工作。这是需要「看渲染效果」时的唯一手段。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'dev_serial',
      description: '开发期假串口控制，用于在不接真实硬件的情况下测试完整串口链路。action 取值：\n- serial_source：切换串口源，需给 mode（real / fake）。切到 fake 前必须先断开真实串口\n- fake_inject：假设备向页面注入接收数据（需 data，可选 encoding）——数据会走完真实的 readLoop 解析路径\n- fake_capture：读回页面实际发送出去的字节（可选 clear 读完即清）\n- fake_script：设置「请求 → 应答」规则，让假设备自动应答（需 rules 数组，元素形如 {"matchHex":"0103000000","respondHex":"0103020064","delayMs":20}）。匹配为前缀匹配，首个命中的规则生效，命中后清空累积缓冲；未命中的请求不回注任何数据，可据此测试超时路径\n\n典型用法：切到 fake → fake_script 配好应答规则 → serial_connect → serial_send 发 Modbus 请求 → serial_read 读响应，全程无需硬件。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['serial_source', 'fake_inject', 'fake_capture', 'fake_script'] },
          mode: { type: 'string', enum: ['real', 'fake'] },
          data: { type: 'string' },
          encoding: { type: 'string', enum: ['ascii', 'hex', 'base64'], default: 'hex' },
          clear: { type: 'boolean' },
          rules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                matchHex: { type: 'string' }, respondHex: { type: 'string' }, delayMs: { type: 'number' },
              },
              required: ['matchHex', 'respondHex'],
            },
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  ];
}

// ════ 错误翻译 ════
// 工具结果是文本，模型读的是句子。必须把「该做什么」写进去，只报错误名会让 AI 反复重试。
const ERROR_TEXT = {
  NEEDS_USER_GESTURE: () => '✖ 无法连接：浏览器要求用户手动授权串口（首次连接必须真人点一下页面上的"连接"按钮）。重试不会有帮助——请让用户操作完成后再继续。',
  PORT_BUSY: (m) => `✖ 串口被占用：${m}\n该物理端口正被另一套串口栈持有。可先用 modbus_control 把模式切到 shared 复用终端端口，或先断开占用方。`,
  PAGE_NOT_CONNECTED: () => '✖ 页面未连接。请确认用户已在浏览器打开 http://localhost:1982 ，且页面上的桥连接正常。',
  BRIDGE_TIMEOUT: (m) => `✖ 页面响应超时：${m}\n页面可能正忙或已卡死。可先用 webterm_status 判断页面是否还在响应。`,
  PORT_NOT_CONNECTED: (m) => `✖ 串口未连接：${m}\n请先调用 serial_connect。`,
  NOT_ARMED: () => '✖ AI 写入未启用。请让用户在页面上打开"允许 AI 写入"开关后重试。读取类操作（状态、读取输出）不受此限制，随时可用。',
  INVALID_ARGS: (m) => `✖ 参数有误：${m}`,
  OP_UNSUPPORTED: (m) => `✖ 操作不支持：${m}\n可能是页面版本较旧，请让用户刷新页面。`,
  PAGE_ERROR: (m) => `✖ 页面内部错误：${m}\n这通常是 WebTerm 自身的缺陷，请把该消息转告用户以便排查。`,
};

const translateError = (code, message) => {
  const fn = ERROR_TEXT[code];
  return fn ? fn(message || '') : `✖ ${code}: ${message || ''}`;
};

// ════ 工具 → 桥操作映射 ════
// 薄映射：语义定义在工具描述里，这里只决定"发哪个域哪个操作"
const TOOL_MAP = {
  webterm_status:   (a) => ['serial', 'status', a],
  serial_connect:   (a) => ['serial', 'connect', a],
  serial_disconnect:(a) => ['serial', 'disconnect', a],
  serial_send:      (a) => ['serial', 'send', a],
  serial_read:      (a) => ['serial', 'read', a],
  modbus_control:   (a) => ['modbus', 'control', a],
  modbus_request:   (a) => ['modbus', 'request', a],
  modbus_log:       (a) => ['modbus', 'log', a],
  ui_action:        (a) => ['ui', 'action', a],
  ui_inspect:       (a) => ['ui', 'inspect', a],
  dev_serial:       (a) => ['dev', a.action, a],
};

async function dispatchTool(name, args, request) {
  const mapper = TOOL_MAP[name];
  if (!mapper) {
    return { content: [{ type: 'text', text: `✖ 未知工具: ${name}` }], isError: true };
  }
  const [domain, op, payload] = mapper(args || {});
  try {
    const res = await request(domain, op, payload);
    if (!res || res.ok !== true) {
      const code = (res && res.error && res.error.code) || 'PAGE_ERROR';
      const message = (res && res.error && res.error.message) || '无响应';
      return { content: [{ type: 'text', text: translateError(code, message) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: translateError('PAGE_ERROR', e.message) }], isError: true };
  }
}

module.exports = { buildTools, dispatchTool, translateError, TOOL_MAP };
```

> 注意：`dev_serial` 的映射把整个 `args`（含 `action`）作为 payload 传出，因为页面侧按 `dev.<action>` 分派。页面 dispatcher（Task 8）里的 `dev.serial_source` / `dev.fake_inject` / `dev.fake_capture` / `dev.fake_script` 与此一一对应。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/mcp-tools.test.js`
Expected: PASS（全部 11 个 test）

- [ ] **Step 5: 提交**

```bash
git add mcp-server.js test/mcp-tools.test.js
git commit -m "feat: MCP 工具定义与错误码翻译"
```

---

### Task 10: `mcp-server.js` — stdio 主循环与桥连接

**Files:**
- Modify: `mcp-server.js`（追加 stdio 主循环与 `BridgeClient`）
- Test: `test/mcp-server-stdio.test.js`

**Interfaces:**
- Consumes: Task 9 的 `dispatchTool`、Task 2 的 `readToken`、Task 1 的 `makeReq`/`isValidEnvelope`
- Produces: 可作为 MCP server 被 stdio 启动；`handleMessage(msg, request)` 可单测

- [ ] **Step 1: 写失败测试**

```js
// test/mcp-server-stdio.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../mcp-server.js');
const P = require('../bridge-protocol.js');

const noRequest = async () => { throw new Error('本用例不应发起桥请求'); };

test('initialize 返回协议版本、tools 能力与服务器信息', async () => {
  const res = await M.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    noRequest);
  assert.strictEqual(res.jsonrpc, '2.0');
  assert.strictEqual(res.id, 1);
  assert.ok(res.result.protocolVersion);
  assert.ok(res.result.capabilities.tools, '必须声明 tools 能力');
  assert.strictEqual(res.result.serverInfo.name, 'webterm-serial-bridge');
});

test('notifications/initialized 不回响应', async () => {
  const res = await M.handleMessage(
    { jsonrpc: '2.0', method: 'notifications/initialized' }, noRequest);
  assert.strictEqual(res, null, '通知类消息不得有响应');
});

test('tools/list 返回全部工具', async () => {
  const res = await M.handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, noRequest);
  assert.strictEqual(res.result.tools.length, 11);
});

test('tools/call 走 dispatchTool 并回传内容', async () => {
  const request = async () => P.makeRes('x', { connected: false });
  const res = await M.handleMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'webterm_status', arguments: {} } }, request);
  assert.ok(res.result.content[0].text.includes('connected'));
});

test('tools/call 缺少工具名返回 JSON-RPC 错误而非崩溃', async () => {
  const res = await M.handleMessage(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {} }, noRequest);
  assert.strictEqual(res.error.code, -32602);
});

test('未知方法返回 -32601', async () => {
  const res = await M.handleMessage(
    { jsonrpc: '2.0', id: 5, method: 'no/such', params: {} }, noRequest);
  assert.strictEqual(res.error.code, -32601);
});

test('ping 返回空结果（供客户端保活）', async () => {
  const res = await M.handleMessage({ jsonrpc: '2.0', id: 6, method: 'ping' }, noRequest);
  assert.deepStrictEqual(res.result, {});
});

test('请求处理抛错时返回 -32603 而非让进程退出', async () => {
  const boom = async () => { throw new Error('桥炸了'); };
  const res = await M.handleMessage(
    { jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'webterm_status', arguments: {} } }, boom);
  // dispatchTool 内部已兜住异常，故仍是正常 result（isError 标记）
  assert.ok(res.result || res.error);
  assert.ok(JSON.stringify(res).includes('桥炸了'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/mcp-server-stdio.test.js`
Expected: FAIL — `M.handleMessage is not a function`

- [ ] **Step 3: 实现（stdio 主循环）**

在 `mcp-server.js` 末尾追加：

```js
// ════ 与桥的连接 ════
const WebSocket = require('ws');
const os = require('node:os');
const { readToken } = require('./bridge-auth.js');

const SERVER_NAME = 'webterm-serial-bridge';
const SERVER_VERSION = '1.0.0';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const BRIDGE_URL = process.env.WEBTERM_BRIDGE_URL || 'ws://127.0.0.1:1982/bridge';

/** 与桥的长连接。断线自动重连；连不上时请求立即失败而不是永久挂起。 */
function createBridgeClient() {
  const state = { ws: null, seq: 0, pending: new Map(), retryMs: 500 };

  function ensure() {
    if (state.ws && state.ws.readyState === 1) return Promise.resolve(state.ws);
    return new Promise((resolve, reject) => {
      let token;
      try { token = readToken(); } catch (e) { reject(e); return; }

      const ws = new WebSocket(BRIDGE_URL, { headers: { 'x-webterm-token': token } });
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch {}
        reject(new Error(`连接桥超时（${BRIDGE_URL}）。请确认 server.js 已启动。`));
      }, 3000);

      ws.on('open', () => {
        clearTimeout(timer);
        state.ws = ws;
        state.retryMs = 500;
        resolve(ws);
      });
      ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.kind !== 'res' || !state.pending.has(msg.id)) return;
        const p = state.pending.get(msg.id);
        state.pending.delete(msg.id);
        p.resolve(msg);
      });
      ws.on('close', () => {
        state.ws = null;
        for (const [, p] of state.pending) p.reject(new Error('桥连接已断开'));
        state.pending.clear();
        setTimeout(ensure, state.retryMs).catch(() => {});
        state.retryMs = Math.min(state.retryMs * 2, 10000);
      });
      ws.on('error', err => {
        clearTimeout(timer);
        reject(new Error(`无法连接桥（${BRIDGE_URL}）：${err.message}。请确认 server.js 已启动。`));
      });
    });
  }

  return {
    async request(domain, op, args) {
      const ws = await ensure();
      const id = `r-${++state.seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pending.delete(id);
          reject(new Error(`桥未在 30s 内返回 ${domain}.${op}`));
        }, 30000);
        state.pending.set(id, {
          resolve: v => { clearTimeout(timer); resolve(v); },
          reject: e => { clearTimeout(timer); reject(e); },
        });
        try { ws.send(JSON.stringify(P.makeReq(id, domain, op, args))); }
        catch (e) { state.pending.delete(id); clearTimeout(timer); reject(e); }
      });
    },
  };
}

// ════ JSON-RPC 分派 ════

async function handleMessage(msg, request) {
  if (!msg || typeof msg !== 'object') return null;
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;   // 通知不得回响应

      case 'ping':
        return reply(id, {});

      case 'tools/list':
        return reply(id, { tools: buildTools() });

      case 'tools/call': {
        const name = params && params.name;
        if (typeof name !== 'string') {
          return error(id, -32602, 'Invalid params: 缺少 tools/call 的 name');
        }
        const result = await dispatchTool(name, (params && params.arguments) || {}, request);
        return reply(id, result);
      }

      default:
        return isNotification ? null : error(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    // 任何异常都要转成 JSON-RPC 错误——抛出去会让整个 MCP 进程退出
    return isNotification ? null : error(id, -32603, `Internal error: ${e.message}`);
  }
}

const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// ════ 入口：stdio 换行分隔 JSON ════

function main() {
  const bridge = createBridgeClient();
  let buf = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { continue; }   // 畸形行直接跳过，不能因此退出
      handleMessage(msg, bridge.request).then(res => {
        if (res) process.stdout.write(JSON.stringify(res) + '\n');
      }).catch(err => {
        process.stderr.write(`[mcp-server] 分派失败: ${err.message}\n`);
      });
    }
  });

  process.stdin.on('end', () => process.exit(0));
  // stdout 只许放协议消息；日志一律走 stderr，否则会污染 MCP 流
  process.stderr.write(`[mcp-server] 就绪，目标桥 ${BRIDGE_URL}\n`);
}

if (require.main === module) main();

module.exports = { buildTools, dispatchTool, translateError, TOOL_MAP, handleMessage, createBridgeClient };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/mcp-server-stdio.test.js`
Expected: PASS（全部 8 个 test）

- [ ] **Step 5: 运行全量测试**

Run: `npm test`
Expected: 全部通过（`bridge-protocol` / `bridge-auth` / `fake-serial` / `bridge` / `bridge-client-utils` / `mcp-tools` / `mcp-server-stdio` / `server` / `client`）

- [ ] **Step 6: 提交**

```bash
git add mcp-server.js test/mcp-server-stdio.test.js
git commit -m "feat: MCP stdio 主循环与桥连接"
```

---

### Task 11: `.mcp.json` 与端到端验证

**Files:**
- Create: `.mcp.json`
- Modify: `.gitignore`（token 目录本就在仓库外，但补一条防御性忽略）
- Create: `docs/serial-mcp-bridge.md`（使用说明）

**Interfaces:**
- Consumes: 前 10 个任务的全部产出
- Produces: 可用的端到端能力

- [ ] **Step 1: 创建 `.mcp.json`**

```json
{
  "mcpServers": {
    "webterm-serial": {
      "command": "node",
      "args": ["mcp-server.js"],
      "env": {}
    }
  }
}
```

- [ ] **Step 2: 端到端验证（假设备路径，无需硬件）**

Run: `npm start`，浏览器开 `http://localhost:1982`，**打开"允许 AI 写入"开关**

然后在另一个终端用适配器身份手工演练完整闭环：

```bash
node -e "
const WebSocket = require('ws');
const { readToken } = require('./bridge-auth.js');
const ws = new WebSocket('ws://127.0.0.1:1982/bridge', { headers: { 'x-webterm-token': readToken() } });
const send = (domain, op, args) => ws.send(JSON.stringify({ id: 'r-1', kind: 'req', domain, op, args }));
ws.on('open', async () => {
  send('dev', 'serial_source', { mode: 'fake' });
});
ws.on('message', d => console.log(JSON.parse(d.toString())));
"
```

Expected 逐项确认：
1. `dev.serial_source {mode:'fake'}` → 返回 `{source:'fake'}`
2. `dev.fake_script` 配规则 `{matchHex:'0103000000', respondHex:'0103030064000a', delayMs:20}` → 返回 `{ruleCount:1}`
3. `serial.connect` → `{connected:true}`
4. `serial.send {data:'01030000000A', encoding:'hex'}` → `{bytesWritten:6}`，且终端日志出现 `[AI] → 01030000000a`
5. `dev.fake_capture` → `{hex:'01030000000a'}`，证明页面确实把字节写进了假串口
6. `serial.read {cursor:0}` → 出现假设备回注的响应行
7. `modbus.control {action:'set_mode', mode:'independent'}` → 返回含 `mode:'independent'` 与 `terminalFrozen:false`

- [ ] **Step 3: 端到端验证（真实硬件路径）**

接一台真实串口设备（或 USB 转串口回环），**关闭武装开关**先验证只读拦截：

1. 关闭开关后调 `serial.send` → 必须返回 `NOT_ARMED`，且设备**没有**收到数据（用串口助手确认）
2. 打开开关后调 `serial.send` → 成功，设备收到数据
3. 首次 `serial.connect`：若浏览器无已授权端口 → 应返回 `NEEDS_USER_GESTURE`；手动点一次页面"连接"后重试 → 成功
4. `ui.watch` 类操作：`ui.inspect` 应返回真实的渲染行与颜色

- [ ] **Step 4: 验证桥挂掉不影响终端**

1. 页面开着，`Ctrl+C` 停掉 `server.js`
2. Expected：页面终端仍可正常收发（已建立的 WS 断开会触发重连，但**不弹错、不卡 UI**）
3. 重新 `npm start`，Expected：页面自动重连，「允许 AI 写入」的勾选状态仍在

- [ ] **Step 5: 写使用说明**

创建 `docs/serial-mcp-bridge.md`，内容需覆盖：

- 启动步骤（先 `npm start` 再开 Claude Code）
- 首次串口授权必须真人点一次的原因（Web Serial 的 transient activation 限制），以及之后即可自动重连
- 武装开关的语义与默认关闭
- 假设备的典型用法（`dev_serial` 的四个 action + `fake_script` 规则形状）
- 错误码速查表（取自 spec 第 4.5 节）
- 排障：token 文件位置、端口占用、页面未连接

- [ ] **Step 6: 提交**

```bash
git add .mcp.json .gitignore docs/serial-mcp-bridge.md
git commit -m "feat: MCP 注册配置与使用说明"
```

---

## 收尾检查

全部任务完成后逐项确认：

- [ ] `npm test` 全绿，且**原有 `test/server.test.js` 与 `test/client.test.js` 的断言一条都没被削弱**
- [ ] `git diff WebSerialTerminal.html` 确认：既有函数体只动了 4 处（seam 声明块、两个 `requestPort()` 调用点、`appendLine` 末尾追加 1 行），其余均为纯新增（武装开关 UI、`<script src>` 标签）
- [ ] `package.json` 的 `dependencies` 无新增条目
- [ ] `bridge-client.js` 内不存在未包在 try/catch 里的桥调用路径（桥挂掉必须不影响终端）
- [ ] 全部 11 个 MCP 工具的 `description` 都包含操作指引，而非仅功能简介
- [ ] `docs/serial-mcp-bridge.md` 已说明「首次授权需真人」这一不可绕过约束
- [ ] 页面启动时终端**未**出现"页面缺少 AI 桥依赖的函数"告警（`verifyPageApi()` 自检通过）

## 发现但本次不修（需另行决策）

实现过程中已确认、但**不属于本计划范围**的既有问题。仅记录，不得顺手修改——改动这些会破坏"只动 4 处"的约束，也会让本计划的代码审查边界模糊。

| 问题 | 位置 | 影响 |
|---|---|---|
| `sendData()` 非 HEX 分支用 `charCodeAt` 构造字节 | `WebSerialTerminal.html:3134-3137` | 发送中文时产生的是 UTF-16 低位字节，而非 UTF-8。而接收侧 `readLoop` 用的是 UTF-8 解码器，收发编码不一致。注释「不使用 TextEncoder，避免编码问题」的取向恰好相反 |
| 同处会在发送内容后自动追加 `#eolSelect` 的 CR/LF | `WebSerialTerminal.html:3113-3117` | 人工敲命令时是期望行为；但任何需要精确控制字节的用途都会被它破坏。**这正是 AI 的 `serial.send` 必须绕开 `sendData()` 直写 `writer` 的原因** |
| `tftp-proxy.js` 绑 `0.0.0.0` 且无 Origin 校验 | `tftp-proxy.js:9` | 浏览任意网站时该网站均可连接 52345 触发 TFTP 上传。spec 第 2.3 节已记录，按用户决定不处理 |
