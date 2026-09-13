// test/mcp-e2e.test.js
// 真实的 bridge.js 与真实的 mcp-server.js 在一条**已提交**的用例里相遇。
//
// 此前每个接缝都被成对覆盖了：bridge.js ↔ 假客户端（bridge.test.js）、
// mcp-server.js ↔ 假桥（mcp-server-stdio.test.js）。但**组合层没有**——于是
// "bridge.js 把回帧的 kind 改名"或"res 上少带一个字段"这类改动会让两个套件都全绿，
// 而所有工具调用要到 30s 后以"桥未在 30s 内返回"浮现。那次 12 项端到端验证是
// %TEMP% 下的一次性脚本，未提交；这里把它变成可回归的一条。
//
// 三块脚手架都取自既有测试文件（server.test.js 起 server.js、mcp-server-stdio.test.js
// 驱动 stdio、bridge.test.js 用 ws 当假页面），本文件只负责把它们接起来。
// 无浏览器、无硬件。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const P = require('../bridge-protocol.js');

const APP_DIR = path.join(__dirname, '..');
// 临时 HOME：token 写在这里，不碰真实用户目录（与 mcp-server-stdio.test.js 同一手法）
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-e2e-'));

// ── 有界等待 ────────────────────────────────────────────
// 计时器一律 unref：npm test 是 node --test 且不带 --test-timeout，挂起即无界。
// 超时返回 false 交给调用方断言——红，而不是挂。
const sleep = ms => new Promise(r => { setTimeout(r, ms).unref(); });
async function waitFor(pred, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(20);
  }
  return pred();
}

// ── 三个进程/连接 ───────────────────────────────────────
let server;          // 真 server.js（内含真 bridge.js）
let mcp;             // 真 mcp-server.js（stdio）
let page;            // 假页面：一个 Node WebSocket 客户端，代替浏览器里的 bridge-client.js
let port;
let mcpOut = '';
let mcpErr = '';

function spawnChild(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: APP_DIR,
    env: { ...process.env, WEBTERM_HOME: HOME, ...env },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdin.on('error', () => {});   // 进程已退出时写入会 EPIPE，接住即可
  return child;
}

before(async () => {
  server = spawnChild(['server.js'], { PORT: '0' });
  let out = '';
  server.stdout.on('data', d => { out += d; });
  server.stderr.on('data', d => { out += d; });

  const started = await waitFor(() => /running at http:\/\/localhost:(\d+)/.test(out), 10000);
  assert.ok(started, 'server.js 未在 10s 内启动，实际输出：\n' + out);
  port = Number(/running at http:\/\/localhost:(\d+)/.exec(out)[1]);

  // 假页面：带合法 Origin 握手（桥用 isTrustedOrigin 判定页面身份），并报能力和版本
  page = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: `http://localhost:${port}` });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('假页面未能在 5s 内连上桥')), 5000);
    timer.unref();
    page.on('open', () => {
      clearTimeout(timer);
      page.send(JSON.stringify({ kind: 'hello', role: 'page', pageId: 'e2e-page',
        protocolVersion: P.PROTOCOL_VERSION, appVersion: '2.2',
        capabilities: ['serial', 'modbus', 'ui', 'dev'] }));
      resolve();
    });
    page.on('error', err => { clearTimeout(timer); reject(err); });
  });

  mcp = spawnChild(['mcp-server.js'], { WEBTERM_BRIDGE_URL: `ws://127.0.0.1:${port}/bridge` });
  mcp.stdout.on('data', d => { mcpOut += d; });
  mcp.stderr.on('data', d => { mcpErr += d; });
});

after(async () => {
  try { if (page) page.terminate(); } catch { /* 已断 */ }
  for (const c of [mcp, server]) { try { if (c) c.kill('SIGKILL'); } catch { /* 已退 */ } }
  await waitFor(() => (!mcp || mcp.exitCode !== null) && (!server || server.exitCode !== null), 3000);
  fs.rmSync(HOME, { recursive: true, force: true });
});

// ── 工具 ────────────────────────────────────────────────

