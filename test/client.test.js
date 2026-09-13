// WebSerialTerminal.html 的结构与行为回归测试（零依赖，用 node:test）
//
// 说明：该 HTML 是浏览器端代码，没有 DOM 测试环境。这里做两类断言：
//   1) 结构性断言（源码级），用于锁死"修复不被改回去"
//   2) 行为断言，针对能脱离 DOM 独立验证的纯逻辑（编码/解码）
// 真实的降级链 UI 流程仍需手工或 E2E 验证。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'WebSerialTerminal.html');
const html = fs.readFileSync(SRC, 'utf8');

const FFFD = String.fromCharCode(0xFFFD);

/** 按大括号配对提取函数体（模板字面量里的 ${ } 会自然抵消） */
function extractFn(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (!depth) return html.slice(start, i + 1); }
  }
  return '';
}

// ════════════════════════════════════════════════════════
// 一、日志乱码修复的回归防护
// ════════════════════════════════════════════════════════

test('日志内容统一前置 UTF-8 BOM', () => {
  const build = extractFn('buildLogPayload');
  assert.ok(build, '应存在 buildLogPayload()');
  assert.match(build, /'\\uFEFF'\s*\+/, '内容必须以 \\uFEFF 开头');
});

test('BOM 落盘后文件头为 EF BB BF', () => {
  const content = '14:22:01 ·· 已连接 COM3\n14:22:03 RX 温度:25.6℃ 状态正常';
  const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(content, 'utf8')]);
  assert.deepStrictEqual([...buf.slice(0, 3)], [0xEF, 0xBB, 0xBF]);
  assert.strictEqual(buf.toString('utf8').slice(1), content, 'BOM 之后内容不应改变');
});

test('readLoop 使用单个流式解码器，不在循环内新建', () => {
  const readLoop = extractFn('readLoop');
  assert.ok(readLoop, '应能提取到 readLoop()');
  assert.doesNotMatch(readLoop, /new TextDecoder\([^)]*\)\s*\.\s*decode\(/,
    '不得在每个数据块内新建 TextDecoder');
  assert.match(readLoop, /stream\s*:\s*true/, '必须使用 { stream: true } 续接');
});

test('readLoop 在两处字节流断点 flush 解码器', () => {
  const readLoop = extractFn('readLoop');
  const flushes = (readLoop.match(/rxDecoder\.decode\(\);/g) || []).length;
  assert.strictEqual(flushes, 2, '暂停分支与 HEX 分支各需一次 flush，实际 ' + flushes);
});

test('行为：分包切断汉字后可完整还原', () => {
  const bytes = new TextEncoder().encode('温度:25.6℃ 正常\n');
  const dec = new TextDecoder('utf-8', { fatal: false });
  const out = dec.decode(bytes.slice(0, 12), { stream: true })
            + dec.decode(bytes.slice(12), { stream: true });
  assert.strictEqual(out, '温度:25.6℃ 正常\n');
});

test('行为：断点 flush 消除凭空出现的替换符', () => {
  const P1 = new Uint8Array([0xE4, 0xBD]); // '你' 的前两字节
  const P2 = new Uint8Array([0x41, 0x42]); // 恢复后的 'AB'

  const noFlush = new TextDecoder('utf-8', { fatal: false });
  const withStale = noFlush.decode(P1, { stream: true }) + noFlush.decode(P2, { stream: true });
  assert.ok(withStale.includes(FFFD), '对照：不 flush 会产生替换符');

  const yesFlush = new TextDecoder('utf-8', { fatal: false });
  let out = yesFlush.decode(P1, { stream: true });
  yesFlush.decode(); // flush
  out += yesFlush.decode(P2, { stream: true });
  assert.ok(!out.includes(FFFD), 'flush 后不应有替换符');
  assert.strictEqual(out, 'AB');
});

test('行为：残留半字符不会吞掉任何 ASCII 字节', () => {
  let lost = 0;
  for (const pre of [[0xE4], [0xE4, 0xBD], [0xF0, 0x9F], [0xF0, 0x9F, 0x98], [0xC3]]) {
    for (let x = 0; x < 0x80; x++) {
      const d = new TextDecoder('utf-8', { fatal: false });
      let o = d.decode(new Uint8Array(pre), { stream: true });
      o += d.decode(new Uint8Array([x]), { stream: true });
      if (!o.includes(String.fromCharCode(x))) lost++;
    }
  }
  assert.strictEqual(lost, 0, '不应吞掉字节');
});

