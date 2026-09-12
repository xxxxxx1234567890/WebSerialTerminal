// test/bridge-protocol.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const P = require('../bridge-protocol.js');

test('hexToBytes 容忍空格、0x 前缀与冒号', () => {
  const want = [0x01, 0x03, 0x00, 0xAB];
  assert.deepStrictEqual([...P.hexToBytes('010300ab')], want);
  assert.deepStrictEqual([...P.hexToBytes('01 03 00 AB')], want);
  assert.deepStrictEqual([...P.hexToBytes('0x01,0x03,0x00,0xab')], want);
  assert.deepStrictEqual([...P.hexToBytes('01:03:00:AB')], want);
});

test('hexToBytes 对非法输入抛错而非静默截断', () => {
  assert.throws(() => P.hexToBytes('01030'), /长度/);      // 奇数长度
  assert.throws(() => P.hexToBytes('01ZZ03'), /非法/);     // 非 hex 字符
  assert.throws(() => P.hexToBytes(''), /空/);
});

test('bytesToHex 输出小写连续形式', () => {
  assert.strictEqual(P.bytesToHex(new Uint8Array([0x01, 0xAB, 0x00])), '01ab00');
  assert.strictEqual(P.bytesToHex(new Uint8Array([])), '');
});

test('encodeToBytes 支持三种编码且往返一致', () => {
  const text = 'AT+RST\r\n';
  const hex = '41542b5253540d0a';
  const b64 = Buffer.from(text, 'utf8').toString('base64');

  assert.strictEqual(P.bytesToHex(P.encodeToBytes(text, 'ascii')), hex);
  assert.strictEqual(P.bytesToHex(P.encodeToBytes(hex, 'hex')), hex);
  assert.strictEqual(P.bytesToHex(P.encodeToBytes(b64, 'base64')), hex);

  const bytes = P.encodeToBytes(text, 'ascii');
  assert.strictEqual(P.bytesToEncoding(bytes, 'ascii'), text);
  assert.strictEqual(P.bytesToEncoding(bytes, 'hex'), hex);
  assert.strictEqual(P.bytesToEncoding(bytes, 'base64'), b64);
});

test('ascii 编码走 UTF-8，中文不丢字节', () => {
  const bytes = P.encodeToBytes('温度:25.6℃', 'ascii');
  assert.strictEqual(P.bytesToEncoding(bytes, 'ascii'), '温度:25.6℃');
  // 温 3 + 度 3 + ':' 1 + '25.6' 4 + '℃'(U+2103) 3 = 14
  assert.strictEqual(bytes.length, 14);
});

test('未知编码抛错', () => {
  assert.throws(() => P.encodeToBytes('x', 'utf7'), /不支持的编码/);
  assert.throws(() => P.bytesToEncoding(new Uint8Array(), 'utf7'), /不支持的编码/);
});

test('错误码是冻结对象且与 isErrorCode 一致', () => {
  assert.ok(Object.isFrozen(P.ERROR_CODES));
  const want = ['NEEDS_USER_GESTURE', 'PORT_BUSY', 'PAGE_NOT_CONNECTED', 'BRIDGE_TIMEOUT',
                'PORT_NOT_CONNECTED', 'NOT_ARMED', 'INVALID_ARGS', 'OP_UNSUPPORTED', 'PAGE_ERROR'];
  assert.deepStrictEqual(Object.keys(P.ERROR_CODES).sort(), want.slice().sort());
  for (const k of want) {
    assert.strictEqual(P.ERROR_CODES[k], k, '键值应同名，便于透传');
    assert.strictEqual(P.isErrorCode(k), true);
  }
  assert.strictEqual(P.isErrorCode('NOPE'), false);
});

test('信封构造器与校验', () => {
  const req = P.makeReq('r-1', 'serial', 'send', { data: 'x' });
  assert.deepStrictEqual(req, { id: 'r-1', kind: 'req', domain: 'serial', op: 'send', args: { data: 'x' } });
  assert.strictEqual(P.isValidEnvelope(req), true);

  const res = P.makeRes('r-1', { ok: 1 });
  assert.strictEqual(res.kind, 'res');
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.data, { ok: 1 });
  assert.strictEqual(P.isValidEnvelope(res), true);

  const err = P.makeErr('r-1', P.ERROR_CODES.PORT_NOT_CONNECTED, '未连接');
  assert.strictEqual(err.ok, false);
  assert.strictEqual(err.error.code, 'PORT_NOT_CONNECTED');
  assert.strictEqual(err.error.message, '未连接');

  const evt = P.makeEvt('serial', 'state', { connected: false });
  assert.strictEqual(evt.kind, 'evt');
  assert.strictEqual(evt.id, undefined);
  assert.strictEqual(P.isValidEnvelope(evt), true);

  for (const bad of [null, undefined, {}, { kind: 'req' }, { kind: 'nope' }, 'x', 42]) {
    assert.strictEqual(P.isValidEnvelope(bad), false, JSON.stringify(bad));
  }
});

test('hexToBytes 只剥每个 token 的前导 0x，别处的 0x 一律拒绝', () => {
  // 未锚定的剥离会把它们吃成合法 hex，静默发出与请求不同的字节
  assert.throws(() => P.hexToBytes('0102030x'), /非法/);
  assert.throws(() => P.hexToBytes('a0xb'), /非法/);
  assert.throws(() => P.hexToBytes('0x0x01'), /非法/);
  assert.throws(() => P.hexToBytes('01 0x'), /非法/);   // 悬空的 0x 前缀

  // 每个 token 各自的前导 0x 仍受支持（含大写 0X）
  assert.deepStrictEqual([...P.hexToBytes('0x01 0x03 0x00 0xAB')], [0x01, 0x03, 0x00, 0xAB]);
  assert.deepStrictEqual([...P.hexToBytes('0X01:0x03')], [0x01, 0x03]);
});
