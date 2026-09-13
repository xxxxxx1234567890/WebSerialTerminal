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

/**
 * 连接的上界：对端若既不接受也不拒绝（例如 upgrade 处理器没挂上、或服务端卡住），
 * 原来的实现会让整个套件**无限悬着**——npm test 不带 --test-timeout，挂起即无界。
 * 这里把它变成一条可读的断言失败，并且**先处置掉 socket 再失败**：
 * 泄漏的 socket 会让随后的 server.close() 永远等不到回调，失败又会退化成挂死。
 */
function withConnectBound(ws, what, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* 已断 */ }
      reject(new Error(`${what} 在 ${timeoutMs}ms 内既未成功也未失败（连接无界挂起）`));
    }, timeoutMs);
    timer.unref();
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', err => { clearTimeout(timer); reject(err); });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(new Error('HTTP ' + res.statusCode));
    });
  });
}

function connectPage({ origin, path = '/bridge', host } = {}) {
  return withConnectBound(new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    origin: origin === undefined ? `http://localhost:${port}` : origin,
    // 伪造 Host 以验证 DNS rebinding 防线：ws 把用户 headers 交给 http.request，
    // 显式 Host 会盖掉 Node 依据 URL 自动生成的那个
    ...(host === undefined ? {} : { headers: { Host: host } }),
  }), '页面连接');
}

function connectAdapter({ token = TOKEN, path = '/bridge', origin } = {}) {
  return withConnectBound(new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    origin,
    headers: token === null ? {} : { 'x-webterm-token': token },
  }), '适配器连接');
}

/**
 * 断言升级请求被拒。若本不该建立的连接被接受，先 terminate 再断言失败——
 * 否则泄漏的 socket 让 server.close() 永远等不到回调，失败会表现为整个套件挂住，
 * 而不是一条可读的断言失败。
 */
async function assertUpgradeRejected(connect) {
  let ws;
  try {
    ws = await connect();
  } catch (err) {
    assert.match(err.message, /HTTP \d+/);
    return;
  }
  ws.terminate();
  assert.fail('本应被拒绝的升级请求被接受了');
}

// 有界等待：对端若不回帧，必须干净地失败，不能让整个套件无限悬着
// （package.json 的 npm test 不带 --test-timeout，悬着就是无限挂起）
const nextMessage = (ws, timeoutMs = 2000) => Promise.race([
  new Promise(resolve => ws.once('message', d => resolve(JSON.parse(d.toString())))),
  new Promise((_, reject) => setTimeout(
    () => reject(new Error(`等待消息超时：对端未在 ${timeoutMs}ms 内回帧`)), timeoutMs).unref()),
]);
const send = (ws, obj) => ws.send(JSON.stringify(obj));

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
  return withConnectBound(new WebSocket(`ws://127.0.0.1:${inst.port}/bridge`, {
    origin: `http://localhost:${inst.port}`,
  }), '页面连接（独立实例）').then(ws => {
    if (hello) ws.send(JSON.stringify(hello));
    return ws;
  });
}

function connectAdapterTo(inst) {
  return withConnectBound(new WebSocket(`ws://127.0.0.1:${inst.port}/bridge`, {
    headers: { 'x-webterm-token': TOKEN },
  }), '适配器连接（独立实例）');
}

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
  await assertUpgradeRejected(() => connectPage({ origin: 'http://evil.example.com' }));
});

test('页面连接：缺失 Origin 被拒', async () => {
  await assertUpgradeRejected(() => connectPage({ origin: null }));
});

test('适配器连接：token 正确则接受', async () => {
  const ws = await connectAdapter();
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(bridge.getStats().adapters, 1);
  ws.close();
});

test('适配器连接：token 错误被拒', async () => {
  await assertUpgradeRejected(() => connectAdapter({ token: 'deadbeef' }));
});

test('适配器连接：无 token 被拒', async () => {
  await assertUpgradeRejected(() => connectAdapter({ token: null }));
});

