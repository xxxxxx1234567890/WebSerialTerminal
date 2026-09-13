// bridge-client.js 里可脱离 DOM 的纯函数测试。
//
// 页面是单文件、没有 DOM 测试环境，因此 dispatcher 有意拆成两层：
// 纯函数层（本文件覆盖）与只做"调哪个全局函数"的薄映射层 OPS（靠 client.test.js 的
// 防漂移断言 + 手工端到端验证兜底）。
const { test } = require('node:test');
const assert = require('node:assert');
const {
  makeRingBuffer, normalizeSendArgs, classifyWrite, isWriteOp,
  normalizeWriteData, describeWrite, parseConnectFailure,
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

test('normalizeWriteData 对 FC5/6 产出 16 位整数，对 FC15/16 产出字节数组', () => {
  // value 必须与 modbusSend() 从 #mbWriteData 解析出的形状一致，
  // 否则回给 AI 的 txHex 与实际上线缆的字节不同
  assert.strictEqual(normalizeWriteData(5, 'FF 00').value, 0xFF00);
  assert.strictEqual(normalizeWriteData(6, '00 0A').value, 0x000A);
  assert.strictEqual(normalizeWriteData(6, '01,02').value, 0x0102);
  assert.deepStrictEqual(Array.from(normalizeWriteData(15, '01 03').value), [0x01, 0x03]);
  assert.deepStrictEqual(
    Array.from(normalizeWriteData(16, '00 64 00 C8').value), [0x00, 0x64, 0x00, 0xC8]);
});

test('normalizeWriteData 回吐给页面的 text 必须是空格分隔的字节', () => {
  // 页面是按 token 逐个 parseInt(,16) 解析 #mbWriteData 的：
  // '000a' 会被当成一个 token，b[1] 变 undefined → 帧里成 0。
  // 所以回填的字符串必须是 '00 0a' 这种形式，不能是连写。
  assert.strictEqual(normalizeWriteData(6, '000A').text, '00 0a', '连写要拆成字节');
  assert.strictEqual(normalizeWriteData(6, '0x00,0x0A').text, '00 0a');
  assert.strictEqual(normalizeWriteData(16, '00 64 00 C8').text, '00 64 00 c8');
  // 页面用同一份 text 解析出的字节必须与 value 一致
  const back = normalizeWriteData(6, normalizeWriteData(6, '000A').text).value;
  assert.strictEqual(back, 0x000A, 'text 回灌页面后必须解析出同一组字节');
});

test('normalizeWriteData 对非法写数据抛出可读错误（而不是静默产出零值帧）', () => {
  assert.throws(() => normalizeWriteData(6, 'ZZ'), /writeData/, '非十六进制应报错');
  assert.throws(() => normalizeWriteData(6, '00 0'), /writeData/, '奇数长度应报错');
  assert.throws(() => normalizeWriteData(6, ''), /writeData/, '空值应报错');
  assert.throws(() => normalizeWriteData(6, '00 0A 0B'), /2 字节/, 'FC6 必须是 16 位值');
  assert.throws(() => normalizeWriteData(5, 'AA'), /2 字节/, 'FC5 必须是 16 位值');
});

test('normalizeWriteData 对 FC15/16 校验长度：帧按 quantity 推 byteCount，短数据会被静默补零', () => {
  // modbusConstructFrame 的 FC16 分支：byteCount = quantity*2，再逐字节取
  // writeData[i]；越界取到的 undefined 经 new Uint8Array() 变成 0——线缆上的字节
  // 与调用方给的数据不一致却**不报错**（FC15/16 是"写多寄存器"，补零会真的改设备状态）。
  assert.throws(() => normalizeWriteData(16, '01', 2), /正好 4 字节/,
    'quantity=2 需要 4 字节，只给 1 字节必须报错而不是补 3 个零');
  assert.throws(() => normalizeWriteData(16, '00 64 00', 2), /正好 4 字节/, '少一个字节同样要报错');
  assert.throws(() => normalizeWriteData(16, '00 64 00 C8 FF', 2), /正好 4 字节/, '多一个字节也不接受');
  assert.throws(() => normalizeWriteData(15, '01', 16), /正好 2 字节/,
    'FC15 按位打包：16 个线圈 = 2 字节');
  assert.throws(() => normalizeWriteData(15, '01 02 03', 8), /正好 1 字节/, 'FC15 多给也要报错');

  // 与 byteCount 同算式的正例：这些必须通过，且字节原样落到帧上
  assert.deepStrictEqual(Array.from(normalizeWriteData(16, '00 64 00 C8', 2).value),
    [0x00, 0x64, 0x00, 0xC8]);
  assert.deepStrictEqual(Array.from(normalizeWriteData(15, '01 03', 16).value), [0x01, 0x03]);
  assert.deepStrictEqual(Array.from(normalizeWriteData(15, '0F', 4).value), [0x0F], '4 个线圈恰好 1 字节');

  // 不传 quantity 时跳过长度核对（保留"只做编码检查"的单参用法）
  assert.doesNotThrow(() => normalizeWriteData(16, '00 64 00 C8'));
});

test('normalizeWriteData 的结果能被 modbusConstructFrame 正确编码进帧', () => {
  // 复刻页面 modbusConstructFrame 对 FC6 的分支：地址与数据各两字节，再补 CRC
  const frame = buildFrame(6, 0x0001, 0x0002, normalizeWriteData(6, '00 02').value);
  assert.deepStrictEqual(Array.from(frame.slice(0, 6)),
    [0x01, 0x06, 0x00, 0x01, 0x00, 0x02], '从站/功能码/地址/数据须按序落到线缆字节上');
});

/** 与页面 modbusConstructFrame 的 FC5/6 分支等价的最小复刻（含 CRC 占位两字节） */
function buildFrame(funcCode, address, _quantity, writeData) {
  const buf = [0x01, funcCode, (address >> 8) & 0xFF, address & 0xFF,
    (writeData >> 8) & 0xFF, writeData & 0xFF];
  return new Uint8Array(buf.concat([0, 0]));
}

// ════════════════════════════════════════════════════════
// 五、审计覆盖
//
// spec 第 5.5 节把 [AI] 审计轨迹定为"不做逐次确认"的唯一补偿控制
// （design 第 7.2 节）。因此覆盖必须是每个写入操作都有的结构性保证——
// dispatcher 会在每个写操作前调用 describeWrite，这里的断言就是那份保证。
// ════════════════════════════════════════════════════════

/** 所有写入类操作的 (domain, op, args, page) 四元组，新增写操作时应同步加入。
 *  page 里放的是"args 里没有、只有页面才知道"的事实（轮询表单、宏命令）。 */
const CYCLE_PAGE = {
  cycle: { slaveId: '1', funcCode: '3', address: '0', quantity: '10', cycleIntervalMs: '1000' },
};
const WRITE_CASES = [
  ['serial', 'connect', { index: 0 }, {}],
  ['serial', 'connect', {}, {}],
  ['serial', 'disconnect', {}, {}],
  ['serial', 'send', { data: 'AT' }, {}],
  ['serial', 'set_params', { baudRate: 115200 }, {}],
  ['modbus', 'control', { action: 'set_mode', mode: 'independent' }, {}],
  ['modbus', 'control', { action: 'connect', index: 1 }, {}],
  ['modbus', 'control', { action: 'disconnect' }, {}],
  ['modbus', 'control', { action: 'activate' }, {}],
  ['modbus', 'control', { action: 'deactivate' }, {}],
  ['modbus', 'control', { action: 'cycle_start' }, CYCLE_PAGE],
  ['modbus', 'control', { action: 'cycle_stop' }, {}],
  ['modbus', 'request', { slaveId: 1, funcCode: 3, address: 0, quantity: 10 }, {}],
  ['modbus', 'request', { slaveId: 1, funcCode: 6, address: 0, quantity: 1, writeData: '00 0A' }, {}],
  ['ui', 'action', { action: 'clear' }, {}],
  ['ui', 'action', { action: 'pause' }, {}],
  ['ui', 'action', { action: 'resume' }, {}],
  ['ui', 'action', { action: 'set_theme', theme: 'amber' }, {}],
  ['ui', 'action', { action: 'set_font', size: 18 }, {}],
  ['ui', 'action', { action: 'toggle_sidebar' }, {}],
  ['ui', 'action', { action: 'run_macro', name: 'AT' }, { macroCmd: 'AT' }],
  ['ui', 'action', { action: 'save_log' }, {}],
  ['dev', 'serial_source', { mode: 'fake' }, {}],
  ['dev', 'fake_inject', { data: '41' }, {}],
  ['dev', 'fake_script', { rules: [{ matchHex: '01', respondHex: '02' }] }, {}],
];

test('每个写入类操作都有非空审计描述', () => {
  for (const [d, o, a, f] of WRITE_CASES) {
    const desc = describeWrite(d, o, a, f);
    assert.strictEqual(typeof desc, 'string', `${d}.${o} 必须有审计描述`);
    assert.ok(desc.trim().length > 0, `${d}.${o} 的审计描述不能为空`);
  }
});

test('读取类操作不产生审计行', () => {
  for (const [d, o, a] of [['serial', 'status'], ['serial', 'read'], ['modbus', 'status'],
    ['modbus', 'log'], ['ui', 'inspect'], ['dev', 'fake_capture']]) {
    assert.strictEqual(describeWrite(d, o, a || {}, {}), null, `${d}.${o} 是只读，不该审计`);
  }
  assert.strictEqual(describeWrite('ui', 'action', { action: 'list_macros' }, {}), null,
    'ui_action list_macros 是只读');
  assert.strictEqual(describeWrite('ui', 'inspect', {}, {}), null, 'ui.inspect 是只读');
});

test('最高危的"启动轮询"审计行必须说清对谁发什么', () => {
  // 轮询会持续对真实硬件发报文，而终端里本来零痕迹——行里没有这些，
  // 事后就无从追溯，"不做逐次确认"这个决策的前提也就没了。
  // 参数来自 page.cycle（页面侧应填 mv*，见浏览器测试的分叉场景）。
  const desc = describeWrite('modbus', 'control', { action: 'cycle_start' }, {
    cycle: { slaveId: '7', funcCode: '4', address: '9', quantity: '2', cycleIntervalMs: '500' },
  });
  for (const frag of ['轮询', 'slave=7', 'fc=4', 'addr=9', 'qty=2', '500']) {
    assert.ok(desc.includes(frag), `审计行应含「${frag}」，实际: ${desc}`);
  }
  // 写功能码的轮询要把载荷也带上：帧里有什么就得记什么
  const w = describeWrite('modbus', 'control', { action: 'cycle_start' }, {
    cycle: { slaveId: '1', funcCode: '6', address: '0', quantity: '1', writeData: '00 0a', cycleIntervalMs: '1000' },
  });
  assert.ok(w.includes('数据=00 0a'), '写功能码的轮询要记下载荷：' + w);
});

test('宏的审计行必须带上实际会发出的命令（不能只记宏名）', () => {
  // 只记宏名的话，追溯要依赖"宏定义在被查时仍未改动"——用户一改宏，记录就误导了
  const desc = describeWrite('ui', 'action', { action: 'run_macro', name: 'AT' },
    { macroCmd: 'AT+GMR' });
  assert.ok(desc.includes('AT+GMR'), '审计行应含宏实际会发出的命令：' + desc);
  assert.match(desc, /执行宏「AT」/);
});

test('审计行能看出"对硬件做了什么"：连接/发送/写寄存器带上目标与载荷', () => {
  assert.match(describeWrite('serial', 'connect', { index: 1 }, {}), /index=1/);
  assert.match(describeWrite('serial', 'send', { data: '4142', encoding: 'hex' }, {}), /4142/,
    '发送类审计应带实际字节的十六进制');
  const req = describeWrite('modbus', 'request',
    { slaveId: 2, funcCode: 6, address: 16, quantity: 1, writeData: '00 0A' }, {});
  for (const frag of ['slave=2', 'fc=6', 'addr=16', 'qty=1', '00 0A']) {
    assert.ok(req.includes(frag), `写寄存器审计应含「${frag}」，实际: ${req}`);
  }
  assert.match(describeWrite('dev', 'fake_inject', { data: '41' }, {}), /41（hex）/,
    '按默认 hex 渲染，与 schema 默认值一致');
});

test('审计描述在参数缺失或非法时也不抛（审计行不得因参数问题消失）', () => {
  // 参数非法恰恰是最该留痕的时候；审计本身若抛，dispatcher 会把整条请求
  // 变成 PAGE_ERROR，反而连"有人试过"都记不下来
  for (const [d, o, a] of [['serial', 'send', {}], ['serial', 'send', { data: 'ZZ', encoding: 'hex' }],
    ['dev', 'fake_inject', {}], ['modbus', 'request', {}], ['ui', 'action', {}]]) {
    assert.doesNotThrow(() => describeWrite(d, o, a, {}), `${d}.${o} 的审计描述不得抛`);
  }
  assert.match(describeWrite('serial', 'send', { data: 'ZZ', encoding: 'hex' }, {}), /无法按 hex 编码/,
    '编码失败时应退回原文而不是抛');
});

test('审计行里不得出现字面量 undefined（缺参一律给可读占位）', () => {
  // 审计行里的 "undefined" 看起来像一个真实取值，会让事后追溯得出错误结论——
  // 这与表单字段是同一条规则，不因为这里是 args / page 就放宽
  for (const [d, o] of WRITE_CASES.map(c => [c[0], c[1]])) {
    for (const args of [{}, { action: undefined, mode: undefined, name: undefined, theme: undefined, size: undefined, index: undefined }]) {
      const desc = describeWrite(d, o, args, {});
      assert.ok(!desc.includes('undefined'), `${d}.${o} 的审计行含 undefined：${desc}`);
    }
  }
  // 逐个动作的缺参形态（上面只覆盖了通用键名）
  const cases = [
    ['modbus', 'control', { action: 'set_mode' }],
    ['modbus', 'control', { action: 'cycle_start' }],
    ['modbus', 'control', {}],
    ['ui', 'action', { action: 'run_macro' }],
    ['ui', 'action', { action: 'set_theme' }],
    ['ui', 'action', { action: 'set_font' }],
    ['ui', 'action', {}],
    ['dev', 'serial_source', {}],
    ['modbus', 'request', {}],
  ];
  for (const [d, o, a] of cases) {
    const desc = describeWrite(d, o, a, {});
    assert.ok(!desc.includes('undefined'), `${d}.${o} ${JSON.stringify(a)} 的审计行含 undefined：${desc}`);
  }
});

// ════════════════════════════════════════════════════════
// 六、审计的载荷必须按**帧里真实存在的东西**设门
// ════════════════════════════════════════════════════════
// 格式化后的值源自人类，但"写这一行的动作"可以由 AI 触发，所以错误载荷一样会落进
// AI 读取的缓冲里，成为一条假记录。两处共用同一个门：MODBUS_WRITE_FUNCS。

test('读功能码的 modbus.request 审计行不得声称一个线缆上不存在的载荷', () => {
  // 实测复现过的形态：AI 给读功能码（3）顺手带了 writeData，
  // 审计行打出「数据=00 0A」，而 modbusConstructFrame 对 FC1-4 根本不取 writeData
  const read = describeWrite('modbus', 'request',
    { slaveId: 1, funcCode: 3, address: 0, quantity: 2, writeData: '00 0A' }, {});
  assert.ok(!read.includes('数据='),
    '读功能码的帧里没有载荷，审计行不得声称有：' + read);
  assert.match(read, /fc=3/, '目标信息本身仍要完整');

  // 写功能码必须照打（否则就是把真实载荷藏起来）
  for (const fc of [5, 6, 15, 16]) {
    const w = describeWrite('modbus', 'request',
      { slaveId: 1, funcCode: fc, address: 0, quantity: 1, writeData: '00 0A' }, {});
    assert.ok(w.includes('数据=00 0A'), `FC${fc} 是写功能码，载荷必须记下：` + w);
  }
});

test('轮询审计行同样按功能码设门（FC1-4 不带载荷）', () => {
  const page = wd => ({
    cycle: { slaveId: '1', funcCode: '3', address: '0', quantity: '10',
             writeData: wd, cycleIntervalMs: '1000' },
  });
  // 表单里残留着上一次写的载荷，而轮询此刻跑的是读功能码 —— 这正是 mvWriteData
  // 会留下的形态：不设门就会报出一个轮询永远不会发出去的载荷
  const read = describeWrite('modbus', 'control', { action: 'cycle_start' }, page('00 0A'));
  assert.ok(!read.includes('数据='),
    '读功能码的轮询不带载荷，表单里的残留值不得进审计行：' + read);

  const write = describeWrite('modbus', 'control', { action: 'cycle_start' }, {
    cycle: { slaveId: '1', funcCode: '16', address: '0', quantity: '1',
             writeData: '00 0A', cycleIntervalMs: '1000' },
  });
  assert.ok(write.includes('数据=00 0A'), '写功能码的轮询要记下载荷：' + write);
});

test('非数组 rules 不得在审计行里产出字面量 undefined', () => {
  // (a.rules || []).length 对字符串等真值会产出 undefined——看起来像一个真实取值
  for (const rules of ['abc', 5, true, { a: 1 }]) {
    const desc = describeWrite('dev', 'fake_script', { rules }, {});
    assert.ok(!desc.includes('undefined'), `rules=${JSON.stringify(rules)} 时审计行含 undefined：${desc}`);
    assert.match(desc, /条假设备应答规则/, '仍要是可读的一行：' + desc);
  }
  assert.match(describeWrite('dev', 'fake_script', { rules: [] }, {}), /0 条/);
  assert.match(describeWrite('dev', 'fake_script', {}, {}), /0 条/, '缺参按 0 条（setRules([]) 实际就是清空）');
});

// ════════════════════════════════════════════════════════
// 七、连接失败的原因提取（serial.connect 用它把真实原因带给 AI）
// ════════════════════════════════════════════════════════

test('parseConnectFailure 从终端行里取出真实原因，取最新的一条', () => {
  const lines = ['○ 已断开连接', '✖ 连接失败: Failed to open serial port.', '其他行'];
  assert.strictEqual(parseConnectFailure(lines), 'Failed to open serial port.');
  // 多条时取最新：上一次失败的原因不该盖住本次
  assert.strictEqual(
    parseConnectFailure(['✖ 连接失败: 旧原因', '✖ 连接失败: 新原因']), '新原因');
  // 没有失败行时必须返回 null（让调用方退回通用文案，而不是编一个原因）
  assert.strictEqual(parseConnectFailure(['○ 已断开连接']), null);
  assert.strictEqual(parseConnectFailure([]), null);
  assert.strictEqual(parseConnectFailure(undefined), null);
  // 页面把它写成全角冒号或带 ✖ 前缀都要认得
  assert.strictEqual(parseConnectFailure(['✖ 连接失败：端口被占用']), '端口被占用');
  // 只有前缀、没有内容时视为没有原因
  assert.strictEqual(parseConnectFailure(['✖ 连接失败: ']), null);
  // 必须锚定行首：设备回显的文本里恰好含"连接失败: "不得被当成归因（那是凭空捏造的原因）
  assert.strictEqual(parseConnectFailure(['设备日志：连接失败: 内部错误']), null,
    '不锚定行首的话，设备回显会被误读成连接失败的原因');
});
