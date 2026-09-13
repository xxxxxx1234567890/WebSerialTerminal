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

function connectPage({ origin, path = '/bridge', host } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      origin: origin === undefined ? `http://localhost:${port}` : origin,
      // 伪造 Host 以验证 DNS rebinding 防线：ws 把用户 headers 交给 http.request，
      // 显式 Host 会盖掉 Node 依据 URL 自动生成的那个
      ...(host === undefined ? {} : { headers: { Host: host } }),
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error('HTTP ' + res.statusCode)));
  });
}

function connectAdapter({ token = TOKEN, path = '/bridge', origin } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      origin,
      headers: token === null ? {} : { 'x-webterm-token': token },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error('HTTP ' + res.statusCode)));
  });
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
