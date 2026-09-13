// bridge-client.js 里可脱离 DOM 的纯函数测试。
//
// 页面是单文件、没有 DOM 测试环境，因此 dispatcher 有意拆成两层：
// 纯函数层（本文件覆盖）与只做"调哪个全局函数"的薄映射层 OPS（靠 client.test.js 的
// 防漂移断言 + 手工端到端验证兜底）。
const { test } = require('node:test');
const assert = require('node:assert');
const {
  makeRingBuffer, normalizeSendArgs, classifyWrite, isWriteOp, parseWriteData,
} = require('../bridge-client.js');

// ════════════════════════════════════════════════════════
// 一、环形缓冲
// ════════════════════════════════════════════════════════

test('环形缓冲按游标增量读取', () => {
  const rb = makeRingBuffer(10);
  rb.push('a'); rb.push('b'); rb.push('c');
  const r1 = rb.since(0);
  assert.deepStrictEqual(r1.lines, ['a', 'b', 'c']);
  assert.strictEqual(r1.dropped, 0);

  rb.push('d');
  const r2 = rb.since(r1.cursor);
  assert.deepStrictEqual(r2.lines, ['d']);
  assert.strictEqual(r2.dropped, 0);
});

test('环形缓冲挤占时显式报告 dropped', () => {
  const rb = makeRingBuffer(3);
  for (const x of ['a', 'b', 'c', 'd', 'e']) rb.push(x);
  const r = rb.since(0);          // 游标 0 太旧，只剩 c/d/e
  assert.deepStrictEqual(r.lines, ['c', 'd', 'e']);
  assert.strictEqual(r.dropped, 2, '必须告诉 AI 漏了 2 条，否则它会以为输出连续');
});

test('游标超过最新位置时返回空且不报负 dropped', () => {
  const rb = makeRingBuffer(5);
  rb.push('a');
  const r = rb.since(999);
  assert.deepStrictEqual(r.lines, []);
  assert.strictEqual(r.dropped, 0);
});

test('since 报告首条返回行的序号（serial.read 截断后据此续读）', () => {
  const rb = makeRingBuffer(10);
  rb.push('a'); rb.push('b');
  assert.strictEqual(rb.since(0).firstSeq, 0, '未挤占时首条就是第 0 条');
  assert.strictEqual(rb.since(1).firstSeq, 1, '游标之后的第一个序号');
  assert.strictEqual(rb.since(999).firstSeq, rb.cursor, '空结果时等于最新游标');
});

test('挤占后 since 的首条序号是缓冲区里真正最旧的一条', () => {
  const rb = makeRingBuffer(3);
  for (const x of ['a', 'b', 'c', 'd', 'e']) rb.push(x);   // 只剩 seq 2,3,4
  const r = rb.since(0);
  assert.strictEqual(r.firstSeq, 2);
  assert.strictEqual(r.firstSeq + r.lines.length, rb.cursor, '首序号 + 条数 = 最新游标');
});

// ════════════════════════════════════════════════════════
// 二、发送参数规范化
// ════════════════════════════════════════════════════════

test('normalizeSendArgs 校验并规范化', () => {
  assert.deepStrictEqual(
    normalizeSendArgs({ data: 'AT', encoding: 'ascii' }),
    { bytes: new Uint8Array([0x41, 0x54]), encoding: 'ascii' });
  assert.strictEqual(normalizeSendArgs({ data: 'AT' }).encoding, 'ascii', 'encoding 默认 ascii');
  assert.throws(() => normalizeSendArgs({}), /data/);
  assert.throws(() => normalizeSendArgs({ data: '' }), /data/);
  assert.throws(() => normalizeSendArgs({ data: 'AZ', encoding: 'hex' }), /hex/);
});

test('normalizeSendArgs 的 ascii 走 UTF-8（与 readLoop 的解码器一致）', () => {
  const { bytes } = normalizeSendArgs({ data: '温度' });
  assert.deepStrictEqual(Array.from(bytes), [0xE6, 0xB8, 0xA9, 0xE5, 0xBA, 0xA6]);
});

// ════════════════════════════════════════════════════════
// 三、武装开关：读写分类
// ════════════════════════════════════════════════════════

