// test/mcp-tools.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../mcp-server.js');
const P = require('../bridge-protocol.js');

const SERVER_SRC = path.join(__dirname, '..', 'mcp-server.js');

// ── 源码级断言的基础设施 ──
// 有些契约在"写坏了"与"写对了"时运行时的形状完全一致——常量与字面量同值（50）、
// 键与值同名（PAGE_ERROR）——行为断言对它们天然免疫，只能读源码来锁。
// 手法同 client.test.js。
const serverSrc = fs.readFileSync(SERVER_SRC, 'utf8');

/** 按大括号配对提取函数体（模板字面量里的 ${ } 会自然抵消） */
function extractFn(name) {
  const start = serverSrc.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const open = serverSrc.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < serverSrc.length; i++) {
    if (serverSrc[i] === '{') depth++;
    else if (serverSrc[i] === '}') { depth--; if (!depth) return serverSrc.slice(start, i + 1); }
  }
  return '';
}

/**
 * 提取单个工具的定义块：从 name: '<name>' 起，到其 inputSchema 对象闭合为止。
 * 配对从 inputSchema 的 { 才开始，所以工具描述里出现的 { }（如 dev_serial 的
 * 规则示例）不会被误算。
 */
function extractToolBlock(name) {
  const start = serverSrc.indexOf("name: '" + name + "'");
  if (start < 0) return '';
  const schemaAt = serverSrc.indexOf('inputSchema: {', start);
  if (schemaAt < 0) return '';
  const open = serverSrc.indexOf('{', schemaAt);
  let depth = 0;
  for (let i = open; i < serverSrc.length; i++) {
    if (serverSrc[i] === '{') depth++;
    else if (serverSrc[i] === '}') { depth--; if (!depth) return serverSrc.slice(start, i + 1); }
  }
  return '';
}

test('工具清单数量与命名稳定', () => {
  const names = M.buildTools().map(t => t.name);
  assert.deepStrictEqual(names, [
    'webterm_status', 'serial_connect', 'serial_disconnect', 'serial_send', 'serial_read',
    'modbus_control', 'modbus_request', 'modbus_log',
    'ui_action', 'ui_inspect', 'dev_serial',
  ]);
});

// Task 10 会在本文件里继续扩展：若新加了一个工具却漏挂 TOOL_MAP 条目，它会
// 落进 dispatchTool 的"未知工具"分支，而当前没有任何测试会失败。这条把它钉住。
test('TOOL_MAP 的键与工具清单一一对应', () => {
  assert.deepStrictEqual(Object.keys(M.TOOL_MAP), M.buildTools().map(t => t.name),
    '每个工具都必须有 TOOL_MAP 条目，否则会静默落进"未知工具"分支');
});

test('每个工具都有非空 description 与 object 型 inputSchema', () => {
  for (const t of M.buildTools()) {
    assert.ok(t.description && t.description.length > 30, `${t.name} 描述太短，模型看不到约束`);
    assert.strictEqual(t.inputSchema.type, 'object');
  }
});

test('NEEDS_USER_GESTURE 的翻译包含"重试无效"与下一步动作', () => {
  const s = M.translateError('NEEDS_USER_GESTURE', '原始消息');
  assert.match(s, /重试/);
  assert.match(s, /用户/);
  assert.match(s, /连接/);
});

test('NOT_ARMED 的翻译指向武装开关', () => {
  const s = M.translateError('NOT_ARMED', '');
  assert.match(s, /AI 写入/);
});

test('未知错误码原样带出而不吞掉', () => {
  assert.match(M.translateError('SOMETHING_NEW', '细节'), /SOMETHING_NEW/);
  assert.match(M.translateError('SOMETHING_NEW', '细节'), /细节/);
});

// 非恒真：某个码若在 ERROR_TEXT 里被改名或漏掉，那一条翻译会静默退化成兜底
// 文案 `✖ CODE: msg`——模型只看得到错误名，看不到下一步动作，而"下一步动作"
// 正是本任务的产品。
test('九个错误码都有专属翻译，不会静默退化成兜底文案', () => {
  for (const code of Object.values(P.ERROR_CODES)) {
    assert.notStrictEqual(M.translateError(code, ''), `✖ ${code}: `,
      `${code} 没有专属翻译，落到了兜底文案`);
  }
});

test('dispatchTool 把工具名映射到正确的桥操作', async () => {
  const calls = [];
  const request = async (domain, op, args) => {
    calls.push([domain, op, args]);
    return P.makeRes('x', { ok: 1 });
  };

  await M.dispatchTool('serial_send', { data: 'AT' }, request);
  assert.deepStrictEqual(calls[0], ['serial', 'send', { data: 'AT' }]);

  await M.dispatchTool('serial_read', { cursor: 5 }, request);
  assert.deepStrictEqual(calls[1], ['serial', 'read', { cursor: 5 }]);

  await M.dispatchTool('modbus_control', { action: 'cycle_start' }, request);
  assert.deepStrictEqual(calls[2], ['modbus', 'control', { action: 'cycle_start' }]);

  await M.dispatchTool('dev_serial', { action: 'fake_inject', data: '41' }, request);
  assert.deepStrictEqual(calls[3], ['dev', 'fake_inject', { action: 'fake_inject', data: '41' }]);
});

