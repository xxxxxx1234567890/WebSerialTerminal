// bridge.js
// WS 服务端：鉴权 + 路由 + 限流。不理解任何域语义——
// 工具定义与域语义在 mcp-server.js，执行在页面侧。
const { WebSocketServer } = require('ws');
const P = require('./bridge-protocol.js');
const { tokenEquals } = require('./bridge-auth.js');

const BRIDGE_PATH = '/bridge';
const TOKEN_HEADER = 'x-webterm-token';

/**
 * @param server 已有的 http.Server（复用其端口与 Host/Origin 判定）
 * @param deps { token, isTrustedOrigin, isLocalHostname, hostnameOf, getActualPort, log }
 *   判定函数由 server.js 注入，而非从 server.js 导出——不改动其现有逻辑，
 *   同时让本模块可脱离 server.js 单测。
 */
function attachBridge(server, deps) {
  const { token, isTrustedOrigin, isLocalHostname, hostnameOf, getActualPort } = deps;
  const log = deps.log || console;

  const wss = new WebSocketServer({ noServer: true });
  const state = { page: null, adapters: new Set(), pending: new Map() };

  /** 返回 { role } 或 { reject: {code, reason} } */
  function authorize(req) {
    const hostname = hostnameOf(req.headers.host);
    if (!isLocalHostname(hostname)) return { reject: { code: 403, reason: '非法 Host' } };

    const origin = req.headers.origin;
    if (origin) {
      // 浏览器一定发 Origin，所以这条分支就是"页面"路径
      if (!isTrustedOrigin(origin, getActualPort())) {
        return { reject: { code: 403, reason: '非法来源' } };
      }
      return { role: 'page' };
    }

    // 无 Origin ⇒ 非浏览器（浏览器无法省略 Origin，也无法自定义头）
    const presented = req.headers[TOKEN_HEADER];
    if (!tokenEquals(presented, token)) {
      return { reject: { code: 403, reason: 'token 无效' } };
    }
    return { role: 'adapter' };
  }

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== BRIDGE_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const verdict = authorize(req);
    if (verdict.reject) {
      log.warn(`[bridge] 拒绝连接：${verdict.reject.reason}`);
      socket.write(`HTTP/1.1 ${verdict.reject.code} Forbidden\r\n\r\n`);
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      ws.bridgeRole = verdict.role;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', ws => {
    if (ws.bridgeRole === 'adapter') {
      state.adapters.add(ws);
    }

    ws.on('message', raw => {
      // 帧上限：超大帧直接断开，避免打爆内存
      if (raw.length > P.MAX_FRAME_BYTES) {
        log.warn('[bridge] 帧超限，断开连接');
        ws.close(1009, 'frame too large');
        return;
      }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      handleMessage(ws, msg);
    });

    ws.on('close', () => {
      state.adapters.delete(ws);
      if (state.page && state.page.ws === ws) state.page = null;
    });

    ws.on('error', err => log.warn('[bridge] socket 错误：' + err.message));
  });

  function handleMessage(ws, msg) {
    if (msg && msg.kind === 'hello') {
      if (msg.protocolVersion !== P.PROTOCOL_VERSION) {
        ws.send(JSON.stringify({
          kind: 'error',
          message: `协议版本不匹配：页面 ${msg.protocolVersion}，桥 ${P.PROTOCOL_VERSION}。请刷新页面。`,
        }));
        ws.close();
        return;
      }
      // 一期单页面：后连接者取代先连接者
      state.page = {
        ws,
        pageId: String(msg.pageId || 'unknown'),
        capabilities: Array.isArray(msg.capabilities) ? msg.capabilities : [],
      };
      log.info(`[bridge] 页面已连接 pageId=${state.page.pageId}`);
      return;
    }
    // 路由与超时在 Task 5 加入
  }

  return {
    close() {
      for (const ws of state.adapters) { try { ws.close(); } catch {} }
      if (state.page) { try { state.page.ws.close(); } catch {} }
      wss.close();
    },
    getStats() {
      return {
        page: state.page ? { pageId: state.page.pageId, capabilities: state.page.capabilities } : null,
        adapters: state.adapters.size,
        pending: state.pending.size,
      };
    },
  };
}

module.exports = { attachBridge, BRIDGE_PATH, TOKEN_HEADER };