test('classifyWrite 区分读写操作（决定是否受武装开关限制）', () => {
  for (const [domain, op] of [['serial', 'status'], ['serial', 'read'], ['ui', 'inspect'], ['modbus', 'status'], ['modbus', 'log'], ['dev', 'fake_capture']]) {
    assert.strictEqual(classifyWrite(domain, op), false, `${domain}.${op} 应为只读`);
  }
  for (const [domain, op] of [['serial', 'send'], ['serial', 'connect'], ['serial', 'disconnect'], ['serial', 'set_params'], ['modbus', 'request'], ['modbus', 'cycle_start'], ['ui', 'clear'], ['ui', 'run_macro'], ['dev', 'serial_source']]) {
    assert.strictEqual(classifyWrite(domain, op), true, `${domain}.${op} 应为写入`);
  }
});

test('isWriteOp 看穿 ui.action 的多态：list_macros 是读、run_macro 是写', () => {
  // ui_action 是一个工具名对应多个行为，只按 op='action' 判定会把 list_macros
  // 一起挡在武装开关后面，与"读取类操作不受限制"相悖
  assert.strictEqual(isWriteOp('ui', 'action', { action: 'list_macros' }), false);
  assert.strictEqual(isWriteOp('ui', 'action', { action: 'run_macro', name: 'AT' }), true);
  assert.strictEqual(isWriteOp('ui', 'action', { action: 'clear' }), true);
  assert.strictEqual(isWriteOp('ui', 'action', { action: 'set_theme', theme: 'amber' }), true);
  assert.strictEqual(isWriteOp('ui', 'action', {}), true, '缺 action 时保守按写入处理');
  assert.strictEqual(isWriteOp('ui', 'action', { action: 'not_an_action' }), true,
    '未知 action 不在 READ_ONLY 里，按写入处理（随后会被 handler 以 INVALID_ARGS 拒绝）');
  // 非 ui.action 的操作原样交给 classifyWrite
  assert.strictEqual(isWriteOp('serial', 'status', {}), false);
  assert.strictEqual(isWriteOp('dev', 'fake_capture', { action: 'fake_capture' }), false);
  assert.strictEqual(isWriteOp('dev', 'serial_source', { mode: 'fake' }), true);
});

// ════════════════════════════════════════════════════════
// 四、Modbus 写数据解析（重建页面将要发送的帧）
// ════════════════════════════════════════════════════════

test('parseWriteData 对 FC5/6 产出 16 位整数，对 FC15/16 产出字节数组', () => {
  // 必须与 modbusSend() 从 #mbWriteData 的解析完全一致，
  // 否则回给 AI 的 txHex 与实际上线缆的字节不同
  assert.strictEqual(parseWriteData(5, 'FF 00'), 0xFF00);
  assert.strictEqual(parseWriteData(6, '00 0A'), 0x000A);
  assert.strictEqual(parseWriteData(6, '01,02'), 0x0102);
  assert.deepStrictEqual(Array.from(parseWriteData(15, '01 03')), [0x01, 0x03]);
  assert.deepStrictEqual(
    Array.from(parseWriteData(16, '00 64 00 C8')), [0x00, 0x64, 0x00, 0xC8]);
});

test('parseWriteData 的结果能被 modbusConstructFrame 正确编码进帧', () => {
  // 复刻页面 modbusConstructFrame 对 FC6 的分支：地址与数据各两字节，再补 CRC
  const frame = buildFrame(6, 0x0001, 0x0002, parseWriteData(6, '00 02'));
  assert.deepStrictEqual(Array.from(frame.slice(0, 6)),
    [0x01, 0x06, 0x00, 0x01, 0x00, 0x02], '从站/功能码/地址/数据须按序落到线缆字节上');
});

/** 与页面 modbusConstructFrame 的 FC5/6 分支等价的最小复刻（含 CRC 占位两字节） */
function buildFrame(funcCode, address, _quantity, writeData) {
  const buf = [0x01, funcCode, (address >> 8) & 0xFF, address & 0xFF,
    (writeData >> 8) & 0xFF, writeData & 0xFF];
  return new Uint8Array(buf.concat([0, 0]));
}
