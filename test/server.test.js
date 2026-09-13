// server.js 的 /api/save-log 冒烟测试（零依赖，用 node:test）
// 覆盖：正常写入、鉴权拒绝、路径逃逸拒绝、体积上限
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.join(__dirname, '..');
const TOKEN_HEADER = 'X-WebTerm';

let child;
let port;
let tmpRoot;
let tmpHome;

// ── 工具 ────────────────────────────────────────────────
function requestTo(targetPort, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined
      ? undefined
      : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port: targetPort, path: urlPath, method, headers: {
          ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        } },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// 默认打主服务器；另起的实例用 requestTo
function request(method, urlPath, opts) {
  return requestTo(port, method, urlPath, opts);
}

/** 有界请求：目标进程已死时应当快速失败，而不是让整个套件悬着（npm test 无超时） */
function requestWithin(targetPort, method, urlPath, opts, timeoutMs = 3000) {
  return Promise.race([
    requestTo(targetPort, method, urlPath, opts),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`向 :${targetPort} 的请求在 ${timeoutMs}ms 内没有返回`)), timeoutMs).unref()),
  ]);
}

// 默认带齐"合法同源请求"的头
function okHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Origin': `http://localhost:${port}`,
    [TOKEN_HEADER]: '1',
    ...extra,
  };
}

/** 打另起实例时用它：Origin 必须与该实例的端口一致，否则会被判成异源 */
function okHeadersFor(targetPort, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Origin': `http://localhost:${targetPort}`,
    [TOKEN_HEADER]: '1',
    ...extra,
  };
}

/** 发原始字节，用于构造畸形请求行 */
function rawRequest(raw) {
  return new Promise(resolve => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    sock.on('connect', () => sock.write(raw));
    sock.on('data', c => (data += c));
    sock.on('close', () => resolve(data));
    sock.on('error', e => resolve('ERR:' + e.code));
    // unref：正常路径里 close 会先到，这个兜底计时器还活着的话会白拖 2s 事件循环
    // （每轮一个用例，5 千多个用例就是白等）
    setTimeout(() => { sock.destroy(); resolve(data); }, 2000).unref();
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: APP_DIR,
      // WEBTERM_HOME 把 bridge token 定向到临时目录。不设它，writeToken() 会落进
      // 真实用户主目录（bridge-auth.js 的默认值是 os.homedir()）——测试污染真实环境。
      env: { ...process.env, PORT: '0', WEBTERM_HOME: tmpHome }, // 0 = 由系统分配空闲端口
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('服务器启动超时:\n' + out)), 10000);
    child.stdout.on('data', c => {
      out += c;
      const m = out.match(/localhost:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.stderr.on('data', c => (out += c));
    child.on('exit', code => { clearTimeout(timer); reject(new Error('服务器退出 code=' + code + '\n' + out)); });
  });
}

/**
 * 起一个独立的 server.js 实例（自带 env），用于"环境异常时桥降级"的用例。
 * 调用方负责 kill。失败路径在这里就把子进程处置掉——留在后台的子进程会吊住套件。
 *
 * cwd 保持 APP_DIR，脚本走绝对路径：require 是按**文件所在目录**解析的，
 * 与被 spawn 的脚本同目录等价；而把 cwd 也指过去会让 Windows 上随后的
 * rmSync 因"CWD 被占用"失败。
 */
async function startExtraServer({ scriptDir = APP_DIR, env }) {
  const entry = path.join(scriptDir, 'server.js');
  const child = spawn(process.execPath, [entry], { cwd: APP_DIR, env });
  let out = '';
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('额外实例启动超时:\n' + out)), 10000);
      timer.unref();
      child.stdout.on('data', c => {
        out += c;
        const m = out.match(/localhost:(\d+)/);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
      child.stderr.on('data', c => (out += c));
      child.on('exit', code => { clearTimeout(timer); reject(new Error('额外实例退出 code=' + code + '\n' + out)); });
    });
    return { child, port, output: () => out };
  } catch (err) {
    child.kill();
    throw err;
  }
}

