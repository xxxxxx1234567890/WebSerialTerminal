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
// 后续若有人图省事在 seam 之外新写一处 navigator.serial.requestPort()，这条测试必须
// 立刻变红——否则假设备会静默失效，测试却依然全绿。
// 注意它的边界：本组断言抓的是"净增一处直调"与"seam 被掏空却仍留着直调"。
// 完整回退（seam 整个删掉 + 两个调用点写回）会让命中数仍是 2，单看计数分辨不出，
// 要靠下面"两处取端口都改走 serialProvider"那条来抓。
// ════════════════════════════════════════════════════════

test('navigator.serial 只在 seam 定义处被引用', () => {
  // 只数个数是不够的：完整回退（seam 整个删掉 + 两个调用点写回直调）同样是 2 次命中，
  // 光看总数分辨不出。因此这里额外验证这 2 次命中确实落在 seam 块内部——
  // 防的是"净增一处直调"和"seam 被掏空但仍留下 2 个裸调用"两种退化。
  const a = html.indexOf('window.realSerialProvider');
  assert.ok(a > 0, '应存在 realSerialProvider seam 定义');
  const b = html.indexOf('let serialProvider = window.realSerialProvider;', a);
  assert.ok(b > a, 'seam 应以 let serialProvider = window.realSerialProvider; 收尾');
  const seam = html.slice(a, b);

  const inSeam = seam.match(/navigator\.serial\.[A-Za-z]+\s*\(/g) || [];
  assert.strictEqual(inSeam.length, 2,
    'seam 内应恰有 requestPort 与 getPorts 两处引用，实际: ' + inSeam.join(' | '));

  const hits = html.match(/navigator\.serial\.[A-Za-z]+\s*\(/g) || [];
  assert.strictEqual(hits.length, inSeam.length,
    'seam 之外不得再直调 navigator.serial，实际: ' + hits.join(' | '));
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

// ════════════════════════════════════════════════════════
// 五、AI 桥依赖的页面函数必须都存在
//
// bridge-client.js 通过全局函数名驱动页面。名字一旦漂移，
// 对应的 MCP 工具会退化成"永远超时"，比直接报错更难排查。
// ════════════════════════════════════════════════════════

const BRIDGE_REQUIRED_API = [
  'connectPort', 'disconnectPort', 'clearTerminal', 'togglePause', 'toggleSidebar',
  'sendData', 'saveLog', 'applySettings', 'saveState', 'appendLine',
  'modbusSetMode', 'modbusConnectPort', 'modbusDisconnectPort', 'modbusToggleActive',
  'modbusStartCycle', 'modbusStopCycle', 'modbusSend', 'modbusConstructFrame',
  'modbusShowResponse', 'modbusAddLog', 'modbusParseAddress', 'modbusViewSyncAddrMode',
];

test('AI 桥依赖的页面全局函数全部存在', () => {
  const missing = BRIDGE_REQUIRED_API.filter(n => !new RegExp(`function\\s+${n}\\s*\\(`).test(html));
  assert.deepStrictEqual(missing, [], '以下函数被重命名或删除，AI 桥会静默失效: ' + missing.join('、'));
});

test('Modbus 结果截获点存在（modbus.request 依赖它们）', () => {
  // 这两个函数被 bridge-client.js 包装以截获解析结果；
  // 它们消失会让 modbus.request 每次都要等到 1500ms 超时
  assert.match(html, /function\s+modbusShowResponse\s*\(/, 'modbusShowResponse 是成功/异常/CRC 错误的截获点');
  assert.match(html, /function\s+modbusAddLog\s*\(/, 'modbusAddLog 是超时结局的唯一截获点');
});

test('宏对象结构为 {label, cmd}（AI 的 run_macro 依赖此形状）', () => {
  const fn = extractFn('addMacro');
  assert.match(fn, /label\s*:/, '宏应有 label 字段');
  assert.match(fn, /cmd\s*:/, '宏应有 cmd 字段');
});

test('settings 主题字段名为 colorTheme（ui.action set_theme 依赖）', () => {
  const m = html.match(/let settings = \{[\s\S]*?\};/);
  assert.ok(m, '应能提取到 settings 对象');
  assert.match(m[0], /colorTheme\s*:/, 'settings 应含 colorTheme（不是 theme）');
  assert.match(m[0], /fontSize\s*:/, 'settings 应含 fontSize');
});

test('HEX 显示开关是 #chkHex 复选框（ui.inspect 依赖）', () => {
  // 注意与 #chkHexInput 区分：后者管输入模式，前者管显示模式
  assert.match(html, /id="chkHex"/, '应存在 #chkHex（显示模式）');
  assert.match(html, /id="chkHexInput"/, '应存在 #chkHexInput（输入模式）');
});

// ════════════════════════════════════════════════════════
// 六、AI 桥的接线（武装开关 / 输出钩子 / 脚本加载）
// ════════════════════════════════════════════════════════

test('appendLine 末尾把渲染后的文本灌进桥的环形缓冲', () => {
  // 必须在末尾追加：AI 读到的应是"真实渲染过的那一行"，
  // 位置若提前，HEX 视图拼装与 ANSI 解析的结果就取不到了
  const fn = extractFn('appendLine');
  assert.ok(fn, '应能提取到 appendLine()');
  const iHook = fn.indexOf('bridgeNoteOutput');
  const iStatus = fn.indexOf("getElementById('statusLines')");
  assert.ok(iStatus > 0, '应能定位到先于钩子的状态栏更新');
  assert.ok(iHook > iStatus, '钩子必须追加在函数末尾（状态栏更新之后）');
  assert.match(fn.slice(iHook), /bridgeNoteOutput\(text\)/,
    '钩子必须传 text——appendLine 的签名是 (type, text, autoScroll)，只传 type 会喂错内容');
});

test('武装开关 UI 存在且默认关闭', () => {
  // 复选框不能带 checked：默认必须是"AI 只读"，写入要人显式开启
  const m = html.match(/<input[^>]*id="aiArmedToggle"[^>]*>/);
  assert.ok(m, '侧栏应有 #aiArmedToggle 复选框');
  assert.doesNotMatch(m[0], /\bchecked\b/, '默认不得勾选');
  assert.match(html, /id="aiArmedHint"/, '应有一处文字提示当前状态');
});

test('武装状态用独立键，不塞进 wtp_settings', () => {
  // saveState() 按 settings 的固定字段整体回写 wtp_settings，
  // 往里塞额外字段会被下一次保存覆盖，开关状态就会莫名丢失
  const saveState = extractFn('saveState');
  assert.match(saveState, /wtp_settings/, 'saveState 仍应保存 settings');
  assert.doesNotMatch(saveState, /wtp_ai_armed/, 'saveState 不该管武装开关');
  assert.doesNotMatch(html, /wtp_ai_armed/, '武装状态由 bridge-client.js 用独立键管理');
});

test('桥脚本按 bridge-protocol → fake-serial → bridge-client 的顺序加载', () => {
  // fake-serial.js 在加载时就解构 root.BridgeProtocol.hexToBytes，
  // 顺序错了 <script> 整块失败，且只表现为"假设备莫名其妙不可用"
  const iProto = html.indexOf('<script src="bridge-protocol.js">');
  const iFake = html.indexOf('<script src="fake-serial.js">');
  const iClient = html.indexOf('<script src="bridge-client.js">');
  assert.ok(iProto > 0 && iFake > iProto && iClient > iFake,
    '三个 script 必须是 protocol → fake → client 的先后顺序，实际 ' + [iProto, iFake, iClient].join('/'));
});

// ════════════════════════════════════════════════════════
// 七、PORT_BUSY 文案的事实依据
//
// mcp-server.js 的 PORT_BUSY 文案与 docs/serial-mcp-bridge.md §6 都断言
// 「切到 shared 会断开独立串口、腾出端口」。这不是修辞而是页面行为，
// 所以钉行为、不钉文案：一旦页面不再断开，"腾出端口"就成了假话，
// 而这句话此前正是以"无任何测试断言"的方式活在两个交付物里。
// ════════════════════════════════════════════════════════

test('离开 independent 模式会断开 Modbus 独立串口（PORT_BUSY 文案的事实依据）', () => {
  const setMode = extractFn('modbusSetMode');
  assert.ok(setMode, '应存在 modbusSetMode()');
  assert.match(setMode, /modbusPortMode\s*===\s*'independent'[\s\S]*?modbusDisconnectPort\s*\(/,
    '离开 independent 必须调用 modbusDisconnectPort()；否则 PORT_BUSY 文案不得再声称"切 shared 会腾出端口"');

  // 断开必须真的关上串口。只调函数名不关端口的话，"腾出端口"同样不成立。
  const disconnect = extractFn('modbusDisconnectPort');
  assert.ok(disconnect, '应存在 modbusDisconnectPort()');
  assert.match(disconnect, /modbusPort\.close\(\)/,
    'modbusDisconnectPort 必须关闭 modbusPort，"腾出端口"才成立');
});

// ════════════════════════════════════════════════════════
// 八、appendLine 调用形态的防护
//
// appendLine(type, text, autoScroll) 的 type 一身三职：拼进 CSS 类名
// （line.className / line-dir / line-content）、门控时间戳（type !== 'sys'），
// 而 text 又经函数末尾的输出钩子进入桥的 AI 读缓冲。
// 两个实参一旦写反（appendLine('<消息>', 'error')），后果是三重且都不报错：
//   1) 类名变成消息文本，样式全部落空；
//   2) 本该显示消息的位置收到字面量 'error'，真正的消息丢失；
//   3) AI 读缓冲里躺着的也是 'error'，它看到的是错误信息本身而非内容。
// 这里钉的是调用形态，不是文案：消息内容可以随时改，首个实参的取值域不行。
// ════════════════════════════════════════════════════════

const BACKSLASH = String.fromCharCode(92); // 反斜杠，避免多层转义

/** 跳过一段字符串字面量（含转义），返回收尾引号的下标 */
function skipString(src, i, quote) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === BACKSLASH) { j++; continue; }
    if (src[j] === quote) return j;
  }
  return src.length - 1;
}

/** 跳过一段模板字面量，${ } 内的嵌套字符串/花括号一并跳过 */
function skipTemplate(src, i) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === BACKSLASH) { j++; continue; }
    if (src[j] === '`') return j;
    if (src[j] === '$' && src[j + 1] === '{') {
      let depth = 1;
      j += 2;
      while (j < src.length && depth > 0) {
        const c = src[j];
        if (c === BACKSLASH) { j += 2; continue; }
        if (c === "'" || c === '"') { j = skipString(src, j, c); }
        else if (c === '{') { depth++; }
        else if (c === '}') { depth--; }
        j++;
      }
      j--;
    }
  }
  return src.length - 1;
}

/**
 * 按 JS 词法取出一对圆括号内「首个顶层实参」的源码文本。
 * 跟踪圆括号/方括号/花括号深度与字符串、模板字面量状态，
 * 因此跨行调用、以及实参里含逗号（数组、对象、模板串）都能正确切分。
 */
function readFirstArg(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipString(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 1; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { if (depth === 0) return src.slice(start, i).trim(); depth--; continue; }
    if (c === ',' && depth === 0) return src.slice(start, i).trim();
  }
  return src.slice(start).trim();
}

/**
 * 枚举源码里全部 appendLine() 调用点。
 * 匹配 `appendLine` + 可选空白 + `(`（因此跨行调用不会被漏掉），
 * 并跳过 `function appendLine(` 定义本身——那里的首参是形参而非类型令牌。
 * 注意：取不到实参时返回空串，会被下面的断言当作违规，是 fail-closed 的。
 */
function enumerateAppendLineCalls(src) {
  const calls = [];
  const re = /appendLine\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
    calls.push({
      line: src.slice(0, m.index).split('\n').length,
      arg: readFirstArg(src, m.index + m[0].length),
    });
  }
  return calls;
}

