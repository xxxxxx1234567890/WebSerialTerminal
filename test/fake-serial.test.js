// test/fake-serial.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { FakeScript, FakeSerialPort } = require('../fake-serial.js');

const sync = fn => fn(); // 同步调度器：让规则延迟不引入计时器抖动

test('open 后 readable/writable 才可获取', async () => {
  const p = new FakeSerialPort();
  assert.strictEqual(p.isOpen, false);
  await p.open({ baudRate: 115200 });
  assert.strictEqual(p.isOpen, true);
  assert.ok(p.readable instanceof ReadableStream);
  assert.ok(p.writable instanceof WritableStream);
});

test('重复 open 抛错，close 后可再 open', async () => {
  const p = new FakeSerialPort();
  await p.open({});
  await assert.rejects(() => p.open({}), /已打开/);
  await p.close();
  assert.strictEqual(p.isOpen, false);
  await p.open({}); // 真实 SerialPort 允许关闭后重开
});

test('对已锁定流二次 getReader 抛 TypeError', async () => {
  const p = new FakeSerialPort();
  await p.open({});
  p.readable.getReader();
  assert.throws(() => p.readable.getReader(), { name: 'TypeError' });
});

test('cancel 使待决 read() resolve {done:true}（v24 实测语义）', async () => {
  const p = new FakeSerialPort();
  await p.open({});
  const reader = p.readable.getReader();
  const pending = reader.read();
  await reader.cancel();
  assert.deepStrictEqual(await pending, { value: undefined, done: true });
});

test('close 使待决 read() resolve {done:true}', async () => {
  const p = new FakeSerialPort();
  await p.open({});
  const reader = p.readable.getReader();
  const pending = reader.read();
  await p.close();
  assert.deepStrictEqual(await pending, { value: undefined, done: true });
});

test('injectBytes 送达读取方，且不合并相邻分块语义', async () => {
  const p = new FakeSerialPort();
  await p.open({});
  const reader = p.readable.getReader();
  p.injectBytes(new Uint8Array([0x41]));
  p.injectBytes(new Uint8Array([0x42, 0x43]));
  assert.deepStrictEqual((await reader.read()).value, new Uint8Array([0x41]));
  assert.deepStrictEqual((await reader.read()).value, new Uint8Array([0x42, 0x43]));
});

test('未 open 时 injectBytes 抛错', () => {
  assert.throws(() => new FakeSerialPort().injectBytes(new Uint8Array([1])), /未打开/);
});

test('writable 的写入被 capturedBytes 收集', async () => {
  const p = new FakeSerialPort();
  await p.open({});
  const w = p.writable.getWriter();
  await w.write(new Uint8Array([0x01, 0x03]));
  await w.write(new Uint8Array([0x00]));
  w.releaseLock();
  assert.deepStrictEqual([...p.capturedBytes], [0x01, 0x03, 0x00]);
  p.clearCaptured();
  assert.strictEqual(p.capturedBytes.length, 0);
});

test('getInfo 返回配置的 VID/PID', async () => {
  const p = new FakeSerialPort({ usbVendorId: 0x1234, usbProductId: 0x5678 });
  await p.open({});
  assert.deepStrictEqual(p.getInfo(), { usbVendorId: 0x1234, usbProductId: 0x5678 });
});

// ── 规则引擎 ──────────────────────────────────────────────

test('FakeScript 前缀匹配命中后清空缓冲，避免重复命中', () => {
  const s = new FakeScript([{ matchHex: '0103000000', respondHex: '0103020064', delayMs: 20 }]);
  assert.strictEqual(s.push(new Uint8Array([0x01, 0x03])), null);        // 尚未匹配
  const hit = s.push(new Uint8Array([0x00, 0x00, 0x00]));
  assert.deepStrictEqual([...hit.respond], [0x01, 0x03, 0x02, 0x00, 0x64]);
  assert.strictEqual(hit.delayMs, 20);
});

test('FakeScript 未匹配时不回注（用于测超时路径）', () => {
  const s = new FakeScript([{ matchHex: 'ff', respondHex: 'aa', delayMs: 0 }]);
  assert.strictEqual(s.push(new Uint8Array([0x01, 0x02])), null);
});

test('FakeScript 多规则按序首匹配生效', () => {
  const s = new FakeScript([
    { matchHex: '0103', respondHex: 'aaaa', delayMs: 0 },
    { matchHex: '01', respondHex: 'bbbb', delayMs: 0 },
  ]);
  assert.deepStrictEqual([...s.push(new Uint8Array([0x01, 0x03])).respond], [0xaa, 0xaa]);
});

test('FakeScript reset 清空累积缓冲', () => {
  const s = new FakeScript([{ matchHex: '0103', respondHex: 'aa', delayMs: 0 }]);
  s.push(new Uint8Array([0x01]));
  s.reset();
  assert.strictEqual(s.push(new Uint8Array([0x03])), null); // 缓冲已清，'01' 丢了
});

test('FakeScript 空规则表永不回注', () => {
  assert.strictEqual(new FakeScript([]).push(new Uint8Array([1, 2, 3])), null);
});

test('规则命中后经 schedule 回注到 readable', async () => {
  const p = new FakeSerialPort({
    rules: [{ matchHex: '0103', respondHex: '0103020064', delayMs: 0 }],
    schedule: sync,
  });
  await p.open({});
  const reader = p.readable.getReader();
  const w = p.writable.getWriter();
  await w.write(new Uint8Array([0x01, 0x03]));
  assert.deepStrictEqual((await reader.read()).value, new Uint8Array([0x01, 0x03, 0x02, 0x00, 0x64]));
});

test('setRules 可运行中替换规则', async () => {
  const p = new FakeSerialPort({ schedule: sync });
  await p.open({});
  const reader = p.readable.getReader();
  const w = p.writable.getWriter();
  await w.write(new Uint8Array([0x09]));
  assert.strictEqual(p.capturedBytes.length, 1);   // 无规则 → 只有捕获
  p.setRules([{ matchHex: '09', respondHex: 'ee', delayMs: 0 }]);
  await w.write(new Uint8Array([0x09]));
  assert.deepStrictEqual((await reader.read()).value, new Uint8Array([0xee]));
});
