const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../bridge-auth.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-auth-'));

test('baseDir 优先取 WEBTERM_HOME，否则回退用户目录', () => {
  assert.strictEqual(A.baseDir({ WEBTERM_HOME: 'D:\\tmp\\wt' }), 'D:\\tmp\\wt');
  assert.strictEqual(A.baseDir({}), os.homedir());
});

test('tokenPath 落在 <dir>/.webterm/bridge-token', () => {
  assert.strictEqual(A.tokenPath('/x'), path.join('/x', '.webterm', 'bridge-token'));
});

test('generateToken 为 64 字符 hex 且每次不同', () => {
  const a = A.generateToken(), b = A.generateToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(a, b);
});

test('writeToken 创建目录与文件并可被 readToken 读回', () => {
  const dir = tmp();
  const { token, filePath } = A.writeToken(dir);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), token);
  assert.strictEqual(A.readToken(dir), token);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeToken 每次覆盖旧 token', () => {
  const dir = tmp();
  const first = A.writeToken(dir).token;
  const second = A.writeToken(dir).token;
  assert.notStrictEqual(first, second);
  assert.strictEqual(A.readToken(dir), second);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readToken 缺失时抛可操作的中文错误', () => {
  const dir = tmp();
  assert.throws(() => A.readToken(dir), /请先启动 server\.js/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tokenEquals 长度不等返回 false 而不抛', () => {
  // timingSafeEqual 对不等长输入会抛，必须先挡——否则桥会因为一个短 token 崩掉
  assert.strictEqual(A.tokenEquals('abc', 'abcd'), false);
  assert.strictEqual(A.tokenEquals('', 'a'), false);
  assert.strictEqual(A.tokenEquals('abcd', 'abcd'), true);
  assert.strictEqual(A.tokenEquals('abcd', 'abce'), false);
});

test('tokenEquals 对非字符串输入返回 false', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.strictEqual(A.tokenEquals(bad, 'abcd'), false);
    assert.strictEqual(A.tokenEquals('abcd', bad), false);
  }
});
