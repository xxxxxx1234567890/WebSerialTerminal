// bridge-protocol.js
// Node 与浏览器共用的协议常量与编解码。
// UMD：Node 走 module.exports，浏览器挂 globalThis.BridgeProtocol。
// 必须共用同一份——错误码由 bridge-client.js 产生、mcp-server.js 翻译，各写一份必然漂移。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BridgeProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PROTOCOL_VERSION = 1;
  const MAX_FRAME_BYTES = 256 * 1024;
  const READ_MAX_LINES = 1000;
  const READ_DEFAULT_LINES = 50;
  const MAX_PENDING_REQUESTS = 64;

  // 键值同名：透传到 MCP 层时不必再做映射表
  const ERROR_CODES = Object.freeze({
    NEEDS_USER_GESTURE: 'NEEDS_USER_GESTURE',
    PORT_BUSY: 'PORT_BUSY',
    PAGE_NOT_CONNECTED: 'PAGE_NOT_CONNECTED',
    BRIDGE_TIMEOUT: 'BRIDGE_TIMEOUT',
    PORT_NOT_CONNECTED: 'PORT_NOT_CONNECTED',
    NOT_ARMED: 'NOT_ARMED',
    INVALID_ARGS: 'INVALID_ARGS',
    OP_UNSUPPORTED: 'OP_UNSUPPORTED',
    PAGE_ERROR: 'PAGE_ERROR',
  });

  const isErrorCode = v => typeof v === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, v);

  /** 容忍 '0103'、'01 03'、'0x01,0x03'、'01:03' 四种写法 */
  function hexToBytes(s) {
    if (typeof s !== 'string') throw new Error('hex 必须是字符串');
    // 只剥每个 token 的前导 0x。全局剥离会把 '0102030x' 吃成 '010203'，
    // 于是畸形输入被静默重解释成别的字节发到线缆上，而不是干净地报错。
    const tokens = s.split(/[\s,:]+/).filter(t => t !== '');
    if (tokens.length === 0) throw new Error('hex 不能为空');
    const parts = tokens.map(t => t.replace(/^0x/i, ''));
    if (parts.includes('')) throw new Error('hex 含非法字符（0x 前缀后缺数字）');
    const cleaned = parts.join('');
    if (cleaned.length % 2 !== 0) throw new Error('hex 长度必须是偶数（每字节两位）');
    if (!/^[0-9a-fA-F]+$/.test(cleaned)) throw new Error('hex 含非法字符');
    const out = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  const bytesToHex = bytes => {
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
  };

  const bytesToBase64 = bytes => {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };

  const base64ToBytes = s => {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  /**
   * 'ascii' 一律按 UTF-8 编码——串口终端本就是 UTF-8 处理（见 readLoop 的流式解码器），
   * 把 ascii 当 latin1 会让中文在两处产生不同字节。
   */
  function encodeToBytes(data, encoding) {
    switch (encoding) {
      case 'ascii': return new TextEncoder().encode(String(data));
      case 'hex': return hexToBytes(String(data));
      case 'base64': return base64ToBytes(String(data));
      default: throw new Error('不支持的编码: ' + encoding);
    }
  }

  function bytesToEncoding(bytes, encoding) {
    switch (encoding) {
      case 'ascii': return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      case 'hex': return bytesToHex(bytes);
      case 'base64': return bytesToBase64(bytes);
      default: throw new Error('不支持的编码: ' + encoding);
    }
  }

  const makeReq = (id, domain, op, args) => ({ id, kind: 'req', domain, op, args: args || {} });
  const makeRes = (id, data) => ({ id, kind: 'res', ok: true, data });
  const makeErr = (id, code, message) => ({ id, kind: 'res', ok: false, error: { code, message } });
  const makeEvt = (domain, op, data) => ({ kind: 'evt', domain, op, data });

  function isValidEnvelope(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
    if (msg.kind === 'evt') return typeof msg.domain === 'string' && typeof msg.op === 'string';
    if (msg.kind === 'req') {
      return typeof msg.id === 'string' && typeof msg.domain === 'string' &&
             typeof msg.op === 'string' && !!msg.args && typeof msg.args === 'object';
    }
    if (msg.kind === 'res') {
      if (typeof msg.id !== 'string' || typeof msg.ok !== 'boolean') return false;
      if (msg.ok) return 'data' in msg;
      return !!msg.error && isErrorCode(msg.error.code) && typeof msg.error.message === 'string';
    }
    return false;
  }

  return {
    PROTOCOL_VERSION, MAX_FRAME_BYTES, READ_MAX_LINES, READ_DEFAULT_LINES, MAX_PENDING_REQUESTS,
    ERROR_CODES, isErrorCode, hexToBytes, bytesToHex,
    encodeToBytes, bytesToEncoding, bytesToBase64, base64ToBytes,
    makeReq, makeRes, makeErr, makeEvt, isValidEnvelope,
  };
});
