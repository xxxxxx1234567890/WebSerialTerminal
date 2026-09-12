// 桥的适配器侧鉴权。token 每会话重新生成、写在仓库之外，
// 且不放进环境变量——环境变量会随进程树泄漏给无关子进程。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TOKEN_DIR = '.webterm';
const TOKEN_FILE = 'bridge-token';
const TOKEN_BYTES = 32;

/** WEBTERM_HOME 是测试 seam：测试写临时目录，不污染真实用户目录 */
const baseDir = (env = process.env) => env.WEBTERM_HOME || os.homedir();

const tokenPath = (dir = baseDir()) => path.join(dir, TOKEN_DIR, TOKEN_FILE);

const generateToken = () => crypto.randomBytes(TOKEN_BYTES).toString('hex');

function writeToken(dir = baseDir()) {
  const token = generateToken();
  const filePath = tokenPath(dir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, token, { encoding: 'utf8', mode: 0o600 });
  return { token, filePath };
}

function readToken(dir = baseDir()) {
  const filePath = tokenPath(dir);
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    // 静默重试会让 AI 看到一个永远连不上的工具，比直接报错更难排查
    throw new Error(`读不到桥 token（${filePath}）。请先启动 server.js（npm start）。`);
  }
}

/** timingSafeEqual 对不等长输入抛异常，长度必须先挡 */
function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = { baseDir, tokenPath, generateToken, writeToken, readToken, tokenEquals };