test('blob URL 延后回收，且延迟为具名常量', () => {
  const fn = extractFn('saveViaDownload');
  assert.ok(fn, '应存在 saveViaDownload()');
  const iClick = fn.indexOf('.click()');
  const iRevoke = fn.indexOf('URL.revokeObjectURL');
  assert.ok(iClick > 0 && iRevoke > iClick, 'revoke 应位于 click 之后');
  assert.match(fn, /setTimeout\s*\([\s\S]*URL\.revokeObjectURL/, 'revoke 必须延后执行');
  assert.match(html, /BLOB_URL_REVOKE_DELAY_MS\s*=\s*\d+/, '延迟应使用具名常量');
});

// ════════════════════════════════════════════════════════
// 二、日志保存目录（三级降级）
// ════════════════════════════════════════════════════════

test('settings 存在 logDir 字段且随 wtp_settings 持久化', () => {
  const m = html.match(/let settings = \{[\s\S]*?\};/);
  assert.ok(m, '应能提取到 settings 对象');
  assert.match(m[0], /logDir\s*:/, 'settings 应包含 logDir');
  assert.match(extractFn('saveState'), /wtp_settings/, 'logDir 应随 settings 一起落盘');
});

test('saveLog 为 async 入口，按序做三级降级', () => {
  assert.match(html, /async function saveLog\s*\(/, 'saveLog 必须是 async 函数');
  const saveLog = extractFn('saveLog');
  const iServer = saveLog.indexOf('saveViaServer');
  const iDir = saveLog.indexOf('saveViaDirectory');
  const iDown = saveLog.indexOf('saveViaDownload');
  assert.ok(iServer > 0 && iDir > iServer && iDown > iDir,
    '降级顺序应为 服务端 → 浏览器目录 → 下载，实际位置 ' + [iServer, iDir, iDown].join('/'));
});

test('一级：服务端静默写盘，且携带授权头', () => {
  const fn = extractFn('saveViaServer');
  assert.ok(fn, '应存在 saveViaServer()');
  assert.match(fn, /\/api\/save-log|SAVE_LOG_ENDPOINT/, '应请求保存接口');
  assert.match(fn, /X-WebTerm|SAVE_LOG_HEADER/, '必须携带自定义授权头');
  assert.match(fn, /settings\.logDir/, '应使用配置的目录');
});

test('二级：File System Access 目录句柄写入', () => {
  const fn = extractFn('saveViaDirectory');
  assert.ok(fn, '应存在 saveViaDirectory()');
  assert.match(fn, /createWritable/, '应使用 createWritable 写入');
  assert.match(fn, /requestPermission/, '未授权时应重新申请（在用户手势内）');
  assert.match(html, /showDirectoryPicker/, '应能通过 showDirectoryPicker 选择目录');
});

test('三级：<a download> 兜底保留', () => {
  const fn = extractFn('saveViaDownload');
  assert.ok(fn, '应存在 saveViaDownload()');
  assert.match(fn, /URL\.createObjectURL/, '应保留 blob URL');
  assert.match(fn, /\.download\s*=/, '应保留 download 属性');
});

test('目录句柄用 IndexedDB 持久化', () => {
  assert.match(html, /indexedDB\.open/, '应使用 IndexedDB 保存目录句柄');
  assert.match(extractFn('pickLogDirectory'), /showDirectoryPicker/, '选择目录按钮应调用 showDirectoryPicker');
  assert.match(extractFn('resetLogDirectory'), /delLogDirHandle|delete|remove|clear/, '恢复默认应清除句柄');
});

test('设置弹窗暴露 logDir 输入与选择/重置按钮', () => {
  assert.match(html, /id="logDir"/, '应有 logDir 输入框');
  assert.match(html, /onclick="pickLogDirectory\(\)"/, '应有选择目录按钮');
  assert.match(html, /onclick="resetLogDirectory\(\)"/, '应有恢复默认按钮');
});

test('openSettings / applySettings 同步 logDir', () => {
  assert.match(extractFn('openSettings'), /logDir/, 'openSettings 应回填 logDir');
  assert.match(extractFn('applySettings'), /logDir/, 'applySettings 应保存 logDir');
});

// ════════════════════════════════════════════════════════
// 三、属性注入（自我 XSS）回归防护
//
// 反例：onclick="fn('${变量}')" —— 属性用双引号包裹却只转义单引号，
// 变量里含 " 即可闭合属性逃逸。同源 XSS 现在还能调用 /api/save-log 写文件，
// 所以这两处必须锁死。
// ════════════════════════════════════════════════════════

test('不存在把变量拼进内联事件属性的写法', () => {
  // 通用反例扫描：内联事件属性值里出现 ${ }
  const hits = html.match(/on\w+="[^"]*\$\{[^"]*"/g) || [];
  assert.deepStrictEqual(hits, [],
    '不应把变量拼进内联事件属性：' + hits.join('  |  '));
  assert.doesNotMatch(html, /onclick="selectHistory\(/, '历史项不应使用内联 onclick');
  assert.doesNotMatch(html, /onclick="sendData\(/, '宏按钮不应使用内联 onclick');
});

test('历史下拉用 DOM API 构建，文本走 textContent', () => {
  const fn = extractFn('handleInputChange');
  assert.ok(fn, '应能提取到 handleInputChange()');
  assert.match(fn, /createElement\('div'\)/, '应创建 DOM 节点');
  assert.match(fn, /textContent = m/, '历史项文本应走 textContent');
  assert.match(fn, /addEventListener\('click'/, '应使用 addEventListener 绑定');
  assert.doesNotMatch(fn, /innerHTML = matches/, '不应把匹配项拼进 innerHTML');
});

test('宏列表用 DOM API 构建，命令不烘进属性', () => {
  const fn = extractFn('renderMacros');
  assert.ok(fn, '应能提取到 renderMacros()');
  assert.match(fn, /makeMacroInput|createElement\('input'\)/, '应用 DOM API 建输入框');
  assert.match(fn, /makeMacroButton|createElement\('button'\)/, '应用 DOM API 建按钮');
  assert.doesNotMatch(fn, /div\.innerHTML/, '不应给宏项赋 innerHTML');
});

test('已移除 escapeJs（只转义单引号，易被误用为属性转义）', () => {
  assert.doesNotMatch(html, /function escapeJs/, '不应再保留 escapeJs');
  assert.match(html, /function escapeHtml/, 'escapeHtml 仍被 Modbus 日志使用，应保留');
});

// ════════════════════════════════════════════════════════
// 四、串口 seam 回归防护
//
// AI 桥的假串口方案依赖"所有串口都经 serialProvider 获取"这条不变式。
// 后续若有人图省事写回 navigator.serial.requestPort()，这条测试必须立刻变红——
// 否则假设备会静默失效，测试却依然全绿。
// ════════════════════════════════════════════════════════

test('navigator.serial 只在 seam 定义处被引用', () => {
  const hits = html.match(/navigator\.serial\.[A-Za-z]+\s*\(/g) || [];
  assert.strictEqual(hits.length, 2,
    '应只有 serialProvider 定义处的 requestPort 与 getPorts，实际: ' + hits.join(' | '));
});

test('serialProvider 声明为可重新赋值（let，而非 const）', () => {
  // bridge-client.js 需要在切换假设备时重新赋值，const 会静默失败
  assert.match(html, /let\s+serialProvider\s*=/, '必须以 let 声明 serialProvider');
  assert.doesNotMatch(html, /const\s+serialProvider\s*=/, '不能是 const');
});

test('两处取端口都改走 serialProvider', () => {
  const connect = extractFn('connectPort');
  assert.ok(connect, '应存在 connectPort()');
  assert.match(connect, /serialProvider\.requestPort\(\)/, 'connectPort 必须走 seam');

  const modbusConnect = extractFn('modbusConnectPort');
  assert.ok(modbusConnect, '应存在 modbusConnectPort()');
  assert.match(modbusConnect, /serialProvider\.requestPort\(\)/, 'modbusConnectPort 必须走 seam');
});

test('seam 之外的串口逻辑未被改动', () => {
  // readLoop 的流式解码器与断点 flush 是既有的正确实现，本次不得触碰
  const readLoop = extractFn('readLoop');
  assert.match(readLoop, /stream\s*:\s*true/, '流式解码器不得被改动');
  assert.strictEqual((readLoop.match(/rxDecoder\.decode\(\);/g) || []).length, 2,
    '两处断点 flush 不得被改动');

  const disconnect = extractFn('disconnectPort');
  assert.match(disconnect, /isConnected = false/, '断开必须先置标志位');
  assert.match(disconnect, /reader\.cancel\(\)/, '断开依赖 cancel 解阻塞 readLoop');
});
