// fake-serial.js
// 可替换的串口源。readable/writable 必须是平台原生流：
// 现有 readLoop / disconnectPort 依赖真实流的精确语义
// （cancel 与 close 均使待决 read() resolve {done:true}；对已锁定流 getReader 抛 TypeError）。
// 手写 Promise shim 会漏掉这些边界，后果是测试全绿但真机挂掉。
// factory 必须收到 root：factory 定义在外层脚本作用域，闭包不到 IIFE 的 root 形参，
// 浏览器分支里写 root.BridgeProtocol 会直接 ReferenceError，<script> 加载整块失败。
// 本文件 factory 无副作用，故"调用一次、结果二选一导出"是安全的。
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FakeSerial = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const { hexToBytes } = (typeof module === 'object' && module.exports)
    ? require('./bridge-protocol.js')
    : root.BridgeProtocol;

  const concat = chunks => {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  };

  /** TX 累积缓冲 + 前缀匹配。匹配后清空缓冲，否则同一请求会被重复命中 */
  class FakeScript {
    constructor(rules = []) { this.setRules(rules); }
    setRules(rules = []) {
      this.rules = rules.map(r => ({
        match: hexToBytes(r.matchHex),
        respond: hexToBytes(r.respondHex),
        delayMs: Number(r.delayMs) || 0,
      }));
      this.buf = new Uint8Array(0);
    }
    reset() { this.buf = new Uint8Array(0); }
    push(bytes) {
      this.buf = concat([this.buf, bytes]);
      for (const r of this.rules) {
        if (this.buf.length < r.match.length) continue;
        let hit = true;
        for (let i = 0; i < r.match.length; i++) {
          if (this.buf[i] !== r.match[i]) { hit = false; break; }
        }
        if (hit) { this.buf = new Uint8Array(0); return { respond: r.respond, delayMs: r.delayMs }; }
      }
      // 未匹配一律不回注——AI 据此可主动测试超时路径
      return null;
    }
  }

  class FakeSerialPort {
    constructor({ usbVendorId = 0x1A86, usbProductId = 0x7523, rules = [], schedule } = {}) {
      this._info = { usbVendorId, usbProductId };
      this._script = new FakeScript(rules);
      this._schedule = schedule || ((fn, ms) => setTimeout(fn, ms));
      this._open = false;
      this._controller = null;
      this._captured = [];
      this._readable = null;
      this._writable = null;
    }

    get isOpen() { return this._open; }
    get readable() { return this._readable; }
    get writable() { return this._writable; }
    get capturedBytes() { return concat(this._captured); }

    getInfo() { return { ...this._info }; }
    clearCaptured() { this._captured = []; }
    setRules(rules) { this._script.setRules(rules); }

    async open() {
      if (this._open) throw new Error('端口已打开');
      this._open = true;

      this._readable = new ReadableStream({
        start: c => { this._controller = c; },
      });

      this._writable = new WritableStream({
        write: chunk => {
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          this._captured.push(bytes);
          const hit = this._script.push(bytes);
          if (hit) {
            this._schedule(() => {
              if (this._open) this._controller.enqueue(hit.respond);
            }, hit.delayMs);
          }
        },
      });
    }

    async close() {
      if (!this._open) return;
      this._open = false;
      // close() 令待决 read() resolve {done:true}，与原生语义一致
      try { this._controller.close(); } catch { /* 已关闭 */ }
    }

    injectBytes(bytes) {
      if (!this._open) throw new Error('端口未打开，无法注入');
      this._controller.enqueue(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    }
  }

  return { FakeScript, FakeSerialPort };
});
