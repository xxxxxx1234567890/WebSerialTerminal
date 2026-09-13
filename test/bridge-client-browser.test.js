// bridge-client.js 浏览器分支的端到端测试。
//
// 页面没有 DOM 测试环境，纯函数测试（bridge-client-utils.test.js）覆盖不到
// WS 客户端、dispatcher、武装开关与假串口接线——而这几处恰恰是最容易"测试全绿、
// 真机不能用"的地方。本文件的做法是：在 vm 里搭一个最小 DOM，加载**真实的**
// bridge-protocol.js / fake-serial.js / bridge-client.js，再从 WebSerialTerminal.html
// **原样切出**真实的 connectPort / readLoop / appendLine 一起跑。
//
// 这带来两点独一无二的能力：
//   1. 真实 readLoop 从假串口读到真实 appendLine 再灌进环形缓冲这条链路能被执行到
//      （test/fake-serial.test.js 只测到 FakeSerialPort 本身为止）
//   2. REQUIRED_PAGE_API 是对**真实页面**校验的——函数改名会在这里红，而不是等 AI 超时
//
// 铁律：任何等待都必须有界、不留悬挂的句柄。npm test 是 node --test 且不带
// --test-timeout，一次挂起就是无界挂起。故：不使用真实计时器做等待（只用 setImmediate
// 轮询且有次数上限），sandbox 里的 setTimeout 一律 .unref() 并被 t.after 清理。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(REPO, 'WebSerialTerminal.html'), 'utf8');

/** 从真实 HTML 里切出一个顶层函数。锚点找不到时必须响亮失败——
 *  静默跳过会让这个文件在页面被重构后继续"全绿"，而它正是为此存在的。 */
function extractFn(name) {
  const m = new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\(').exec(HTML);
  assert.ok(m, `WebSerialTerminal.html 里找不到 function ${name}( —— 页面被重构了？` +
    '本测试的锚点是函数名，改名后必须同步更新 bridge-client.js 的 REQUIRED_PAGE_API');
  const open = HTML.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}') { depth--; if (!depth) return HTML.slice(m.index, i + 1); }
  }
  assert.fail(`WebSerialTerminal.html 里 function ${name}( 的大括号不配对`);
}

// ── 最小 DOM ──
class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.className = ''; this._text = '';
    this.style = {}; this.checked = false; this.value = ''; this.scrollTop = 0;
    this.scrollHeight = 0; this.innerHTML = ''; this.listeners = {};
  }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0]; }
  addEventListener(t, fn) { this.listeners[t] = fn; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    return this.children.length ? this.children.map(c => c.textContent).join('') : this._text;
  }
  querySelector(sel) {
    const cls = sel.replace('.', '');
    const walk = e => {
      for (const c of e.children) {
        if ((c.className || '').split(' ').includes(cls)) return c;
        const r = walk(c); if (r) return r;
      }
      return null;
    };
    return walk(this);
  }
}

const SELECT_VALUES = {
  baudRate: '115200', dataBits: '8', stopBits: '1', parity: 'none', flowControl: 'none',
  mbBaudRate: '9600', mbDataBits: '8', mbStopBits: '1', mbParity: 'none', mbFlowControl: 'none',
  colorTheme: 'green', fontSize: '14', maxLines: '2000',
  mbSlaveId: '1', mbFuncCode: '3', mbAddress: '0', mbQuantity: '10', mbWriteData: '',
  mvCycleInterval: '1000',
};
const CHECKBOXES = ['chkTimestamp', 'chkHex', 'chkAutoScroll', 'chkLocalEcho', 'mbActivate',
  'mbAddrMode', 'mvAddrMode'];

/**
 * 搭一个隔离的沙箱：真实三个桥文件 + 真实 connectPort/readLoop/appendLine。
 * 返回的对象里 req() 把请求投给页面并等它处理完（不靠 sleep，靠 await 处理器本身）。
 */