/** 轮询子进程输出直到匹配，或超时。两个计时器都 unref，且都会清掉 */
function waitForOutput(srv, re, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let poll, deadline;
    poll = setInterval(() => {
      if (!re.test(srv.output())) return;
      clearInterval(poll);
      clearTimeout(deadline);
      resolve();
    }, 25);
    poll.unref();
    deadline = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`未等到 ${re}，实际输出:\n${srv.output()}`));
    }, timeoutMs);
    deadline.unref();
  });
}

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-test-'));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-home-'));
  port = await startServer();
});

after(() => {
  if (child) child.kill();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ── 用例 ────────────────────────────────────────────────

test('正常写入：文件内容字节级一致（含 BOM 与中文）', async () => {
  const dir = path.join(tmpRoot, 'logs');
  const content = '\uFEFF14:22:03 RX 温度:25.6℃ 状态正常\n';
  const res = await request('POST', '/api/save-log', {
    headers: okHeaders(),
    body: { dir, filename: 'serial_log_test.txt', content },
  });

  assert.strictEqual(res.status, 200, '应返回 200，实际 ' + res.status + ' ' + res.text);
  const written = fs.readFileSync(path.join(dir, 'serial_log_test.txt'));
  assert.deepStrictEqual([...written.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM 应落盘');
  assert.strictEqual(written.toString('utf8'), content);
});

test('目录不存在时自动创建', async () => {
  const dir = path.join(tmpRoot, 'deep', 'nested', 'logs');
  const res = await request('POST', '/api/save-log', {
    headers: okHeaders(),
    body: { dir, filename: 'a.txt', content: 'hi' },
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(fs.existsSync(path.join(dir, 'a.txt')));
});

test('缺少 X-WebTerm 自定义头 → 403', async () => {
  const dir = path.join(tmpRoot, 'logs');
  const headers = okHeaders();
  delete headers[TOKEN_HEADER];
  const res = await request('POST', '/api/save-log', {
    headers, body: { dir, filename: 'x.txt', content: 'x' },
  });
  assert.strictEqual(res.status, 403, '应拒绝，实际 ' + res.status);
  assert.ok(!fs.existsSync(path.join(dir, 'x.txt')), '不得写入文件');
});

test('异源 Origin → 403', async () => {
  const dir = path.join(tmpRoot, 'logs');
  const res = await request('POST', '/api/save-log', {
    headers: okHeaders({ Origin: 'https://evil.example.com' }),
    body: { dir, filename: 'evil.txt', content: 'x' },
  });
  assert.strictEqual(res.status, 403, '应拒绝，实际 ' + res.status);
  assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')), '不得写入文件');
});

test('filename 含 .. → 拒绝且不逃逸', async () => {
  const dir = path.join(tmpRoot, 'logs');
  const res = await request('POST', '/api/save-log', {
    headers: okHeaders(),
    body: { dir, filename: '../escaped.txt', content: 'x' },
  });
  assert.ok(res.status >= 400, '应拒绝，实际 ' + res.status);
  assert.ok(!fs.existsSync(path.join(tmpRoot, 'escaped.txt')), '不得逃逸到上级目录');
});

test('filename 含路径分隔符 → 拒绝', async () => {
  const dir = path.join(tmpRoot, 'logs');
  for (const bad of ['sub/x.txt', 'sub\\x.txt', '/abs.txt', 'C:\\abs.txt']) {
    const res = await request('POST', '/api/save-log', {
      headers: okHeaders(),
      body: { dir, filename: bad, content: 'x' },
    });
    assert.ok(res.status >= 400, `filename=${bad} 应被拒绝，实际 ` + res.status);
  }
});

test('filename 为保留名 / 空 → 拒绝', async () => {
  const dir = path.join(tmpRoot, 'logs');
  for (const bad of ['', '.', '..', 'CON', 'NUL']) {
    const res = await request('POST', '/api/save-log', {
      headers: okHeaders(),
      body: { dir, filename: bad, content: 'x' },
    });
    assert.ok(res.status >= 400, `filename=${JSON.stringify(bad)} 应被拒绝，实际 ` + res.status);
  }
});

test('dir 非绝对路径 → 拒绝', async () => {
  const res = await request('POST', '/api/save-log', {
    headers: okHeaders(),
    body: { dir: 'relative/logs', filename: 'a.txt', content: 'x' },
  });
  assert.ok(res.status >= 400, '应拒绝，实际 ' + res.status);
});

test('超过体积上限 → 413 且不写盘', async () => {
  const dir = path.join(tmpRoot, 'logs');
  const huge = 'A'.repeat(9 * 1024 * 1024); // 9MB > 8MB 上限
  const res = await request('POST', '/api/save-log', {
    headers: okHeaders(),
    body: { dir, filename: 'huge.txt', content: huge },
  });
  assert.strictEqual(res.status, 413, '应返回 413，实际 ' + res.status);
  assert.ok(!fs.existsSync(path.join(dir, 'huge.txt')));
});

test('非 POST 方法 → 404/405', async () => {
  const res = await request('GET', '/api/save-log', { headers: okHeaders() });
  assert.ok(res.status === 404 || res.status === 405, '实际 ' + res.status);
});

test('静态资源仍可正常访问（未破坏原有功能）', async () => {
  const res = await request('GET', '/');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'] || '', /text\/html/);
});

// ── 安全审查提出的加固项 ────────────────────────────────

test('畸形请求行返回 400 且进程不崩溃', async () => {
  const raw = await rawRequest('GET http://[::1 HTTP/1.1\r\nHost: localhost\r\n\r\n');
  assert.match(raw, /^HTTP\/1\.1 400/, '应返回 400，实际: ' + JSON.stringify(raw.slice(0, 60)));

  // 关键：进程必须还活着（此前会因未捕获的 URL 解析异常直接退出）
  const res = await request('GET', '/');
  assert.strictEqual(res.status, 200, '进程应仍然存活');
});

test('IPv6 字面量 Host 被接受（与 isLocalHostname 判定一致）', async () => {
  const dir = path.join(tmpRoot, 'logs');
  const res = await request('POST', '/api/save-log', {
    headers: { ...okHeaders(), Host: '[::1]:' + port },
    body: { dir, filename: 'v6.txt', content: 'x' },
  });
  assert.strictEqual(res.status, 200, '不应因 IPv6 Host 被拒，实际 ' + res.status + ' ' + res.text);
});

test('多扩展名的 Windows 保留名被拒绝', async () => {
  const dir = path.join(tmpRoot, 'logs');
  for (const bad of ['COM1.log.txt', 'NUL.foo.txt', 'LPT1.a.b']) {
    const res = await request('POST', '/api/save-log', {
      headers: okHeaders(),
      body: { dir, filename: bad, content: 'x' },
    });
    assert.ok(res.status >= 400, `filename=${bad} 应被拒绝，实际 ` + res.status);
  }
});

test('以点或空格结尾的文件名被拒绝（Windows 会静默剥掉）', async () => {
  const dir = path.join(tmpRoot, 'logs');
  for (const bad of ['x.txt.', 'x.txt ', 'x. ']) {
    const res = await request('POST', '/api/save-log', {
      headers: okHeaders(),
      body: { dir, filename: bad, content: 'x' },
    });
    assert.ok(res.status >= 400, `filename=${JSON.stringify(bad)} 应被拒绝，实际 ` + res.status);
  }
});

test('服务仅监听回环地址，不暴露给局域网', t => {
  // 不用"连外部网卡"来验证：Windows 防火墙会静默丢包，导致等超时而非 ECONNREFUSED。
  // 直接读监听表更确定。
  const { execSync } = require('node:child_process');
  let addrs;
  try {
    addrs = execSync('netstat -ano', { encoding: 'utf8' })
      .split('\n')
      .filter(l => /LISTENING/i.test(l) && new RegExp(':' + port + '\\s').test(l))
      .map(l => l.trim().split(/\s+/)[1]);
  } catch (e) {
    return t.skip('netstat 不可用，跳过');
  }
  assert.ok(addrs.length > 0, '应能查到监听项');
  for (const a of addrs) {
    assert.ok(/^127\.0\.0\.1:/.test(a) || /^\[::1\]:/.test(a),
      '监听地址应仅限回环，实际: ' + addrs.join(', '));
  }
});

test('客户端生成的文件名能通过服务端校验（端到端接缝）', async () => {
  // 这是此前最大的盲区：客户端生成文件名、服务端校验文件名，两边格式一旦脱节
  // （例如字符类误拒连字符），整条服务端降级路径会 100% 失效且无人发现。
  const html = fs.readFileSync(path.join(APP_DIR, 'WebSerialTerminal.html'), 'utf8');
  const m = html.match(/filename:\s*('serial_log_'[^\n]*?\.txt')/);
  assert.ok(m, '应能从 HTML 中提取到文件名生成表达式');

  // 用客户端同款表达式构造文件名
  const filename = new Function('return ' + m[1])();
  assert.match(filename, /^serial_log_[\dT\-]+\.txt$/, '生成的文件名: ' + filename);

  const dir = path.join(tmpRoot, 'logs');
  const res = await request('POST', '/api/save-log', {
    headers: okHeaders(),
    body: { dir, filename, content: 'x' },
  });
  assert.strictEqual(res.status, 200,
    '客户端文件名应被服务端接受，实际 ' + res.status + ' ' + res.text);
  assert.ok(fs.existsSync(path.join(dir, filename)), '文件应真的落盘');
});

test('非法 PORT 环境变量应给出明确错误而不是裸堆栈', async () => {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['server.js'], {
    // WEBTERM_HOME 同样必设：这条路径今天在端口校验处就退出了（早于写 token），
    // 但"任何启动 server.js 的地方都得设"这条规矩不能依赖执行顺序
    cwd: APP_DIR, env: { ...process.env, PORT: 'not-a-number', WEBTERM_HOME: tmpHome },
  });
  let out = '';
  child.stdout.on('data', c => (out += c));
  child.stderr.on('data', c => (out += c));
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.strictEqual(code, 1, '应以退出码 1 结束');
  assert.match(out, /端口配置无效/, '应打印明确提示，实际: ' + out);
  assert.doesNotMatch(out, /ERR_SOCKET_BAD_PORT/, '不应抛裸堆栈');
});

// ── AI 桥的挂载（server.js 只挂载，不重复实现桥的逻辑） ──────

test('启动时写入桥 token，供 mcp-server.js 读取', async () => {
  // 用 tmpHome 而不是 process.env.WEBTERM_HOME：后者只设在了子进程的 env 里，
  // 测试进程自身的 env 并没有这个变量
  const tokenFile = path.join(tmpHome, '.webterm', 'bridge-token');
  assert.ok(fs.existsSync(tokenFile), '应写入 ' + tokenFile);
  assert.match(fs.readFileSync(tokenFile, 'utf8'), /^[0-9a-f]{64}$/);
});

test('/bridge 拒绝非法 Origin 的升级请求', async () => {
  const WebSocket = require('ws');
  // 有界 + 失败即处置。若拒绝逻辑被破坏、连接被错误接受，被泄漏的客户端 socket
  // 会吊住测试进程的事件循环，而 npm test 不带 --test-timeout —— 那就是无限挂起。
  // 与 Task 4 那个 180s 挂死同类，只是发生在客户端侧。
  let leaked = null;
  try {
    await assert.rejects(
      () => new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: 'http://evil.example.com' });
        // 计时器必须 unref：否则每次『通过』的运行也要多等满 2 秒
        const timer = setTimeout(() => reject(new Error('升级既未成功也未在 2s 内被拒')), 2000);
        timer.unref();
        ws.on('open', () => { clearTimeout(timer); leaked = ws; resolve(ws); });
        ws.on('error', e => { clearTimeout(timer); reject(e); });
        ws.on('unexpected-response', (_r, res) => { clearTimeout(timer); reject(new Error('HTTP ' + res.statusCode)); });
      }),
      /HTTP 403/
    );
  } finally {
    if (leaked) leaked.terminate();   // 失败路径必须先处置再向上抛，否则进程挂住
  }
});

test('/bridge 接受合法 Origin 的升级请求，并按桥的协议应答', async () => {
  // 上面那条只证明"会被拒"。没有这条，一个根本没挂载桥的 server.js（升级直接断链、
  // 客户端报 socket hang up）也可能骗过拒绝断言——所以必须证明通路真的通到桥上。
  const WebSocket = require('ws');
  let ws = null;
  try {
    ws = await new Promise((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: `http://localhost:${port}` });
      const timer = setTimeout(() => reject(new Error('2s 内未完成升级')), 2000);
      timer.unref();
      sock.on('open', () => { clearTimeout(timer); resolve(sock); });
      sock.on('error', e => { clearTimeout(timer); reject(e); });
      sock.on('unexpected-response', (_r, res) => { clearTimeout(timer); reject(new Error('HTTP ' + res.statusCode)); });
    });

    // 页面未连上时发请求，桥应立刻回 PAGE_NOT_CONNECTED —— 这句应答只有真桥会发
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('2s 内未收到桥的应答')), 2000);
      timer.unref();
      ws.on('message', d => { clearTimeout(timer); resolve(JSON.parse(d.toString())); });
    });
    ws.send(JSON.stringify({ id: 't6-req-1', kind: 'req', domain: 'port', op: 'list', args: {} }));

    const msg = await answer;
    assert.strictEqual(msg.id, 't6-req-1');
    assert.strictEqual(msg.kind, 'res');
    assert.strictEqual(msg.ok, false, '页面未连接，不应成功');
    assert.strictEqual(msg.error && msg.error.code, 'PAGE_NOT_CONNECTED');
  } finally {
    if (ws) ws.terminate();
  }
});