test('appendLine 调用的首个实参必须是已知类型令牌', () => {
  // 取值域来自 appendLine 内实际分派的类型：dirMap = { rx, tx, sys, err }。
  // 没有 'error' 这个类型——旧代码把它当第二实参传，才没能拦住写反。
  const KNOWN_TYPES = ['sys', 'rx', 'err', 'tx'];

  // 非字面量首参的显式豁免：新增此类调用点必须在此登记，否则本测试失败。
  // printWelcome() 用一张 [{type,text}] 表批量输出欢迎语，type 来自表数据
  // （该表字面量见其函数体，取值仅 'sys'/'rx'），无法在此静态求值。
  const NON_LITERAL_EXEMPT = ['l.type'];

  const calls = enumerateAppendLineCalls(html);

  // 兜底：枚举器若失效（正则写坏、文件读取为空），下面的 violations 会空集通过。
  // 用调用点数量下限挡住这种"假绿灯"。
  assert.ok(calls.length >= 20,
    `枚举到的 appendLine 调用点过少（${calls.length}），枚举器可能已失效`);

  const violations = calls.filter(c => {
    const literal = /^'([^']*)'$/.exec(c.arg);
    if (literal) return !KNOWN_TYPES.includes(literal[1]);
    return !NON_LITERAL_EXEMPT.includes(c.arg); // 非字面量：只认显式豁免
  }).map(c => `第 ${c.line} 行 appendLine(${c.arg}, ...)`);

  assert.deepStrictEqual(violations, [],
    '首个实参只能是 ' + KNOWN_TYPES.join('/') + ' 之一；' +
    '写成 appendLine(\'<消息>\', \'error\') 会把消息当类名、正文变成字面量 error（并喂进 AI 读缓冲）');
});

