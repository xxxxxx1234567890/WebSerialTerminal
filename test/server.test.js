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

// ── 工具 ────────────────────────────────────────────────
function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined
      ? undefined
      : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers: {
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

// 默认带齐"合法同源请求"的头
function okHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Origin': `http://localhost:${port}`,
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
    setTimeout(() => { sock.destroy(); resolve(data); }, 2000);
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: APP_DIR,
      env: { ...process.env, PORT: '0' }, // 0 = 由系统分配空闲端口
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

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-test-'));
  port = await startServer();
});

after(() => {
  if (child) child.kill();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
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
    cwd: APP_DIR, env: { ...process.env, PORT: 'not-a-number' },
  });
  let out = '';
  child.stdout.on('data', c => (out += c));
  child.stderr.on('data', c => (out += c));
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.strictEqual(code, 1, '应以退出码 1 结束');
  assert.match(out, /端口配置无效/, '应打印明确提示，实际: ' + out);
  assert.doesNotMatch(out, /ERR_SOCKET_BAD_PORT/, '不应抛裸堆栈');
});