function bootstrap({ protocol = 'http:' } = {}) {
  const ids = new Map();
  for (const [id, v] of Object.entries(SELECT_VALUES)) {
    const el = new El('input'); el.value = v; ids.set(id, el);
  }
  for (const id of CHECKBOXES) {
    const el = new El('input');
    el.checked = id === 'chkAutoScroll' || id === 'chkLocalEcho';
    ids.set(id, el);
  }
  for (const id of ['terminalOutput', 'statusLines', 'statLines', 'aiArmedToggle',
    'aiArmedHint', 'modbusRxDisplay', 'modbusDataDisplay', 'modbusTxDisplay']) {
    ids.set(id, new El('div'));
  }

  const lines = [];               // 终端日志（type|text）
  const timers = new Set();       // sandbox 里排过的计时器，teardown 时全部清掉
  const domReady = [];
  let lastWs = null;
  let wsCount = 0;

  const sandbox = {
    __reqPortCalls: 0,
    console, TextDecoder, TextEncoder, Uint8Array, ReadableStream, WritableStream,
    Array, Object, Math, JSON, Date, Number, String, Promise, Set, Map, Error, TypeError,
    isNaN, parseInt, parseFloat, clearTimeout, Boolean,
    navigator: {
      serial: {
        getPorts: async () => [],
        requestPort: async () => { sandbox.__reqPortCalls++; throw new Error('不应被调用'); },
      },
    },
    location: { protocol, host: 'localhost:1982' },
    crypto: { randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    localStorage: {
      _d: new Map(),
      getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
      setItem(k, v) { this._d.set(k, String(v)); },
    },
    document: {
      getElementById: id => ids.get(id) || null,
      createElement: t => new El(t),
      addEventListener: (t, fn) => { domReady.push(fn); },
      querySelectorAll: () => [],
    },
    getComputedStyle: () => ({ color: 'rgb(0, 255, 65)' }),
    // 计时器一律 unref：桥的重连退避绝不能让 node --test 挂住不退
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); if (h.unref) h.unref(); timers.add(h); return h; },
    clearTimeout: h => { timers.delete(h); return clearTimeout(h); },

    WebSocket: class {
      constructor(url) { wsCount++; this.url = url; this.sent = []; lastWs = this; }
      send(s) { this.sent.push(s); }
      // 显式触发而不是靠定时器：测试自己决定何时算"连上了"
      open() { this.onopen && this.onopen(); }
      close() { if (this.onclose) this.onclose(); }
      /** 投递一条消息并等页面处理完（onmessage 是 async，直接 await 它，不用 sleep） */
      deliver(obj) { return Promise.resolve(this.onmessage({ data: JSON.stringify(obj) })); }
    },

    // 页面侧桩（记录型）。appendLine 稍后被真实实现替换并包一层记录。
    appendLine: (type, text) => { lines.push(type + '|' + text); },
    parseAnsiToFragment: t => { const e = new El('span'); e.className = 'line-content'; e.textContent = t; return e; },
    updateUI: () => {}, updateCounters: () => {}, showNotification: () => {},
    formatBytes: n => String(n),
    modbusFeedResponse: () => {}, modbusRenderLog: () => {}, modbusToggleActive: () => {},
    modbusSetMode: () => {}, modbusConnectPort: async () => {}, modbusDisconnectPort: async () => {},
    modbusStartCycle: () => { sandbox.__cycleStarted = true; }, modbusStopCycle: () => {},
    modbusConstructFrame: (sid, fc, addr, qty, wd) => {
      const buf = [sid & 0xFF, fc & 0xFF, (addr >> 8) & 0xFF, addr & 0xFF];
      if (fc <= 4) buf.push((qty >> 8) & 0xFF, qty & 0xFF);
      else if (fc === 5 || fc === 6) buf.push((wd >> 8) & 0xFF, wd & 0xFF);
      return new Uint8Array(buf.concat([0xAA, 0xBB]));
    },
    modbusShowResponse: () => {}, modbusAddLog: () => {},
    modbusParseAddress: () => 0, modbusViewSyncAddrMode: () => {},
    // 模拟页面解析出响应，让 modbus.request 立刻结束而不是干等 1500ms 超时。
    // 注意：installModbusCapture() 会把 window.modbusShowResponse 换成包装器，
    // 而 window === 本沙箱全局，所以这里读到的正是包装后的版本（截获链路因此被走到）。
    modbusSend: () => {
      sandbox.__sendCalled = true;
      sandbox.modbusShowResponse({
        type: 'success', slaveId: 1, funcCode: 6,
        pdu: new Uint8Array([0x00, 0x0A]),
        raw: new Uint8Array([0x01, 0x06, 0x00, 0x00, 0x00, 0x0A, 0xAA, 0xBB]),
      });
    },
    modbusOnFuncCodeChange: () => {},
    clearTerminal: () => {}, togglePause: () => {}, toggleSidebar: () => {},
    sendData: async () => {}, saveLog: async () => {}, applySettings: () => {}, saveState: () => {},
    connectPort: null, disconnectPort: async () => {},
    // 页面状态变量
    isConnected: false, isPaused: false, rxBytes: 0, txBytes: 0, rxLines: 0, errors: 0,
    lineCount: 0, rxBuffer: '', rxBytesLastSec: 0, readLoopRunning: false, sidebarOpen: true,
    modbusPortMode: 'shared', modbusActive: false, modbusConnected: false, modbusCycling: false,
    modbusSendTime: 0, modbusLog: [], modbusAddrHex: false,
    settings: { fontSize: 14, colorTheme: 'green', maxLines: 2000, logDir: '' },
    macros: [{ label: 'AT', cmd: 'AT' }], port: null, writer: null, reader: null,
  };
  sandbox.JSON_ = JSON;
  vm.createContext(sandbox);
  vm.runInContext('var window = globalThis; var self = globalThis;', sandbox);

  for (const f of ['bridge-protocol.js', 'fake-serial.js', 'bridge-client.js']) {
    vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), sandbox, { filename: f });
  }
  // 页面里真实的 seam + connectPort + readLoop + appendLine
  vm.runInContext(extractFn('connectPort'), sandbox, { filename: 'connectPort' });
  vm.runInContext(extractFn('readLoop'), sandbox, { filename: 'readLoop' });
  vm.runInContext(extractFn('appendLine'), sandbox, { filename: 'appendLine' });
  vm.runInContext(`
    window.realSerialProvider = {
      requestPort: () => navigator.serial.requestPort(),
      getPorts:    () => navigator.serial.getPorts(),
    };
    var serialProvider = window.realSerialProvider;
  `, sandbox);
  // 包一层记录，但仍走真实 appendLine（环形缓冲那条通路也真被走到）
  sandbox.__record = (t, x) => { lines.push(t + '|' + x); };
  vm.runInContext('var __realAppend = appendLine;' +
    ' appendLine = function (t, x, a) { __record(t, x); return __realAppend(t, x, a); };', sandbox);

  const api = {
    sandbox,
    lines,
    ids,
    get ws() { return lastWs; },
    get wsCount() { return wsCount; },
    /** 已渲染进终端缓冲的行文本（时间戳 + 方向标 + 内容） */
    rendered: () => ids.get('terminalOutput').children.map(c => c.textContent),
    /** 只取真正收到的串口数据行：RX 行以 'RX' 开头，系统/审计行以 '··' 开头 */
    received: () => ids.get('terminalOutput').children.map(c => c.textContent)
      .filter(x => x.startsWith('RX')).map(x => x.slice(2)),
    /** 跑 DOMContentLoaded 的各个监听器（桥的初始化在这里发生） */
    async ready() { for (const fn of domReady) await fn(); },
  };

  api.req = async (domain, op, args) => {
    await lastWs.deliver({ id: 'r' + (api.seq = (api.seq || 0) + 1), kind: 'req', domain, op, args: args || {} });
    return JSON.parse(lastWs.sent[lastWs.sent.length - 1]);
  };
  api.audits = () => lines.filter(l => l.startsWith('sys|[AI] ')).map(l => l.slice(8));
  api.teardown = async () => {
    // 先置标志位再关端口：与页面 disconnectPort 的 flag-first 模式一致，
    // 否则 readLoop 会在已关闭的流上反复拿到 {done:true} 变成死循环
    sandbox.isConnected = false;
    sandbox.readLoopRunning = false;
    try { if (sandbox.port) await sandbox.port.close(); } catch { /* 已关 */ }
    try { if (sandbox.reader) sandbox.reader.releaseLock(); } catch { /* 已释放 */ }
    for (const h of timers) clearTimeout(h);
    timers.clear();
  };
  return api;
}

