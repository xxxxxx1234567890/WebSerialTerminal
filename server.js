const http = require('http');
const fs = require('fs');
const path = require('path');
const { writeToken } = require('./bridge-auth.js');
const { attachBridge } = require('./bridge.js');

// 仅监听回环地址。本进程具备"把内容写到任意目录"的能力，
// 绑定全部网卡等于把写盘接口暴露给局域网（Host/Origin 校验只挡浏览器）。
const HOST = '127.0.0.1';

// 注意别写成 `Number(env) || 1982`：PORT=0（系统分配空闲端口）会被 falsy 回退掉
const PORT_RAW = process.env.PORT;
const PORT = (PORT_RAW === undefined || PORT_RAW === '') ? 1982 : Number(PORT_RAW);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`端口配置无效: PORT=${JSON.stringify(PORT_RAW)}，应为 0-65535 的整数`);
  process.exit(1);
}

const ROOT = __dirname;

// 单次日志请求体积上限（防止误把超大缓冲区推到磁盘）
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// 自定义请求头：跨站 fetch 携带自定义头会触发 CORS 预检，
// 而本服务从不批准预检，其他网页因此无法调用写盘接口。
const AUTH_HEADER = 'x-webterm';

// Windows 保留设备名，做文件名时一律拒绝
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── 工具 ────────────────────────────────────────────────

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Host 必须指向本机，配合 Origin 校验阻断 DNS rebinding */
function isLocalHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/** 从 Host 头取出主机名。不能简单用 split(':')：IPv6 字面量 '[::1]:1982' 会切成 '[' */
function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  try { return new URL('http://' + hostHeader).hostname; } catch { return ''; }
}

/** Origin 必须是本服务自身的来源（端口需一致） */
function isTrustedOrigin(origin, actualPort) {
  if (!origin) return false;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!isLocalHostname(u.hostname)) return false;
  return Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === actualPort;
}

function validateFilename(name) {
  if (typeof name !== 'string') return '文件名必须是字符串';
  if (!name || name === '.' || name === '..') return '文件名非法';
  if (name.length > 255) return '文件名过长';
  if (/[\\/]/.test(name)) return '文件名不能包含路径分隔符';
  if (/[<>:"|?*\x00-\x1f]/.test(name)) return '文件名包含非法字符';
  if (/[. ]$/.test(name)) return '文件名不能以点或空格结尾';
  // 取第一个点之前的部分：Windows 把 'COM1.log.txt' 也解析为 COM1 设备
  if (WINDOWS_RESERVED.test(name.split('.')[0])) return '文件名是系统保留名';
  return null;
}

/** 读取请求体，超限则直接回 413 并停止累积；超限时 resolve(null) */
function readBody(req, res, limit) {
  return new Promise(resolve => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', c => {
      if (tooLarge) return;
      size += c.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        json(res, 413, { ok: false, error: `内容超过 ${limit} 字节上限` });
        req.resume(); // 排空剩余数据，确保 413 响应能送达
        return;
      }
      chunks.push(c);
    });
    // 超限时已响应 413；连接错误时客户端已断开，两种情况都无需再响应
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

// ── 写日志接口 ──────────────────────────────────────────

async function handleSaveLog(req, res, actualPort) {
  // 鉴权失败的响应也要排空请求体，否则 keep-alive 连接上的剩余字节会破坏后续请求
  const reject = (code, error) => {
    req.resume();
    json(res, code, { ok: false, error });
  };

  if (!isLocalHostname(hostnameOf(req.headers.host))) {
    return reject(403, '非法 Host');
  }
  if (!isTrustedOrigin(req.headers.origin, actualPort)) {
    return reject(403, '非法来源');
  }
  if (req.headers[AUTH_HEADER] !== '1') {
    return reject(403, '缺少授权头');
  }

  const raw = await readBody(req, res, MAX_BODY_BYTES);
  if (raw === null) return; // 已由 readBody 处理

  let payload;
  try { payload = JSON.parse(raw); } catch {
    return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
  }

  const { dir, filename, content } = payload || {};
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    return json(res, 400, { ok: false, error: '目录必须是绝对路径' });
  }
  const nameErr = validateFilename(filename);
  if (nameErr) return json(res, 400, { ok: false, error: nameErr });
  if (typeof content !== 'string') {
    return json(res, 400, { ok: false, error: 'content 必须是字符串' });
  }

  const baseDir = path.resolve(dir);
  const target = path.resolve(baseDir, filename);
  // 纵深防御：即便文件名校验被绕过，也不允许写出目标目录
  if (target !== path.join(baseDir, filename) || !target.startsWith(baseDir + path.sep)) {
    return json(res, 400, { ok: false, error: '路径越界' });
  }

  try {
    await fs.promises.mkdir(baseDir, { recursive: true });
    await fs.promises.writeFile(target, content, 'utf8');
    json(res, 200, { ok: true, path: target });
  } catch (err) {
    console.error('日志写入失败:', err.message);
    json(res, 500, { ok: false, error: '写入失败: ' + err.message });
  }
}

// ── 静态文件 ────────────────────────────────────────────

function serveStatic(req, res, pathname) {
  const filePath = pathname === '/' ? '/WebSerialTerminal.html' : pathname;

  // 路径遍历防护
  const fullPath = path.join(ROOT, filePath);
  if (!fullPath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end();
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404).end();
      return;
    }
    const headers = {
      'Content-Type': contentType,
      // 本地服务直读磁盘：禁用缓存，确保浏览器与 PWA 每次都拿到最新代码
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    };
    if (filePath === '/sw.js') {
      headers['Service-Worker-Allowed'] = '/';
    }
    res.writeHead(200, headers);
    res.end(content);
  });
}

// ── 服务器 ──────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // 畸形请求目标会让 new URL() 抛异常；未捕获的抛错会直接终止进程，
  // 因此这里必须兜住，并且整个异步处理链也要挂 catch。
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    res.writeHead(400).end();
    return;
  }

  const actualPort = server.address() ? server.address().port : PORT;

  if (pathname === '/api/save-log') {
    if (req.method !== 'POST') {
      req.resume();
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    handleSaveLog(req, res, actualPort).catch(err => {
      console.error('处理保存请求时出错:', err);
      if (!res.headersSent) json(res, 500, { ok: false, error: '服务器内部错误' });
    });
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`WebTerm Pro running at http://localhost:${server.address().port}`);

  // ── AI 桥 ─────────────────────────────────────────────
  // 桥与静态服务同生共死：页面能存在就说明本进程在跑，因此不需要额外的常驻进程。
  // 刻意放在 listen 回调里，而不是模块作用域：端口真的分配成功后才写 token（端口被
  // 占用时不留下一份永远用不上的 token），并且这条日志严格排在 "running at" 之后——
  // 测试 harness 靠那一行抓端口，新增日志不得插到它前面。
  const { token: bridgeToken, filePath: bridgeTokenPath } = writeToken();
  console.log(`[bridge] token 已写入 ${bridgeTokenPath}`);

  const bridge = attachBridge(server, {
    token: bridgeToken,
    // 判定函数由本模块注入，而不是从本模块导出：既不改动既有逻辑，也让桥能脱离
    // server.js 单测。upgrade 监听由 bridge.js 自己挂，这里不重复实现。
    isTrustedOrigin,
    isLocalHostname,
    hostnameOf,
    getActualPort: () => (server.address() ? server.address().port : PORT),
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { bridge.close(); process.exit(0); });
  }
}).on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请关闭占用进程后重试`);
    process.exit(1);
  }
  console.error('服务器启动失败:', err.message);
  process.exit(1);
});