test('路径不是 /bridge 的升级请求被拒', async () => {
  await assertUpgradeRejected(() => connectPage({ path: '/nope' }));
});

test('协议版本不匹配时响亮拒绝', async () => {
  const ws = await connectPage();
  let msg;
  try {
    send(ws, { kind: 'hello', role: 'page', pageId: 'p-bad', protocolVersion: 999,
               appVersion: 'x', capabilities: [] });
    msg = await nextMessage(ws);
  } finally {
    // 无论走哪条路都收尾：失败时若把 socket 留给 server.close() 去等，就是无限挂起
    ws.terminate();
  }
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

test('Host 检查：伪造 Host 被拒，合法 Host 放行（DNS rebinding 防线）', async () => {
  // 此处 Origin 保持合法，于是唯一的拒绝来源只可能是 Host 检查
  await assertUpgradeRejected(() => connectPage({ host: 'evil.example.com' }));
  // 对照组：同一辅助函数在合法 Host 下能连上，证明上一条的拒绝确由 Host 触发，
  // 而不是被别的因素掩盖
  const ws = await connectPage();
  ws.close();
});

test('帧上限：超过 MAX_FRAME_BYTES 的帧导致连接被关闭（1009）', async () => {
  const ws = await connectAdapter();
  const closed = new Promise(resolve => ws.on('close', code => resolve(code)));
  send(ws, {
    kind: 'hello', role: 'page', pageId: 'big',
    protocolVersion: P.PROTOCOL_VERSION, capabilities: [],
    pad: 'a'.repeat(P.MAX_FRAME_BYTES + 1024),
  });
  // 有界等待：若帧被静默接受，这里给出一条清晰的断言失败，而不是把整个文件拖到测试超时。
  // unref：输了之后这个定时器不该继续占着事件循环，否则整个套件白等 2 秒才退出
  const code = await Promise.race([
    closed,
    new Promise(r => setTimeout(() => r('未关闭'), 2000).unref()),
  ]);
  assert.strictEqual(code, 1009, '超限帧必须断开连接（1009），不能被接受或静默截断');
});

test('两条鉴权路径不可互相绕过：正确 token + 非法 Origin 仍被拒', async () => {
  // 带 Origin 即走页面分支，token 在该分支不参与判定——
  // 因此"持有正确 token"不能成为绕过 Origin 校验的通行证
  await assertUpgradeRejected(() => connectAdapter({ origin: 'http://evil.example.com' }));
});

test('关停：未送 hello 的 page socket 不得让 server.close() 挂住', async () => {
  // 自起一套 server + bridge：本用例会把 server 关掉，若借用共享 fixture 就得依赖
  // 测试声明顺序，还会连累 after 钩子
  const srv = http.createServer((_req, res) => res.writeHead(404).end());
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const p = srv.address().port;
  const own = attachBridge(srv, {
    token: TOKEN, isTrustedOrigin, isLocalHostname, hostnameOf,
    getActualPort: () => srv.address().port,
    log: { info() {}, warn() {}, error() {} },
  });

  // 泄漏形态：page 角色却从未送 hello——既不在 state.adapters 里，state.page 也仍是 null，
  // 按角色遍历的旧 close() 两边都够不着，于是这个 socket 永远挂着
  const ws = new WebSocket(`ws://127.0.0.1:${p}/bridge`, { origin: `http://localhost:${p}` });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

  try {
    own.close();
    // unref：赢了之后计时器不该继续占着事件循环。
    // 旧实现下 server.close() 真的永不回调，所以这里必须以干净的断言失败收场，不能挂住
    const outcome = await Promise.race([
      new Promise(r => srv.close(() => r('已关闭'))),
      new Promise(r => setTimeout(() => r('超时：server.close() 未回调'), 2000).unref()),
    ]);
    assert.strictEqual(outcome, '已关闭',
      'close() 必须关掉未送 hello 的 page socket，否则 server.close() 永不回调');
  } finally {
    // 失败路径上这条连接还活着：不收尾，整个测试进程就退不出去
    try { ws.terminate(); } catch {}
  }
});

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

test('页面不响应时超时返回 BRIDGE_TIMEOUT 并清理请求表', async (t) => {
  // attachBridgeOnNewServer 是 async —— 漏 await 会让 slow 变成 Promise、slow.port 变 undefined，
  // 报错表现为 "Invalid URL: ws://127.0.0.1:undefined/bridge"
  const slow = await attachBridgeOnNewServer({ timeoutMs: 80 });
  // teardown 必须注册到 t.after，不能写在测试体末尾：
  // 测试超时或中途失败时末尾语句永不执行，server 句柄不释放，进程永不退出——
  // 而 npm test 不带 --test-timeout，那就是无限挂起
  t.after(async () => { await slow.teardown(); });

  const page = await connectPageTo(slow, { kind: 'hello', role: 'page', pageId: 'p-slow', protocolVersion: 1, capabilities: ['serial'] });
  const adapter = await connectAdapterTo(slow);

  send(adapter, P.makeReq('r-300', 'serial', 'read', {}));
  const res = await nextMessage(adapter);
  assert.strictEqual(res.error.code, 'BRIDGE_TIMEOUT');
  assert.strictEqual(slow.bridge.getStats().pending, 0, '超时后必须清理，否则反复超时会吃内存');

  page.close(); adapter.close();
});

test('速率限制：超过窗口配额时拒绝而非静默排队', async (t) => {
  const limited = await attachBridgeOnNewServer({ rateLimit: { max: 2, windowMs: 10000 } });
  t.after(async () => { await limited.teardown(); });

  const page = await connectPageTo(limited, { kind: 'hello', role: 'page', pageId: 'p-rate', protocolVersion: 1, capabilities: ['serial'] });
  const adapter = await connectAdapterTo(limited);
  // 页面必须给被接受的请求回帧。少了它，前两个请求会被正常转发却永不应答，
  // 适配器只会收到第 3 个请求的限流拒绝，下面的 3 次读会在不存在的第 2、3 条上
  // 各白等 2 秒后超时，断言根本走不到（实测证据见 task-5-report.md）。
  // 反过来，前两条读到 ok、第三条读到 INVALID_ARGS，也就正向证明了
  // "被接受的两个确实被转发执行，只有超配额的那个被拒"，比只数错误码更强。
  page.on('message', d => {
    const m = JSON.parse(d.toString());
    if (m.kind === 'req') send(page, P.makeRes(m.id, {}));
  });

  const results = [];
  // 逐个发、逐个读：一次只让一帧在路上。若三条一起发，页面会批处理两个请求、
  // 两条回帧落在同一个事件循环 tick 里，而"读一条→重建 once 监听"之间
  // 后到的那帧会被静默丢弃，测试就成了看运气。
  for (let i = 0; i < 3; i++) {
    send(adapter, P.makeReq(`r-40${i}`, 'serial', 'status', {}));
    results.push(await nextMessage(adapter));
  }
  // 限流复用 INVALID_ARGS 而非新增 RATE_LIMITED：spec 第 4.5 节的错误码是固定的
  // 9 项清单，T1 的测试逐项断言了该清单，新增码会破坏它。
  // 面向模型的可读提示由 message 承担（"请求过于频繁（上限 N 次 / M ms）"）。
  const codes = results.filter(r => !r.ok).map(r => r.error.code);
  assert.deepStrictEqual(codes, ['INVALID_ARGS'],
    '第 3 个请求应被限流拒绝（码复用 INVALID_ARGS，理由见上）');

  page.close(); adapter.close();
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

test('速率限制是固定窗口而非永久计数器：窗口过后配额恢复', async (t) => {
  // 简报的限流用例窗口是 10s，窗口在用例期间根本不会滚过——
  // 于是"永久计数器"也能让它通过（实测：删掉 allowRequest 里的窗口重置后，
  // 只靠简报那条限流用例仍全绿）。拿一个短窗口把重置真的走一遍，
  // 否则"这是窗口不是计数器"只是注释里的一句声明。
  const inst = await attachBridgeOnNewServer({ rateLimit: { max: 2, windowMs: 400 } });
  t.after(async () => { await inst.teardown(); });

  const page = await connectPageTo(inst, { kind: 'hello', role: 'page', pageId: 'p-window', protocolVersion: 1, capabilities: ['serial'] });
  page.on('message', d => {
    const m = JSON.parse(d.toString());
    if (m.kind === 'req') send(page, P.makeRes(m.id, {}));
  });
  const adapter = await connectAdapterTo(inst);

  // 逐个发、逐个读：一次只让一帧在路上（理由同限流用例）
  send(adapter, P.makeReq('r-700', 'serial', 'status', {}));
  assert.strictEqual((await nextMessage(adapter)).ok, true, '窗口内第 1 个应放行');
  send(adapter, P.makeReq('r-701', 'serial', 'status', {}));
  assert.strictEqual((await nextMessage(adapter)).ok, true, '窗口内第 2 个应放行');
  send(adapter, P.makeReq('r-702', 'serial', 'status', {}));
  const denied = await nextMessage(adapter);
  assert.strictEqual(denied.ok, false, '窗口配额用尽后应拒绝');
  assert.strictEqual(denied.error.code, 'INVALID_ARGS');

  // 睡过一个窗口（400ms）再发：计数器若是永久的，这里会一直被拒
  await new Promise(r => setTimeout(r, 600));
  send(adapter, P.makeReq('r-703', 'serial', 'status', {}));
  assert.strictEqual((await nextMessage(adapter)).ok, true,
    '窗口应重置、配额恢复；永久计数器会在这里永远拒绝');

  page.close(); adapter.close();
});

test('请求 id 冲突：第二个同 id 请求被拒，第一个请求不受影响', async (t) => {
  // state.pending 是全桥共享的命名空间，而适配器的 id 是 `r-${++seq}`、每个会话各自
  // 从 1 起编号——多个 Claude Code 会话连同一个桥时（spec 选方案 A 的理由之一）必然撞号。
  // 无条件 set 会让先到者的计时器变孤儿、超时错发给后到者、应答也路由给后到者。
  // 本用例断言"静默摧毁"的反面：第二个被响亮拒绝，第一个完好无损。
  // timeoutMs 拉到 60s：整条用例期间第一个请求都不会因超时离开请求表。
  const inst = await attachBridgeOnNewServer({ timeoutMs: 60000 });
  t.after(async () => { await inst.teardown(); });

  const page = await connectPageTo(inst, { kind: 'hello', role: 'page', pageId: 'p-dup', protocolVersion: 1, capabilities: ['serial'] });
  const a1 = await connectAdapterTo(inst);
  const a2 = await connectAdapterTo(inst);

  send(a1, P.makeReq('r-1', 'serial', 'read', {}));
  assert.strictEqual((await nextMessage(page)).id, 'r-1', '第一个请求应被转发到页面');

  send(a2, P.makeReq('r-1', 'serial', 'read', {}));
  const denied = await nextMessage(a2);
  assert.strictEqual(denied.id, 'r-1');
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.error.code, 'INVALID_ARGS');
  // 上限和冲突共用 INVALID_ARGS（spec 的错误码是固定 9 项清单），靠 message 区分
  assert.match(denied.error.message, /id 冲突/, '必须是因为 id 冲突，而不是撞上请求表上限');

  // 关键：a1 的请求仍然完好。页面的应答必须回到 a1，而不是被顶替后的 a2
  send(page, P.makeRes('r-1', { data: 'OK' }));
  assert.deepStrictEqual(await nextMessage(a1), P.makeRes('r-1', { data: 'OK' }),
    '第一个请求者的应答不能被后来者顶掉');
  assert.strictEqual(inst.bridge.getStats().pending, 0, '应答后请求表应清空');

  page.close(); a1.close(); a2.close();
});

test('请求表达到上限后拒绝新请求，不静默排队', async (t) => {
  // bridge.js 里的 MAX_PENDING_REQUESTS 检查此前零守护：删掉那几行，其余用例仍全绿。
  // 长超时保证整条用例期间已入表的请求不会因超时被清出去。
  const inst = await attachBridgeOnNewServer({
    timeoutMs: 60000,
    // 必须放宽限流：默认 60 次/1000ms 会让第 61 个请求先被限流拒掉，够不到请求表上限
    rateLimit: { max: 10000, windowMs: 1000 },
  });
  t.after(async () => { await inst.teardown(); });

  const page = await connectPageTo(inst, { kind: 'hello', role: 'page', pageId: 'p-full', protocolVersion: 1, capabilities: ['serial'] });
  const adapter = await connectAdapterTo(inst);

  // 页面刻意不应答，于是每条请求都留在表里
  for (let i = 0; i < P.MAX_PENDING_REQUESTS; i++) {
    send(adapter, P.makeReq(`r-${i}`, 'serial', 'read', {}));
  }
  // 桥对单个 socket 按序处理，且前 64 条都不回帧，所以适配器收到的第一帧必然是
  // 这一条的回复——据此可断定前 64 条已全部入表，不必用 sleep 去猜时序
  send(adapter, P.makeReq('r-over', 'serial', 'read', {}));
  const denied = await nextMessage(adapter);
  assert.strictEqual(denied.id, 'r-over');
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.error.code, 'INVALID_ARGS');
  assert.match(denied.error.message, /请求未完成/, '必须是因为请求表已满，而不是 id 冲突');
  assert.strictEqual(inst.bridge.getStats().pending, P.MAX_PENDING_REQUESTS,
    '被拒的请求不得入表，表应仍停在上限');

  page.close(); adapter.close();
});

test('close() 撤掉挂起请求的定时器，不留计时器比桥活得久', async (t) => {
  // 简报的 5 个用例都碰不到这条路径：超时用例里请求表已自己清空，
  // 断开用例里是页面 close 触发的清理。页面仍连着时调用 close()，是唯一能
  // 把 close() 自身的清理单独隔离出来的场景。
  // 漏撤的后果不是断言失败而是进程被拖住——默认 10s 的超时会白等完才退，
  // 正是"反挂死"要防的那类缺陷，所以必须显式断言，不能靠"跑得挺快"去推断。
  // 用 timeoutMs 拉长到 60s：定时器若被撤掉就不该在资源表里；若没撤掉，
  // 这条断言失败而不是让整条命令等满 60s。
  const inst = await attachBridgeOnNewServer({ timeoutMs: 60000 });
  t.after(async () => { await inst.teardown(); });
  // 未 unref 的 Timeout 才会出现在这张表里（unref 过的不会拖住事件循环），
  // 正好用来断言"桥的定时器有没有被撤掉"
  const activeTimers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;

  const page = await connectPageTo(inst, { kind: 'hello', role: 'page', pageId: 'p-close', protocolVersion: 1, capabilities: ['serial'] });
  const adapter = await connectAdapterTo(inst);

  const before = activeTimers();
  send(adapter, P.makeReq('r-600', 'serial', 'read', {}));
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(inst.bridge.getStats().pending, 1);
  assert.strictEqual(activeTimers(), before + 1, '每个挂起请求应带一个超时定时器');

  inst.bridge.close();
  assert.strictEqual(inst.bridge.getStats().pending, 0, 'close() 后请求表应清空');
  assert.strictEqual(activeTimers(), before, 'close() 必须撤掉挂起请求的定时器，否则计时器比桥活得久');

  page.terminate(); adapter.terminate();
});