/** 有界的条件等待：只用 setImmediate，绝不 sleep。超时即断言失败（不会悬挂）。 */
async function waitFor(pred, what, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise(r => setImmediate(r));
  }
  assert.fail('等待超时：' + what);
}

// ════════════════════════════════════════════════════════
// 一、启动与握手
// ════════════════════════════════════════════════════════

test('启动：只初始化一次、握手报文正确、真实页面的依赖函数一个不缺', async t => {
  const b = bootstrap();
  t.after(b.teardown);

  assert.strictEqual(b.wsCount, 0, '脚本加载阶段不得开 WS（factory 只能调用一次）');
  await b.ready();
  assert.strictEqual(b.wsCount, 1, 'DOMContentLoaded 后应恰好开一条 WS');
  assert.strictEqual(b.ws.url, 'ws://localhost:1982/bridge');

  b.ws.open();                                  // hello 在 onopen 里发
  const hello = JSON.parse(b.ws.sent[0]);
  assert.strictEqual(hello.kind, 'hello');
  assert.strictEqual(hello.role, 'page');
  assert.strictEqual(hello.protocolVersion, 1);
  assert.deepStrictEqual(hello.capabilities, ['serial', 'modbus', 'ui', 'dev']);

  // 关键：这是对**真实 WebSerialTerminal.html** 的校验，函数被改名会在这里红
  assert.deepStrictEqual(b.audits().filter(l => l.includes('缺少 AI 桥依赖的函数')), [],
    'REQUIRED_PAGE_API 里的每个名字都必须在真实页面里找得到');
  assert.deepStrictEqual(b.audits().filter(l => l.includes('无法包装 Modbus')), [],
    'modbusShowResponse / modbusAddLog 必须可被包装');
  assert.strictEqual(b.sandbox.localStorage.getItem('wtp_ai_armed'), null, '默认不写武装键');
});

