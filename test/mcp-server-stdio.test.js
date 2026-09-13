// test/mcp-server-stdio.test.js
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const M = require('../mcp-server.js');
const P = require('../bridge-protocol.js');
const { writeToken } = require('../bridge-auth.js');

const noRequest = async () => { throw new Error('本用例不应发起桥请求'); };

// 临时 HOME：readToken() 从 baseDir()=$WEBTERM_HOME 读 token，写在这里就不碰真实用户目录。
// 必须写在与桥替身同一个 token 上——客户端与桥握手靠的就是它。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-stdio-'));
const { token: TOKEN } = writeToken(HOME);
process.env.WEBTERM_HOME = HOME;

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

// ════════════════════════════════════════════════════════
// createBridgeClient 的守护
// ════════════════════════════════════════════════════════
// 上面 8 条全部只走 handleMessage 的纯函数路径，够不到 createBridgeClient。
// 而本任务最严重的一个缺陷正落在它的重连路径上：简报原文写的是
// `setTimeout(ensure, retryMs).catch(() => {})`——setTimeout 返回 Timeout 对象
// 而非 Promise，那个 .catch 会在 ws 的 'close' 处理器里抛 TypeError，把整个
// MCP 进程带崩（且紧随其后的退避自增永不执行，重连永远停在第一级）。
// 那次是靠一次性现场复现抓到的，一次性不留痕迹：把该行写回去，测试会全绿而
// 进程照样崩。以下两条把这个缺口补上。

/**
 * 取一份绑定到指定桥 URL 的 mcp-server 实例。
 * BRIDGE_URL 在模块求值时快照，而端口要等 listen(0) 之后才知道，所以只能
 * "先设 env、再清缓存重新 require"。返回全新实例（独立的 BRIDGE_URL 与客户端
 * 状态），不影响文件顶部那份 M。
 */
function loadServerModule(url) {
  process.env.WEBTERM_BRIDGE_URL = url;
  delete require.cache[require.resolve('../mcp-server.js')];
  return require('../mcp-server.js');
}

/**
 * 最小桥替身。真实桥的行为已由 test/bridge.test.js 覆盖，这里只需要三件事：
 * 握手校验、连接计数、把 req 回成 res。
 * 刻意不用真实 attachBridge：它的 close() 会连页面一起踢掉，且不暴露单个
 * socket，没法只断开适配器那一条；而这个测试要"从服务端断开再让它自行重连"。
 */
function startBridgeStub() {
  const sockets = new Set();
  const ids = [];
  const handshakes = [];
  let connections = 0;
  let rejectNext = 0;

  const server = http.createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });

  // 复刻 bridge.js 的适配器判定：有 Origin ⇒ 被当成页面；token 不对 ⇒ 拒绝。
  // 客户端哪天多带了 Origin 或漏带 token，这里会 403 失败而不是静默通过。
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const tokenOk = req.headers['x-webterm-token'] === TOKEN;
    handshakes.push({ origin, tokenOk });
    // 人为拒绝前 N 次握手：用来造"连接失败（socket 从未 open）"这条路径
    if (rejectNext > 0) {
      rejectNext--;
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (origin || !tokenOk) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      connections++;
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', ws => {
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.kind !== 'req') return;
      ids.push(msg.id);
      ws.send(JSON.stringify(P.makeRes(msg.id, { connected: true })));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `ws://127.0.0.1:${server.address().port}/bridge`,
      ids,
      handshakes,
      connectionCount: () => connections,
      /** 让接下来 n 次握手被 403 拒掉：造出"socket 从未 open"的连接失败 */
      rejectNextAttempts: n => { rejectNext = n; },
      /** 从服务端踢掉适配器连接，等价于 server.js 重启 / 页面刷新导致的桥断线 */
      dropClients: () => { for (const ws of sockets) ws.terminate(); },
      teardown: async () => {
        // 先停监听再踢 socket：否则客户端可能在两步之间重连成功，
        // 那条新连接会让 server.close() 的回调永远等不到（挂死）。
        const closed = new Promise(r => server.close(r));
        for (const ws of sockets) { try { ws.terminate(); } catch {} }
        sockets.clear();
        wss.close();
        await closed;
      },
    }));
  });
}

