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

  // maxPayload 与下面的应用层检查取同一个界，但它在 ws 解析期就强制：
  // raw.length 只有等整帧缓冲完才可观测，光靠应用层检查挡不住内存被打爆
  const wss = new WebSocketServer({ noServer: true, maxPayload: P.MAX_FRAME_BYTES });
  const state = { page: null, adapters: new Set(), pending: new Map(), sockets: new Set() };

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
    // 所有被接受的连接都记在这里，而不只是记进角色槽：
    // 没送过 hello 的 page socket、以及被后连接者覆写掉的那个，都不在任何角色槽里
    state.sockets.add(ws);
    if (ws.bridgeRole === 'adapter') {
      state.adapters.add(ws);
    }

    ws.on('message', raw => {
      // 第二道防线：maxPayload 已在解析期把超限帧挡下并以 1009 关闭，
      // 这里再兜一次，免得日后有人调大 maxPayload 却忘了应用层的界
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
      state.sockets.delete(ws);
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
      // 遍历全部已接受连接，而不是逐个角色去找——角色的槽位会漏掉那些没进槽的 socket。
      // 用 terminate 而非 close：这里是关停路径，目的是让 server.close() 一定等得到回调，
      // 而优雅关闭会等对端回 close 帧，对端不回就正好卡成我们要修的那个挂死。
      for (const ws of state.sockets) { try { ws.terminate(); } catch {} }
      state.sockets.clear();
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