test('WS 地址按 location.protocol 推导：https 页面用 wss，不写死 ws', async t => {
  // 写死 ws:// 会让 https 打开的页面被混合内容策略拦掉，然后无限重试且终端里零提示
  const b = bootstrap({ protocol: 'https:' });
  t.after(b.teardown);
  await b.ready();
  assert.strictEqual(b.ws.url, 'wss://localhost:1982/bridge');
});

test('连不上本机桥时只在终端报一次，且不阻塞任何页面逻辑', async t => {
  const b = bootstrap();
  t.after(b.teardown);
  await b.ready();
  b.ws.close();                       // 从没 open 过就断了
  assert.strictEqual(b.audits().filter(l => l.includes('未能连接本机 AI 桥')).length, 1);
  b.ws.close();                       // 再断一次
  assert.strictEqual(b.audits().filter(l => l.includes('未能连接本机 AI 桥')).length, 1,
    '报一次就够，不能刷屏');
});

test('桥的 kind:error 进入终端日志（不是被 isValidEnvelope 丢掉）', async t => {
  const b = bootstrap();
  t.after(b.teardown);
  await b.ready();
  b.ws.open();
  await b.ws.deliver({ kind: 'error', message: '协议版本不匹配：页面 1，桥 2。请刷新页面。' });
  const hit = b.audits().find(l => l.includes('桥拒绝了连接'));
  assert.ok(hit, '桥的拒绝通知必须落到终端日志，否则版本不匹配无从诊断');
  assert.match(hit, /协议版本不匹配/);
});

// ════════════════════════════════════════════════════════
// 二、武装开关与审计覆盖
// ════════════════════════════════════════════════════════