/** 有界轮询：等待本身不得无限悬着。计时器 unref，避免它是唯一把进程钉住的东西 */
function waitFor(pred, timeoutMs) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (pred() || Date.now() > deadline) { resolve(pred()); return; }
      setTimeout(tick, 25).unref();
    };
    tick();
  });
}

/** 让已排队的微任务全部跑完。断言在 reject 传播之前执行会假绿 */
const drainMicrotasks = () => new Promise(r => setImmediate(r));

/**
 * 可控的 fake WebSocket，用来把"CLOSING 中的 A 被 B 取代、A 的 close 随后才派发"
 * 这一时序变成确定的。
 *
 * 真实 ws 的这个窗口只有几微秒（readyState 置 2 之后 close 事件紧随其后），
 * 想稳定复现只能靠 sleep 撞运气——那正是不可接受的测试。换成 fake 之后，
 * open/close/message 全部由测试驱动，时序不再依赖运气。
 */
function makeFakeSocketClass() {
  const created = [];
  class FakeWebSocket {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      this.readyState = 0;        // CONNECTING
      this.sent = [];
      this.handlers = new Map();
      created.push(this);
    }
    on(ev, fn) {
      if (!this.handlers.has(ev)) this.handlers.set(ev, []);
      this.handlers.get(ev).push(fn);
      return this;
    }
    emit(ev, ...args) { for (const fn of this.handlers.get(ev) || []) fn(...args); }
    send(s) { this.sent.push(s); }
    terminate() { this.readyState = 3; }
    // —— 以下由测试驱动，不是 ws 的 API ——
    open() { this.readyState = 1; this.emit('open'); }
    deliver(obj) { this.emit('message', JSON.stringify(obj)); }
  }
  return { FakeWebSocket, created };
}

/**
 * 用 fake 顶替 'ws' 再取一份 mcp-server 实例。
 * 只在这一瞬替换 require.cache，拿到模块后立刻还原，不影响别的用例（它们仍用真 ws）。
 */
function loadServerModuleWithSocket(FakeWebSocket, url) {
  const wsPath = require.resolve('ws');
  const realWs = require.cache[wsPath];
  process.env.WEBTERM_BRIDGE_URL = url;
  require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: FakeWebSocket };
  delete require.cache[require.resolve('../mcp-server.js')];
  try {
    return require('../mcp-server.js');
  } finally {
    require.cache[wsPath] = realWs;
  }
}

test('两个客户端实例的请求 id 集合不相交（多会话不撞车）', async t => {
  const stub = await startBridgeStub();
  t.after(stub.teardown);

  const M2 = loadServerModule(stub.url);
  const a = M2.createBridgeClient();
  const b = M2.createBridgeClient();   // 同一进程里模拟"第二个 Claude Code 会话"

  const idsOf = async (client, n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push((await client.request('serial', 'status', {})).id);
    return out;
  };
  const idsA = await idsOf(a, 3);
  const idsB = await idsOf(b, 3);
  const all = [...idsA, ...idsB];

  // 每次 createBridgeClient() 各有独立的 state 与连接：一个适配器进程一条连接
  assert.strictEqual(stub.handshakes.length, 2, '两个实例各应握手一次');
  for (const h of stub.handshakes) {
    assert.strictEqual(h.origin, undefined,
      '适配器连接不得带 Origin——桥正是靠"无 Origin"把它与页面区分开的');
    assert.ok(h.tokenOk, '适配器必须带正确的 x-webterm-token');
  }

  // 桥的请求表是全桥共享的一张 map（不是每个适配器一张）：两个会话若都从 1 起
  // 编号必然撞车，而桥的冲突守卫是"响亮拒绝"，先到者的请求会被静默摧毁。
  assert.strictEqual(new Set(all).size, all.length, 'id 必须两两不同：' + all.join(', '));
  assert.deepStrictEqual(idsA.filter(id => idsB.includes(id)), [],
    '两个实例的 id 集合必须不相交');
  for (const id of all) assert.match(id, /^[0-9a-f]{8}-\d+$/, 'id 形如 <随机标签>-<序号>');
  assert.notStrictEqual(idsA[0].split('-')[0], idsB[0].split('-')[0],
    '两个实例的随机标签必须不同，否则两个会话仍会从同一序号起撞车');
  // 实例内靠自增而非随机：随机标签只负责跨实例唯一
  assert.deepStrictEqual(idsA.map(id => Number(id.split('-')[1])), [1, 2, 3]);
});

