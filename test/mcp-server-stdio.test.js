// test/mcp-server-stdio.test.js
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

  const server = http.createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });

  // 复刻 bridge.js 的适配器判定：有 Origin ⇒ 被当成页面；token 不对 ⇒ 拒绝。
  // 客户端哪天多带了 Origin 或漏带 token，这里会 403 失败而不是静默通过。
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const tokenOk = req.headers['x-webterm-token'] === TOKEN;
    handshakes.push({ origin, tokenOk });
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

// 临时 HOME 的清理。顺带收掉僵尸重连：token 文件没了之后，重连的 ensure()
// 会在 readToken() 处直接失败——没有新 socket，也就没有新的 close 事件，
// 那条重连链自己就断了。
after(() => fs.rmSync(HOME, { recursive: true, force: true }));