test('武装开关：读取放行、写入拦下', async t => {
  const b = bootstrap();
  t.after(b.teardown);
  await b.ready();
  b.ws.open();

  // 读取类不受限
  for (const [d, o, a] of [['serial', 'status'], ['modbus', 'log'], ['modbus', 'status'],
    ['ui', 'inspect'], ['ui', 'action', { action: 'list_macros' }]]) {
    const r = await b.req(d, o, a);
    assert.strictEqual(r.ok, true, `${d}.${o} 是只读，未武装也必须放行：` + JSON.stringify(r));
  }

  // 写入类被拦，且回的是 NOT_ARMED
  for (const [d, o, a] of [['serial', 'send', { data: 'AT' }], ['serial', 'connect', {}],
    ['serial', 'disconnect', {}], ['serial', 'set_params', {}],
    ['modbus', 'control', { action: 'activate' }], ['modbus', 'control', { action: 'cycle_start' }],
    ['modbus', 'request', {}], ['ui', 'action', { action: 'clear' }],
    ['ui', 'action', { action: 'run_macro', name: 'AT' }], ['ui', 'action', { action: 'save_log' }],
    ['ui', 'action', { action: 'set_theme', theme: 'amber' }], ['dev', 'serial_source', { mode: 'fake' }],
    ['dev', 'fake_script', { rules: [] }]]) {
    const r = await b.req(d, o, a);
    assert.strictEqual(r.ok, false, `${d}.${o} 是写入，未武装必须拦下`);
    assert.strictEqual(r.error.code, 'NOT_ARMED', `${d}.${o} 应回 NOT_ARMED：` + JSON.stringify(r));
  }

  b.sandbox.localStorage.setItem('wtp_ai_armed', '1');
  const r = await b.req('serial', 'status');
  assert.strictEqual(r.ok, true, '武装后读取照常');
});

test('审计覆盖：每个写入操作都留下可读的 [AI] 行（含最高危的启动轮询）', async t => {
  // spec 5.5 把 [AI] 轨迹当作"不做逐次确认"的唯一补偿控制，覆盖必须是结构性的。
  // 这里走**真实的 dispatcher**，而不是直接调 describeWrite。
  const b = bootstrap();
  t.after(b.teardown);
  await b.ready();
  b.ws.open();
  b.sandbox.localStorage.setItem('wtp_ai_armed', '1');
  // 让每个操作都走成功路径，这样"N 个写入 = N 条审计行"才是个干净的等式
  // （失败会额外补一条 ✖ 失败行，那是另一条测试关心的事）
  b.sandbox.isConnected = true;
  b.sandbox.modbusActive = true;

  const before = b.audits().length;
  const cases = [
    ['serial', 'disconnect', {}],
    ['serial', 'set_params', { baudRate: 115200 }],
    ['modbus', 'control', { action: 'cycle_start' }],
    ['modbus', 'control', { action: 'cycle_stop' }],
    ['ui', 'action', { action: 'clear' }],
    ['ui', 'action', { action: 'pause' }],
    ['ui', 'action', { action: 'set_theme', theme: 'amber' }],
    ['ui', 'action', { action: 'save_log' }],
  ];
  for (const [d, o, a] of cases) {
    const r = await b.req(d, o, a);
    assert.strictEqual(r.ok, true, `${d}.${o} 应成功，实际 ` + JSON.stringify(r));
  }

  const added = b.audits().slice(before);
  assert.deepStrictEqual(added.filter(l => l.startsWith('✖ 失败：')), [],
    '这些操作都应成功，不该出现失败行');
  assert.strictEqual(added.length, cases.length,
    '每个写入操作应恰好留下一条意图审计行，实际：\n' + added.join('\n'));

  // 最高危的一条：轮询会持续对真实硬件发报文，行里必须说清对谁发什么
  const cycle = added.find(l => l.includes('轮询'));
  assert.ok(cycle, '启动/停止轮询必须有审计行');
  assert.match(cycle, /slave=1/, '审计行要带上将要对哪个从站发什么');
  assert.match(cycle, /fc=3/);
  assert.match(cycle, /间隔=1000ms/);
  assert.strictEqual(b.sandbox.__cycleStarted, true, '审计之外，动作仍须真的执行');

  // ui.action 这一类也要有可读的动作名，而不是 'undefined'
  assert.ok(added.some(l => /界面动作 clear/.test(l)), added.join('\n'));
  assert.ok(added.some(l => /主题切到 amber/.test(l)), added.join('\n'));
  assert.ok(!added.some(l => l.includes('undefined')), '审计行不得出现 undefined：' + added.join('\n'));
});

// ════════════════════════════════════════════════════════
// 三、参数契约
// ════════════════════════════════════════════════════════