/** 发一行 JSON-RPC 给适配器 */
const toMcp = obj => mcp.stdin.write(JSON.stringify(obj) + '\n');

/** 等页面收到桥转来的请求（必须先挂监听再发工具调用，否则会漏掉先到的帧） */
function nextPageReq(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const onMsg = raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.kind !== 'req') return;
      done();
      resolve(msg);
    };
    const timer = setTimeout(() => { done(); reject(new Error(`页面未在 ${timeoutMs}ms 内收到请求`)); }, timeoutMs);
    timer.unref();
    const done = () => { clearTimeout(timer); page.off('message', onMsg); };
    page.on('message', onMsg);
  });
}

/** 等适配器的 stdout 上出现某个 id 的 JSON-RPC 响应 */
async function mcpReplyFor(id, timeoutMs = 8000) {
  const ok = await waitFor(() => mcpOut.split('\n').filter(Boolean)
    .some(l => { try { return JSON.parse(l).id === id; } catch { return false; } }), timeoutMs);
  assert.ok(ok, `适配器未在 ${timeoutMs}ms 内回出 id=${id} 的响应。\n`
    + `stdout:\n${mcpOut}\nstderr:\n${mcpErr}`);
  return mcpOut.split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).find(m => m.id === id);
}

// ════════════════════════════════════════════════════════
// 组合层：工具调用 → 适配器 → 桥 → 页面 → 桥 → 适配器 → 工具结果
// ════════════════════════════════════════════════════════

test('真适配器 ↔ 真桥 ↔ 假页面：工具结果把页面的数据带回来了', async () => {
  const reqP = nextPageReq();
  toMcp({ jsonrpc: '2.0', id: 'e2e-1', method: 'tools/call',
    params: { name: 'webterm_status', arguments: {} } });

  const req = await reqP;
  // 请求信封是 mcp-server 与 bridge-client 之间唯一的契约面，逐项钉住：
  // kind / id / domain / op / args 少一个或改了名，页面侧就会静默丢弃或走错分支
  assert.strictEqual(req.kind, 'req');
  assert.strictEqual(typeof req.id, 'string', 'id 必须是字符串（协议层按字符串校验）');
  assert.strictEqual(req.domain, 'serial');
  assert.strictEqual(req.op, 'status');
  assert.deepStrictEqual(req.args, {});

  // 回帧同样按协议形状构造——这正是 mcp-server 的 client 收帧时要认的形状
  page.send(JSON.stringify(P.makeRes(req.id, { connected: true, marker: 'e2e-ok' })));

  const reply = await mcpReplyFor('e2e-1');
  assert.ok(reply.result, '应是成功的 JSON-RPC result：' + JSON.stringify(reply));
  assert.strictEqual(reply.result.isError, undefined, '不该被标成工具错误');
  const text = reply.result.content[0].text;
  assert.match(text, /"connected": true/, '页面的数据必须原样到模型手里：' + text);
  assert.match(text, /e2e-ok/, '自定义字段也要完整穿过两层转发：' + text);
});

test('真适配器 ↔ 真桥 ↔ 假页面：页面的错误码被翻译成人话（错误对象穿过两层不变形）', async () => {
  const reqP = nextPageReq();
  toMcp({ jsonrpc: '2.0', id: 'e2e-2', method: 'tools/call',
    params: { name: 'serial_read', arguments: { cursor: 0 } } });

  const req = await reqP;
  assert.strictEqual(req.domain, 'serial');
  assert.strictEqual(req.op, 'read');
  page.send(JSON.stringify(
    P.makeErr(req.id, P.ERROR_CODES.PORT_NOT_CONNECTED, '终端未连接串口')));

  const reply = await mcpReplyFor('e2e-2');
  const text = reply.result.content[0].text;
  assert.strictEqual(reply.result.isError, true, '错误码必须让工具结果标成 isError');
  assert.match(text, /✖ 串口未连接/, '错误码必须被翻译，而不是原样丢给模型：' + text);
  assert.match(text, /serial_connect/, '翻译里要带上下一步动作：' + text);
});