// 名字即断言：这里钉的是"本地分发失败，不抛错，且报出是哪个工具"，
// 而不是 INVALID_ARGS 的翻译——未知工具名是本地的分发失败，不是桥的错误码，
// 名字若谎报成 INVALID_ARGS，后来者会以为已有覆盖而不再补。
test('dispatchTool 对未知工具名返回错误文本且不抛错', async () => {
  const r = await M.dispatchTool('nope', {}, async () => P.makeRes('x', {}));
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /nope/, '错误文本必须报出是哪个工具名，否则模型无从纠正');
  assert.ok(!r.content[0].text.includes(P.ERROR_CODES.INVALID_ARGS),
    '未知工具名属本地分发失败，不该谎报成桥的 INVALID_ARGS');
});

// 缺 action 时若不拦，请求会带着 "dev.undefined" 上路，页面只能回 OP_UNSUPPORTED，
// 而那句翻译建议"请让用户刷新页面"——拿调用方的参数错误去让用户刷新，是错误文字
// 里最坏的一种。必须在本地拦住，让模型看到的是自己少传了参数。
test('dev_serial 缺 action 时本地报参数错误，不发出 dev.undefined', async () => {
  const calls = [];
  const request = async (d, o, a) => { calls.push([d, o, a]); return P.makeRes('x', {}); };
  const r = await M.dispatchTool('dev_serial', {}, request);

  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /action/, '必须点出缺的是 action 参数');
  assert.ok(!r.content[0].text.includes('刷新页面'),
    '这是调用方的参数错误，不该建议用户刷新页面');
  assert.deepStrictEqual(calls, [], '本地就该拦住，不发出注定 OP_UNSUPPORTED 的请求');
});

test('dispatchTool 把桥的错误码翻译成自然语言', async () => {
  const request = async (d, o, a) =>
    P.makeErr('x', P.ERROR_CODES.PAGE_NOT_CONNECTED, '页面未连接');
  const r = await M.dispatchTool('serial_read', {}, request);
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /localhost/);
});

test('dispatchTool 成功时返回 JSON 文本内容', async () => {
  const request = async () => P.makeRes('x', { connected: true });
  const r = await M.dispatchTool('webterm_status', {}, request);
  assert.ok(!r.isError);
  assert.match(r.content[0].text, /"connected": true/);
});

test('serial_read 的默认行数来自协议常量而非硬编码', () => {
  const t = M.buildTools().find(x => x.name === 'serial_read');
  assert.strictEqual(t.inputSchema.properties.max.default, P.READ_DEFAULT_LINES);

  // 上面那条断言今天抓不到"硬编码"：该常量恰好等于 50，写成字面量 50 也照样
  // 通过——它只抓将来的漂移（常量改成 60 而工具仍写 50）。要让名字成真、在有人
  // 硬编码的那一刻就变红，只能读源码。
  const block = extractToolBlock('serial_read');
  assert.ok(block, '应能提取到 serial_read 的工具定义块，否则本断言形同虚设');
  assert.match(block, /P\.READ_DEFAULT_LINES/, '默认值必须引用协议常量');

  // 先抠掉字符串字面量再找数字：描述里本就有"大于 0"这类数字，不抠会假红。
  const codeOnly = block.replace(/'[^']*'/g, "''");
  const numerics = codeOnly.match(/\b\d+(?:\.\d+)?\b/g) || [];
  assert.deepStrictEqual(numerics, [], '工具块内出现裸数字字面量: ' + numerics.join(', '));
});

// ════════════════════════════════════════════════════════
// 结构性断言（源码级）——锁死"错误码常量不被写成字面量"
// ════════════════════════════════════════════════════════
// 为什么非做源码级断言不可：ERROR_CODES 的键与值同名，把
// P.ERROR_CODES.PAGE_ERROR 改回 'PAGE_ERROR' 行为完全一致，任何行为断言都
// 抓不到；而一旦协议里改了名，字面量不会跟着走，translateError 会查不到而
// 静默退化成兜底文案。（基础设施见文件顶部）

test('兜底错误码取自 P.ERROR_CODES 而非字符串字面量', () => {
  const body = extractFn('dispatchTool');
  assert.ok(body, '应能提取到 dispatchTool 的函数体，否则本断言形同虚设');

  assert.match(body, /P\.ERROR_CODES\.PAGE_ERROR/, '兜底码必须引用 P.ERROR_CODES.PAGE_ERROR');
  assert.ok(!/['"]PAGE_ERROR['"]/.test(serverSrc), "源码中不得出现 'PAGE_ERROR' 字面量");

  // 函数体内不得出现任何 SCREAMING_SNAKE_CASE 字符串字面量：该形状在本文件里
  // 只可能是错误码，而错误码必须来自 bridge-protocol.js。
  const literals = body.match(/'[^']*'|"[^"]*"/g) || [];
  const screaming = literals.filter(s => /^['"][A-Z][A-Z0-9_]{2,}['"]$/.test(s));
  assert.deepStrictEqual(screaming, [], '出现硬编码的错误码字面量: ' + screaming.join(', '));
});