test('dev.fake_inject 默认按 hex 注入（与 dev_serial schema 声明的默认值一致）', async t => {
  const b = bootstrap();
  t.after(b.teardown);
  await b.ready();
  b.ws.open();
  b.sandbox.localStorage.setItem('wtp_ai_armed', '1');
  await b.req('dev', 'serial_source', { mode: 'fake' });
  await b.req('serial', 'connect', {});
  await waitFor(() => b.sandbox.readLoopRunning === true, '读循环应已启动');

  // {data:'41'} 按 hex 就是 1 个字节 0x41；按 ascii 会是 2 个字节 0x34 0x31。
  // 用 readLoop 累加的 rxBytes 直接数出来，比间接推断更硬。
  const before = b.sandbox.rxBytes;
  await b.req('dev', 'fake_inject', { data: '41' });
  await waitFor(() => b.sandbox.rxBytes > before, '注入的字节应被读循环收到');
  assert.strictEqual(b.sandbox.rxBytes - before, 1,
    "data:'41' 必须按 hex 注入成 1 字节 0x41；若为 2 字节说明默认值退回成了 ascii");

  // 再验证字节内容：先注入 '0a' 把上一步留在行缓冲里的 'A' flush 成一行
  await b.req('dev', 'fake_inject', { data: '0a' });
  await waitFor(() => b.received().length > 0, "注入换行后应 flush 出 'A' 这一行");
  assert.deepStrictEqual(b.received(), ['A'],
    "data:'410a' 按 hex 解析是 0x41+换行，渲染出来应正好是 'A'；"
    + "若出现 '410a' 字样说明按 ascii 编码了");
});

test('serial.send 默认仍是 ascii（与 fake_inject 的 hex 默认不可混同）', async t => {
  const b = bootstrap();
  t.after(b.teardown);
  await b.ready();
  b.ws.open();
  b.sandbox.localStorage.setItem('wtp_ai_armed', '1');
  await b.req('dev', 'serial_source', { mode: 'fake' });
  const r = await b.req('serial', 'connect', {});
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  await b.req('serial', 'send', { data: 'AT' });
  const cap = await b.req('dev', 'fake_capture', {});
  assert.strictEqual(cap.data.hex, '4154', 'ascii 默认应把 AT 编成 0x41 0x54');
});