test('/bridge 拒绝伪造 Host 的升级请求（DNS rebinding 防线仍接线正确）', async () => {
  // Origin 保持合法，于是唯一的拒绝来源只可能是注入的 isLocalHostname
  const WebSocket = require('ws');
  let leaked = null;
  try {
    await assert.rejects(
      () => new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
          origin: `http://localhost:${port}`,
          headers: { Host: 'evil.example.com' },
        });
        const timer = setTimeout(() => reject(new Error('升级既未成功也未在 2s 内被拒')), 2000);
        timer.unref();
        ws.on('open', () => { clearTimeout(timer); leaked = ws; resolve(ws); });
        ws.on('error', e => { clearTimeout(timer); reject(e); });
        ws.on('unexpected-response', (_r, res) => { clearTimeout(timer); reject(new Error('HTTP ' + res.statusCode)); });
      }),
      /HTTP 403/
    );
  } finally {
    if (leaked) leaked.terminate();
  }
});

test('token 文件里的 token 就是桥接受的那个（适配器接线端到端）', async () => {
  // server.js 把 writeToken() 的返回值接到桥的 token 上。这条线接错（比如传的是
  // undefined）时，页面分支（Origin）照样能连上，只有适配器连不上——上面那条接受
  // 测试走的正是页面分支，覆盖不到这里，所以必须单独守。
  const WebSocket = require('ws');
  const token = fs.readFileSync(path.join(tmpHome, '.webterm', 'bridge-token'), 'utf8').trim();
  assert.match(token, /^[0-9a-f]{64}$/, '前置：token 文件里应有内容');

  let ws = null;
  try {
    ws = await new Promise((resolve, reject) => {
      // 不带 Origin = 非浏览器 = 适配器分支，此时唯一的凭据就是文件里的 token
      const sock = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { headers: { 'x-webterm-token': token } });
      const timer = setTimeout(() => reject(new Error('2s 内未完成升级')), 2000);
      timer.unref();
      sock.on('open', () => { clearTimeout(timer); resolve(sock); });
      sock.on('error', e => { clearTimeout(timer); reject(e); });
      sock.on('unexpected-response', (_r, res) => { clearTimeout(timer); reject(new Error('HTTP ' + res.statusCode)); });
    });

    // 被当作已鉴权的适配器接纳：请求能进桥并被处理（页面未连上 → PAGE_NOT_CONNECTED）
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('2s 内未收到桥的应答')), 2000);
      timer.unref();
      ws.on('message', d => { clearTimeout(timer); resolve(JSON.parse(d.toString())); });
    });
    ws.send(JSON.stringify({ id: 't6-adapter-1', kind: 'req', domain: 'port', op: 'list', args: {} }));

    const msg = await answer;
    assert.strictEqual(msg.id, 't6-adapter-1');
    assert.strictEqual(msg.error && msg.error.code, 'PAGE_NOT_CONNECTED');
  } finally {
    if (ws) ws.terminate();
  }
});