test('并发请求汇合到同一次连接尝试，不产生多余 socket', async t => {
  const stub = await startBridgeStub();
  t.after(stub.teardown);

  const M2 = loadServerModule(stub.url);
  const client = M2.createBridgeClient();

  // 数组字面量从左到右同步求值，两次 request() 在首个 socket 打开之前
  // 就先后进入 ensure()——正是"并发 tools/call"与"退避窗口内到达的请求"的形状。
  const [r1, r2] = await Promise.all([
    client.request('serial', 'status', {}),
    client.request('serial', 'status', {}),
  ]);

  assert.strictEqual(r1.ok, true, '第一个请求应成功');
  assert.strictEqual(r2.ok, true, '第二个请求应成功');
  // 没有这条守卫时，第二次调用看到 state.ws 还是 null（它要等 open 才赋值），
  // 于是各开一条 socket。输掉的那条永远不会被 state.ws 引用，可它的 close
  // 处理器会无条件清空 state.ws、reject 全部在途请求——一个孤儿 socket 关闭
  // 就能弄挂跑在健康 socket 上的请求。
  assert.strictEqual(stub.connectionCount(), 1,
    '并发请求必须汇合到同一次连接尝试，否则会开出孤儿 socket');
});

test('桥断开后客户端不抛异常，并自行退避重连成功', async t => {
  const stub = await startBridgeStub();
  t.after(stub.teardown);

  // 逸出的异常/拒绝接住并记账：让"进程被带崩"表现为一条断言失败，
  // 而不是整轮测试崩掉或挂住——变异验证要的是红，不是死。
  const escaped = [];
  const onUncaught = e => escaped.push('uncaughtException: ' + e.message);
  const onUnhandled = r => escaped.push('unhandledRejection: ' + (r && r.message));
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
  });

  const M2 = loadServerModule(stub.url);
  const client = M2.createBridgeClient();

  const first = await client.request('serial', 'status', {});
  assert.strictEqual(first.ok, true, '首次请求应经桥往返成功');

  const before = stub.connectionCount();
  stub.dropClients();

  // 等到客户端【自行】重连（首级退避 500ms）。它若没安排重连，这里会等到超时。
  const reconnected = await waitFor(() => stub.connectionCount() > before, 5000);

  // 顺序要紧：close 处理器同步抛出，而重连在 500ms 后才发生——
  // 能走到这里说明 close 处理器已经跑过，此时 escaped 的账是完整的。
  assert.deepStrictEqual(escaped, [],
    '断开不得让异常逸出 close 处理器：逸出即未捕获异常，整个 MCP 进程退出');
  assert.ok(reconnected, '断开后客户端应自行安排退避重连，无需外部再发请求');

  const again = await client.request('serial', 'status', {});
  assert.strictEqual(again.ok, true, '重连后请求应恢复');
});

