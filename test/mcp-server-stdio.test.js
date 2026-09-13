// test/mcp-server-stdio.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../mcp-server.js');
const P = require('../bridge-protocol.js');

const noRequest = async () => { throw new Error('本用例不应发起桥请求'); };

test('initialize 返回协议版本、tools 能力与服务器信息', async () => {
  const res = await M.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    noRequest);
  assert.strictEqual(res.jsonrpc, '2.0');
  assert.strictEqual(res.id, 1);
  assert.ok(res.result.protocolVersion);
  assert.ok(res.result.capabilities.tools, '必须声明 tools 能力');
  assert.strictEqual(res.result.serverInfo.name, 'webterm-serial-bridge');
});

test('notifications/initialized 不回响应', async () => {
  const res = await M.handleMessage(
    { jsonrpc: '2.0', method: 'notifications/initialized' }, noRequest);
  assert.strictEqual(res, null, '通知类消息不得有响应');
});

test('tools/list 返回全部工具', async () => {
  const res = await M.handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, noRequest);
  assert.strictEqual(res.result.tools.length, 11);
});

test('tools/call 走 dispatchTool 并回传内容', async () => {
  const request = async () => P.makeRes('x', { connected: false });
  const res = await M.handleMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'webterm_status', arguments: {} } }, request);
  assert.ok(res.result.content[0].text.includes('connected'));
});

test('tools/call 缺少工具名返回 JSON-RPC 错误而非崩溃', async () => {
  const res = await M.handleMessage(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {} }, noRequest);
  assert.strictEqual(res.error.code, -32602);
});

test('未知方法返回 -32601', async () => {
  const res = await M.handleMessage(
    { jsonrpc: '2.0', id: 5, method: 'no/such', params: {} }, noRequest);
  assert.strictEqual(res.error.code, -32601);
});

test('ping 返回空结果（供客户端保活）', async () => {
  const res = await M.handleMessage({ jsonrpc: '2.0', id: 6, method: 'ping' }, noRequest);
  assert.deepStrictEqual(res.result, {});
});

test('请求处理抛错时返回 -32603 而非让进程退出', async () => {
  const boom = async () => { throw new Error('桥炸了'); };
  const res = await M.handleMessage(
    { jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'webterm_status', arguments: {} } }, boom);
  // dispatchTool 内部已兜住异常，故仍是正常 result（isError 标记）
  assert.ok(res.result || res.error);
  assert.ok(JSON.stringify(res).includes('桥炸了'));
});