test('modbus.request 先校验再碰 DOM：非法参数回 INVALID_ARGS，不改表单也不留虚假报文记录', async t => {
  const b = bootstrap();
  t.after(b.teardown);
  await b.ready();
  b.ws.open();
  b.sandbox.localStorage.setItem('wtp_ai_armed', '1');
  b.sandbox.isConnected = true;               // 让"有可用串口"这一关先过
  b.sandbox.modbusActive = true;              // 让"Modbus 已启用"这一关先过

  const form = () => ({
    slaveId: b.ids.get('mbSlaveId').value,
    funcCode: b.ids.get('mbFuncCode').value,
    address: b.ids.get('mbAddress').value,
    quantity: b.ids.get('mbQuantity').value,
  });
  const before = form();

  // 故意用与表单默认值都不同的数字：只要有任何一次"先写 DOM 再校验"，
  // 表单就会变样，断言立刻抓得到（用与默认值相同的数字就抓不到了）
  const r = await b.req('modbus', 'request', { slaveId: 200, funcCode: 99, address: 4321, quantity: 7 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'INVALID_ARGS',
    '非法参数应立刻回 INVALID_ARGS，而不是等到 1500ms 超时：' + JSON.stringify(r));
  assert.match(r.error.message, /funcCode/);
  assert.deepStrictEqual(form(), before,
    '校验失败不得改动用户可见的 Modbus 表单（否则会写进字面量 "undefined"）');
  assert.ok(!b.audits().some(l => l.includes('Modbus → ')),
    '校验失败不得留下"已发出某帧"的记录：' + b.audits().join('\n'));

  // 缺 writeData 的写功能码同样要先被拦住
  const r2 = await b.req('modbus', 'request', { slaveId: 88, funcCode: 6, address: 55, quantity: 3 });
  assert.strictEqual(r2.error.code, 'INVALID_ARGS');
  assert.match(r2.error.message, /writeData/);
  assert.deepStrictEqual(form(), before,
    '这一路同样不得改动表单：' + JSON.stringify(form()));
  assert.ok(!b.audits().some(l => l.includes('Modbus → ')),
    '不得留下从未发出的报文记录：' + b.audits().join('\n'));

  // 合法参数必须照常走到发送，并且拿到（被包装器截获的）解析结果
  const ok = await b.req('modbus', 'request',
    { slaveId: 1, funcCode: 6, address: 0, quantity: 1, writeData: '000A' });
  assert.strictEqual(b.sandbox.__sendCalled, true, '合法参数应真的调用 modbusSend');
  assert.strictEqual(b.ids.get('mbWriteData').value, '00 0a',
    '回填给页面的必须是空格分隔的字节，页面才解析得出同一组字节');
  assert.strictEqual(ok.ok, true, '应通过包装器截获到结果：' + JSON.stringify(ok));
  assert.strictEqual(ok.data.outcome, 'success');
  assert.strictEqual(ok.data.slaveId, 1);
  assert.ok(ok.data.txHex.length > 0, '应返回请求帧的十六进制');
  assert.ok(b.audits().some(l => l.includes('Modbus → ')), '合法请求要留下线缆级审计行');
});

// ════════════════════════════════════════════════════════
// 四、假设备端到端（真实 connectPort / readLoop / appendLine）
// ════════════════════════════════════════════════════════

test('假设备端到端：真实 connectPort 打开假串口，真读循环把数据送进环形缓冲', async t => {
  const b = bootstrap();
  t.after(b.teardown);
  await b.ready();
  b.ws.open();
  b.sandbox.localStorage.setItem('wtp_ai_armed', '1');

  await b.req('dev', 'serial_source', { mode: 'fake' });
  const fake = (await b.sandbox.serialProvider.getPorts())[0];
  assert.ok(fake, '假设备应已装进 serialProvider');

  const r = await b.req('serial', 'connect', {});
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  // 真实 connectPort 打开的必须是假串口，且读循环真的跑起来了
  assert.strictEqual(b.sandbox.port, fake, 'connectPort 打开的应是 FakeSerialPort');
  assert.strictEqual(fake.isOpen, true);
  assert.strictEqual(b.sandbox.isConnected, true);
  assert.strictEqual(b.sandbox.readLoopRunning, true);
  assert.strictEqual(b.sandbox.__reqPortCalls, 0, 'AI 路径必须全程免手势，绝不调 requestPort');

  // 发送 → 假设备捕获
  await b.req('serial', 'send', { data: 'AA55', encoding: 'hex' });
  assert.strictEqual((await b.req('dev', 'fake_capture', {})).data.hex, 'aa55');
  await b.req('dev', 'fake_capture', { clear: true });
  assert.strictEqual((await b.req('dev', 'fake_capture', {})).data.length, 0);

  // 注入 → 真实 readLoop → 真实 appendLine → 环形缓冲 → serial.read
  await b.req('dev', 'fake_inject', { data: '48656c6c6f0a', encoding: 'hex' });
  await waitFor(() => b.rendered().some(x => x.includes('Hello')), '注入的字节应被真实 readLoop 渲染成行');
  const read = await b.req('serial', 'read', { cursor: 0, max: 50 });
  assert.ok(read.data.lines.includes('Hello'), 'serial.read 应拿到真实渲染过的行：' + JSON.stringify(read.data));

  // 游标增量
  await b.req('dev', 'fake_inject', { data: '776f726c640a', encoding: 'hex' });
  await waitFor(() => b.rendered().some(x => x.includes('world')), '第二行应被渲染');
  const inc = await b.req('serial', 'read', { cursor: read.data.cursor, max: 50 });
  assert.ok(inc.data.lines.includes('world'), JSON.stringify(inc.data));
  assert.ok(!inc.data.lines.includes('Hello'), '已读过的行不应重复返回');

  // ui.inspect 走真实 DOM 结构
  const insp = await b.req('ui', 'inspect', {});
  assert.strictEqual(insp.ok, true, JSON.stringify(insp));
  assert.strictEqual(insp.data.lastLines[insp.data.lastLines.length - 1].text, 'world');
  assert.strictEqual(insp.data.lastLines[0].color, 'rgb(0, 255, 65)', '应取计算后颜色');
});

test('异常不外泄：未知操作回 OP_UNSUPPORTED，非 JSON 消息被静默忽略', async t => {
  const b = bootstrap();
  t.after(b.teardown);
  await b.ready();
  b.ws.open();
  const r = await b.req('serial', 'nope', {});
  assert.strictEqual(r.error.code, 'OP_UNSUPPORTED');
  await b.ws.onmessage({ data: 'not json' });     // 不得抛
  assert.strictEqual(b.wsCount, 1);
});