// ── 桥降级：桥是附加能力，任何一环坏掉都不得让终端不可用（spec 5.6） ──

test('缺 node_modules 时 AI 桥降级且终端仍可用（全新安装不装依赖）', async t => {
  // 全新安装的形态：源码在、node_modules 不在。ws 是桥的运行时依赖且不入版本库，
  // 它若在加载期就抛，附加功能会把"零依赖即可运行"的终端整体搞死。
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-nodeps-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-home-'));
  let srv = null;
  t.after(() => {
    if (srv) srv.child.kill();
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  // 前提校验：本用例靠"ws 解析不到"成立。环境若在祖先目录提供了 ws，跳过而非假通过
  try {
    require.resolve('ws', { paths: [appDir] });
    t.skip('该环境能从 ' + appDir + ' 解析到 ws，无法模拟"未安装依赖"');
    return;
  } catch { /* 解析不到，正是要模拟的场景 */ }

  for (const f of ['server.js', 'bridge.js', 'bridge-protocol.js', 'bridge-auth.js']) {
    fs.copyFileSync(path.join(APP_DIR, f), path.join(appDir, f));
  }

  srv = await startExtraServer({
    scriptDir: appDir,
    env: { ...process.env, PORT: '0', WEBTERM_HOME: home },
  });

  await waitForOutput(srv, /AI 桥不可用/);
  assert.match(srv.output(), /npm install/, '降级必须响亮且给出可执行的补救：' + srv.output());

  // 终端本身照常干活：跑一次真实的写盘往返
  const res = await requestWithin(srv.port, 'POST', '/api/save-log', {
    headers: okHeadersFor(srv.port),
    body: { dir: path.join(home, 'logs'), filename: 'no-deps.txt', content: 'alive' },
  });
  assert.strictEqual(res.status, 200, '缺依赖不得影响终端写盘: ' + res.status + ' ' + res.text);
  assert.ok(fs.existsSync(path.join(home, 'logs', 'no-deps.txt')), '文件应真的落盘');

  // 桥没挂上就不该留下 token：一份用不上的凭证只会让 AI 侧误判"桥在跑"
  assert.ok(!fs.existsSync(path.join(home, '.webterm', 'bridge-token')), '降级时不应写 token');
});

test('attachBridge 装配失败时响亮降级，进程不被未捕获异常杀掉（端口已绑定的那一段）', async t => {
  // 触发窗口很窄但后果最重：ws 能 require 成功、API 却是坏的（半装/坏包），
  // 于是 attachBridge 里的 new WebSocketServer(...) 抛 TypeError。它发生在
  // server.listen 回调内——**端口已经绑定成功之后**——若不兜底，异常会成为未捕获
  // 异常直接杀掉进程：终端页面随即打不开，而用户看到的只是"服务没了"。
  // spec §5.6：桥的任何环节都不得让终端不可用。
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-badws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-home-'));
  let srv = null;
  t.after(() => {
    if (srv) srv.child.kill();
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  for (const f of ['server.js', 'bridge.js', 'bridge-protocol.js', 'bridge-auth.js']) {
    fs.copyFileSync(path.join(APP_DIR, f), path.join(appDir, f));
  }
  // 一个"能加载但没有 WebSocketServer"的 ws：正是半装后的形状
  const wsStub = path.join(appDir, 'node_modules', 'ws');
  fs.mkdirSync(wsStub, { recursive: true });
  fs.writeFileSync(path.join(wsStub, 'package.json'),
    JSON.stringify({ name: 'ws', version: '0.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(wsStub, 'index.js'), 'module.exports = {};\n');
  // 前提校验：必须解析到我们放的桩，否则这条用例什么也没模拟
  assert.strictEqual(require.resolve('ws', { paths: [appDir] }),
    path.join(wsStub, 'index.js'));

  srv = await startExtraServer({
    scriptDir: appDir,
    env: { ...process.env, PORT: '0', WEBTERM_HOME: home },
  });

  await waitForOutput(srv, /AI 桥不可用/);
  assert.match(srv.output(), /装配失败/, '降级必须点明是哪一环失败：' + srv.output());
  assert.match(srv.output(), /npm install/,
    '降级必须给出可执行的补救：' + srv.output());
  assert.strictEqual(srv.child.exitCode, null,
    '装配失败不得让进程退出——端口此时已绑定，等于把终端一起搞死');

  // 终端照常：跑一次真实的写盘往返（临时 appDir 里没有页面文件，故用与
  // "缺 node_modules"那条同样的探针——它证明 HTTP 链路整体仍然可用）
  const res = await requestWithin(srv.port, 'POST', '/api/save-log', {
    headers: okHeadersFor(srv.port),
    body: { dir: path.join(home, 'logs'), filename: 'bad-ws.txt', content: 'alive' },
  });
  assert.strictEqual(res.status, 200, '装配失败不得影响终端写盘: ' + res.status + ' ' + res.text);
  assert.ok(fs.existsSync(path.join(home, 'logs', 'bad-ws.txt')), '文件应真的落盘');
});

test('token 写不出来时 AI 桥降级且终端仍可用', async t => {
  // 拿一个普通文件占住 WEBTERM_HOME 的路径，bridge-auth.js 的 mkdirSync 必然 ENOTDIR。
  // 这一步在 listen 回调里，不兜底就是"端口已经绑好之后"以未处理异常退出。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-blocked-'));
  const blocker = path.join(base, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  let srv = null;
  t.after(() => {
    if (srv) srv.child.kill();
    fs.rmSync(base, { recursive: true, force: true });
  });

  srv = await startExtraServer({ env: { ...process.env, PORT: '0', WEBTERM_HOME: blocker } });

  await waitForOutput(srv, /AI 桥不可用/);
  assert.match(srv.output(), /token/, '应说清是 token 写不出来：' + srv.output());

  const res = await requestWithin(srv.port, 'POST', '/api/save-log', {
    headers: okHeadersFor(srv.port),
    body: { dir: path.join(base, 'logs'), filename: 'no-token.txt', content: 'alive' },
  });
  assert.strictEqual(res.status, 200, 'token 写不出来不得影响终端: ' + res.status + ' ' + res.text);
  assert.ok(fs.existsSync(path.join(base, 'logs', 'no-token.txt')), '文件应真的落盘');
});
