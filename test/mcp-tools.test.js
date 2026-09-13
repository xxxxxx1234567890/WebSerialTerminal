// test/mcp-tools.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../mcp-server.js');
const P = require('../bridge-protocol.js');

test('工具清单数量与命名稳定', () => {
  const names = M.buildTools().map(t => t.name);
  assert.deepStrictEqual(names, [
    'webterm_status', 'serial_connect', 'serial_disconnect', 'serial_send', 'serial_read',
    'modbus_control', 'modbus_request', 'modbus_log',
    'ui_action', 'ui_inspect', 'dev_serial',
  ]);
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

test('dispatchTool 对未知工具名返回 INVALID_ARGS 而非抛错', async () => {
  const r = await M.dispatchTool('nope', {}, async () => P.makeRes('x', {}));
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /nope/);
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
});