// 这条守的是"连接失败后仍要重试"。测试者常写的朴素修法是
// `if (state.ws !== ws) return;`（用身份判断代替状态判断），那会漏掉这条路径：
// 首次连不上桥时 socket 从未 open，state.ws 恒为 null，于是清理与重连被整个跳过，
// 客户端永远不再重试——修一个罕见竞态时打断了最常见的故障恢复路径。
// 注意它与上一条的区别：上一条的 socket 曾经 open 过（state.ws === ws）。
test('连接失败（socket 从未 open）后仍会安排重试并连上', async t => {
  const stub = await startBridgeStub();
  t.after(stub.teardown);
  stub.rejectNextAttempts(1);   // 首次握手被 403 拒 ⇒ 该 socket 永远 open 不了

  const M2 = loadServerModule(stub.url);
  const client = M2.createBridgeClient();

  await assert.rejects(client.request('serial', 'status', {}), /403/,
    '首次请求应因握手被拒而失败');

  // 关键：这次失败必须真的排下重试（首级退避 500ms）
  const reconnected = await waitFor(() => stub.connectionCount() > 0, 5000);
  assert.ok(reconnected,
    '连接失败后必须仍安排重试，否则 state.ws 恒为 null 的客户端永远恢复不了');

  const res = await client.request('serial', 'status', {});
  assert.strictEqual(res.ok, true, '重试连上后请求应成功');
});

// 一个已被取代的 socket 关闭时，不得处置不属于它的状态。
// 触发时序（桥重启 + 并发调用就会出现）：A 进入 CLOSING → 请求另建 B → A 的 close 才派发。
// 无条件清理的版本会把 state.ws 清成 null 并 reject 掉跑在 B 上的在途请求；症状还会
// 自我复制：下一个请求再建 C，B 沦为真正的孤儿，它关闭时又去弄挂 C。
test('被取代的 socket 关闭时不得清空 state.ws，也不得弄挂别人的在途请求', async () => {
  const { FakeWebSocket, created } = makeFakeSocketClass();
  const M2 = loadServerModuleWithSocket(FakeWebSocket, 'ws://127.0.0.1:1/bridge');
  const client = M2.createBridgeClient();

  // 1) 首个请求建立 A，并让它成为当前连接
  const p1 = client.request('serial', 'status', {});
  assert.strictEqual(created.length, 1, '首个请求应建立一条连接');
  const A = created[0];
  A.open();
  await drainMicrotasks();
  A.deliver(P.makeRes(JSON.parse(A.sent[0]).id, { connected: true }));
  assert.strictEqual((await p1).ok, true, 'A 上的请求应正常完成');

  // 2) A 进入 CLOSING，但 close 尚未派发——这就是真实 ws 里几微秒的那个窗口
  A.readyState = 2;

  // 3) 此刻到来的请求只能另建 B（A 已不是可用连接）
  const p2 = client.request('serial', 'status', {});
  assert.strictEqual(created.length, 2, 'A 处于 CLOSING 时新请求应另建连接 B');
  const B = created[1];
  B.open();
  await drainMicrotasks();
  const reqB = JSON.parse(B.sent[0]);

  // 4) 现在才派发 A 的 close：A 已被 B 取代，无权处置 B 的在途请求。
  //    拒绝分支不外抛——否则那条 reject 会变成 unhandledRejection，把下面这条
  //    带诊断信息的断言盖掉，失败只剩一句"桥连接已断开"。
  let outcome = 'pending';
  const observed = p2.then(
    r => { outcome = 'ok'; return r; },
    e => { outcome = 'err: ' + e.message; return null; },
  );
  A.readyState = 3;
  A.emit('close');
  await drainMicrotasks();
  assert.strictEqual(outcome, 'pending',
    'A 的 close 不得 reject 跑在 B 上的在途请求——那正是"请求莫名失败"的来源');

  // 5) B 照常回帧，B 的在途请求应不受影响
  B.deliver(P.makeRes(reqB.id, { connected: true }));
  const r2 = await observed;
  assert.strictEqual(r2 && r2.ok, true, 'B 上的在途请求应不受 A 的 close 影响');

  // 6) state.ws 仍应指向 B：再发一个请求不该再建连接
  const p3 = client.request('serial', 'status', {});
  assert.strictEqual(created.length, 2,
    'state.ws 应仍指向 B——A 的 close 把它清成了 null，下一个请求就会另建连接');
  await drainMicrotasks();
  B.deliver(P.makeRes(JSON.parse(B.sent[B.sent.length - 1]).id, { connected: true }));
  assert.strictEqual((await p3).ok, true, 'B 仍应可用');
});

