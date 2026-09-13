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