// ════════════════════════════════════════════════════════
// stdio 入口 main() 的守护
// ════════════════════════════════════════════════════════
// 上面全部用例都在进程内调用函数，够不到 main()。而两条全局约束——
// "畸形输入不得让进程退出"与"stdout 只许放协议消息"——此前只靠读代码保证：
// 一个误加的 console.log、或去掉 JSON.parse 的 catch，都会绿着上线，而 stdout
// 被污染会破坏整条 MCP 流且症状古怪。这里 spawn 真实的入口来钉住它们。

test('stdio 入口：畸形行不致命、stdout 只有协议消息、诊断走 stderr', async t => {
  const stub = await startBridgeStub();
  t.after(stub.teardown);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js')], {
    env: { ...process.env, WEBTERM_HOME: HOME, WEBTERM_BRIDGE_URL: stub.url },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });

  let out = '', err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  // 进程若已崩，后续写入 stdin 会 EPIPE；不接住会反过来把测试进程带崩
  child.stdin.on('error', () => {});

  let exitCode;
  const exited = new Promise(r => child.on('exit', c => { exitCode = c; r(c); }));

  const line = o => JSON.stringify(o) + '\n';
  child.stdin.write(
    '{这行不是合法 JSON，主循环必须跳过它\n' +                        // 畸形行
    '\n' +                                                            // 空行
    line({ jsonrpc: '2.0', method: 'notifications/initialized' }) +   // 通知：不得回帧
    line({ jsonrpc: '2.0', id: 1, method: 'ping' }) +
    line({ jsonrpc: '2.0', id: 2, method: 'tools/call',
           params: { name: 'webterm_status', arguments: {} } }),
  );

  // 注意先等响应到齐再 end()：stdin 结束时入口会 process.exit(0)，
  // 抢在 stdout 冲刷之前退出会丢掉响应（有界问题，但会让本用例假红）
  await waitFor(() => out.split('\n').filter(Boolean).length >= 2, 5000);

  assert.strictEqual(child.exitCode, null, '畸形行把进程带崩了——它必须被跳过而不是致命');

  const stdoutLines = out.split('\n').filter(Boolean);
  // "stdout 只许放协议消息"的直接检验：任何一行不能解析成 JSON 就是污染
  for (const l of stdoutLines) {
    assert.doesNotThrow(() => JSON.parse(l), `stdout 混入了非协议内容：${JSON.stringify(l)}`);
  }
  // 恰好两条响应：畸形行与空行被跳过、通知不回帧、ping 与 tools/call 各一条
  assert.deepStrictEqual(stdoutLines.map(l => JSON.parse(l).id), [1, 2],
    '响应集合不对：畸形行/空行应被跳过，通知不得产生响应');
  assert.match(JSON.parse(stdoutLines[1]).result.content[0].text, /connected/,
    'tools/call 应经桥往返并带回内容');

  assert.match(err, /\[mcp-server\] 就绪/, 'stderr 应有就绪日志');
  assert.ok(!out.includes('[mcp-server]'), '诊断信息不得出现在 stdout——那会污染 MCP 流');

  child.stdin.end();
  assert.strictEqual(await exited, 0, 'stdin 结束后进程应干净退出');
  assert.strictEqual(exitCode, 0);
});

// 临时 HOME 的清理。顺带收掉僵尸重连：token 文件没了之后，重连的 ensure()
// 会在 readToken() 处直接失败——没有新 socket，也就没有新的 close 事件，
// 那条重连链自己就断了。
after(() => fs.rmSync(HOME, { recursive: true, force: true }));
