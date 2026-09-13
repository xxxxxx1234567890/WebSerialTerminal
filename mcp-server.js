// mcp-server.js
// stdio MCP 适配器。手写 JSON-RPC 2.0（换行分隔），不引入 @modelcontextprotocol/sdk——
// 本项目零构建、依赖精简，而 MCP 的 stdio 传输核心只有 initialize/tools 两类消息。
const P = require('./bridge-protocol.js');

// ════ 工具定义 ════
// 描述里必须带操作指引：模型只能看到工具名/描述/schema，
// 协议层的约束（NEEDS_USER_GESTURE、dropped 语义）不写进去就等于不存在。
function buildTools() {
  return [
    {
      name: 'webterm_status',
      description: '获取 WebTerm 终端与 Modbus 两套串口栈的完整状态快照：连接状态、串口参数、收发字节统计、是否暂停、Modbus 模式（shared/independent）、是否正在轮询、终端是否被 Modbus 冻结、当前串口源是真实设备还是假设备。\n\n排查任何问题前应先调用本工具。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'serial_connect',
      description: '连接终端串口。优先使用浏览器已授权的端口自动连接，无需用户操作。\n\n若返回 NEEDS_USER_GESTURE：表示没有已授权端口，浏览器要求用户手势才能弹出串口选择框。此时重试无效——必须请用户手动点击页面上的"连接"按钮一次，之后即可自动重连。',
      inputSchema: {
        type: 'object',
        properties: { index: { type: 'number', description: '有多个已授权端口时指定用第几个，默认 0' } },
        additionalProperties: false,
      },
    },
    {
      name: 'serial_disconnect',
      description: '断开终端串口。若 Modbus 处于 shared 模式会被一并关闭，正在进行的轮询也会停止。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'serial_send',
      description: '向串口发送数据。\n\nencoding 说明：ascii 按 UTF-8 编码（中文可用）；hex 接受「01030000」或「01 03 00 00」两种写法；base64 为标准 base64。\n\n本次调用会被记入终端日志（前缀 [AI]），可用于事后追溯发往设备的内容。',
      inputSchema: {
        type: 'object',
        properties: {
          data: { type: 'string', description: '要发送的数据' },
          encoding: { type: 'string', enum: ['ascii', 'hex', 'base64'], default: 'ascii' },
        },
        required: ['data'],
        additionalProperties: false,
      },
    },
    {
      name: 'serial_read',
      description: '按游标读取终端输出。首次调用不传 cursor（从最旧可用位置开始）；之后必须传入上次返回的 cursor 以只取增量。\n\n务必检查 dropped 字段：大于 0 表示这段时间的输出量超过环形缓冲、该段数据已永久丢失。出现 dropped 时不要假设输出是连续的，应缩短读取间隔或缩小范围后重试。truncated 为 true 表示本次结果被 max 截断，可用返回值里的 cursor 继续读取后续内容。',
      inputSchema: {
        type: 'object',
        properties: {
          cursor: { type: 'number', description: '上次返回的 cursor，用于只取增量' },
          max: { type: 'number', description: '本次最多返回多少行', default: P.READ_DEFAULT_LINES },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'modbus_control',
      description: '控制 Modbus 调试面板。action 取值：\n- set_mode：切换串口模式，需同时给 mode（shared 复用终端串口 / independent 独立开串口）\n- connect / disconnect：独立模式下连接或断开自己的串口\n- activate / deactivate：启用或停用 Modbus 调试\n- cycle_start / cycle_stop：启停轮询发送\n\n重要：shared 模式下 activate 会「冻结终端」——终端输入框与发送按钮被禁用，目的是防止人工操作干扰 Modbus 报文时序。返回值里的 terminalFrozen 会标明此状态。用完请及时 deactivate 以恢复终端。\n\n同样重要：**shared 模式下 Modbus 只发得出去、收不回来**。冻结终端读循环与冻结响应解析是同一件事——响应字节会在终端暂停分支处被丢弃，页面因此永远等不到应答。所以凡是需要响应结果的操作（modbus_request、以及轮询的回读）都必须用 independent 模式：先 set_mode 到 independent，再 connect 独立串口。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['set_mode', 'connect', 'disconnect', 'activate', 'deactivate', 'cycle_start', 'cycle_stop'] },
          mode: { type: 'string', enum: ['shared', 'independent'], description: '仅 set_mode 时需要' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    {
      name: 'modbus_request',
      description: '发送一条语义化 Modbus RTU 请求并返回解析后的响应，CRC16 由页面自动计算。\n\n支持的功能码：01 读线圈、02 读离散输入、03 读保持寄存器、04 读输入寄存器、05 写单线圈、06 写单寄存器、15(0F) 写多线圈、16(10) 写多寄存器。\n\n返回值包含：请求与响应的完整 HEX 帧、响应时间、寄存器值（HEX/U16/I16/F32 多种格式，总是一次给全，无需再用参数指定格式）、线圈位图、以及异常码的中文描述。设备超时为 500ms，超时会明确标注。\n\n**必须在 independent 模式下调用**：shared 模式会冻结终端读循环，响应字节在解析前就被丢弃，本工具只能等到超时。写操作尤其危险——字节真的发到了线缆上，返回值却说"设备没响应"，据此重试就等于重复写。本工具在 shared 模式下会直接拒绝并说明，请先 modbus_control {action:"set_mode", mode:"independent"} 并 connect。\n\n写操作会直接改变设备状态，请确认目标地址无误。',
      inputSchema: {
        type: 'object',
        properties: {
          slaveId: { type: 'number', description: '从站 ID，1-247' },
          funcCode: { type: 'number', description: '功能码：1/2/3/4/5/6/15/16' },
          address: { type: 'number', description: '起始地址，0-65535' },
          quantity: { type: 'number', description: '读取或写入的数量' },
          writeData: { type: 'string', description: '写操作的数据（hex 字符串），读操作留空' },
        },
        required: ['slaveId', 'funcCode', 'address', 'quantity'],
        additionalProperties: false,
      },
    },
    {
      name: 'modbus_log',
      description: '读取 Modbus 历史报文日志（时间、功能码摘要、响应时间、状态）。',
      inputSchema: {
        type: 'object',
        properties: { max: { type: 'number', description: '最多返回多少条，默认 20，上限 100', default: 20 } },
        additionalProperties: false,
      },
    },
    {
      name: 'ui_action',
      description: '操作终端界面。action 取值：clear 清屏、pause 暂停显示、resume 继续显示、set_theme（需 theme）、set_font（需 size）、toggle_sidebar 折叠侧栏、run_macro（需 name，执行已保存的宏）、list_macros 列出宏名、save_log 保存终端日志到文件。\n\n警告：pause 期间到达的串口数据会被**直接丢弃**——页面在暂停时连解码器缓冲都不写入，该段字节既不渲染也不进读取缓冲，恢复后 serial_read 的 dropped 仍然是 0（也就是说它不会告诉你丢过东西），无法补读。需要一段不丢数据的观察窗口时，请改用 serial_read 主动拉取，不要 pause。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['clear', 'pause', 'resume', 'set_theme', 'set_font', 'toggle_sidebar', 'run_macro', 'list_macros', 'save_log'] },
          theme: { type: 'string', description: 'set_theme 时的主题名' },
          size: { type: 'number', description: 'set_font 时的字号' },
          name: { type: 'string', description: 'run_macro 时的宏名称' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    {
      name: 'ui_inspect',
      description: '检查终端当前的实际渲染结果——最后若干行的文本、每行计算后的颜色、是否处于 HEX 显示模式、当前主题与字号、是否暂停、侧栏是否折叠。\n\n用途：验证 ANSI 转义序列解析、关键字高亮、HEX 视图等显示逻辑是否按预期工作。这是需要「看渲染效果」时的唯一手段。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'dev_serial',
      description: '开发期假串口控制，用于在不接真实硬件的情况下测试完整串口链路。action 取值：\n- serial_source：切换串口源，需给 mode（real / fake）。切到 fake 前必须先断开真实串口\n- fake_inject：假设备向页面注入接收数据（需 data，可选 encoding）——数据会走完真实的 readLoop 解析路径\n- fake_capture：读回页面实际发送出去的字节（可选 clear 读完即清）\n- fake_script：设置「请求 → 应答」规则，让假设备自动应答（需 rules 数组，元素形如 {"matchHex":"0103000000","respondHex":"0103020064","delayMs":20}）。匹配为前缀匹配，首个命中的规则生效，命中后清空累积缓冲；未命中的请求不回注任何数据，可据此测试超时路径\n\n典型用法：切到 fake → fake_script 配好应答规则 → serial_connect → serial_send 发 Modbus 请求 → serial_read 读响应，全程无需硬件。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['serial_source', 'fake_inject', 'fake_capture', 'fake_script'] },
          mode: { type: 'string', enum: ['real', 'fake'] },
          data: { type: 'string' },
          encoding: { type: 'string', enum: ['ascii', 'hex', 'base64'], default: 'hex' },
          clear: { type: 'boolean' },
          rules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                matchHex: { type: 'string' }, respondHex: { type: 'string' }, delayMs: { type: 'number' },
              },
              required: ['matchHex', 'respondHex'],
            },
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  ];
}

// ════ 错误翻译 ════
// 工具结果是文本，模型读的是句子。必须把「该做什么」写进去，只报错误名会让 AI 反复重试。

/**
 * 页面该从哪里打开：由**实际连接的桥地址**推导，不写死 1982。
 * 文档支持 PORT=3000 配 WEBTERM_BRIDGE_URL 启动，写死会把用户指向一个没在跑的
 * 端口——AI 于是让用户去开一个打不开的地址，而真正的页面就在另一个端口上。
 * （BRIDGE_URL 声明在下方：本函数只在模块求值完成之后被调用，无 TDZ 问题。）
 */
const pageOrigin = () => {
  try {
    const u = new URL(BRIDGE_URL);
    return (u.protocol === 'wss:' ? 'https://' : 'http://') + u.host;
  } catch {
    return 'http://localhost:1982';
  }
};

const ERROR_TEXT = {
  NEEDS_USER_GESTURE: () => '✖ 无法连接：浏览器要求用户手动授权串口（首次连接必须真人点一下页面上的"连接"按钮）。重试不会有帮助——请让用户操作完成后再继续。',
  // 这条文案曾建议"切 Modbus 到 shared 复用终端端口"来腾出串口——那是一条死路：
  // shared 只让 Modbus 复用终端端口，既解决不了占用，而且 shared 模式下
  // modbus_request 收不到任何响应（终端读循环被冻结）。改为指向真正的占用方。
  PORT_BUSY: (m) => `✖ 串口被占用：${m}\n同一物理端口同一时刻只能被一套串口栈持有。请先断开占用方（serial_disconnect，或 modbus_control {action:"disconnect"}）再重试——重试本身不会让它变好。\n不要改用 shared 模式来绕开：它并不释放端口，而且 shared 模式下 modbus_request 收不到响应。`,
  PAGE_NOT_CONNECTED: () => `✖ 页面未连接。请确认用户已在浏览器打开 ${pageOrigin()} ，且页面上的桥连接正常。`,
  BRIDGE_TIMEOUT: (m) => `✖ 页面响应超时：${m}\n页面可能正忙或已卡死。可先用 webterm_status 判断页面是否还在响应。`,
  PORT_NOT_CONNECTED: (m) => `✖ 串口未连接：${m}\n请先调用 serial_connect。`,
  NOT_ARMED: () => '✖ AI 写入未启用。请让用户在页面上打开"允许 AI 写入"开关后重试。读取类操作（状态、读取输出）不受此限制，随时可用。',
  INVALID_ARGS: (m) => `✖ 参数有误：${m}`,
  OP_UNSUPPORTED: (m) => `✖ 操作不支持：${m}\n可能是页面版本较旧，请让用户刷新页面。`,
  PAGE_ERROR: (m) => `✖ 页面内部错误：${m}\n这通常是 WebTerm 自身的缺陷，请把该消息转告用户以便排查。`,
};

const translateError = (code, message) => {
  const fn = ERROR_TEXT[code];
  return fn ? fn(message || '') : `✖ ${code}: ${message || ''}`;
};

// ════ 工具 → 桥操作映射 ════
// 薄映射：语义定义在工具描述里，这里只决定"发哪个域哪个操作"
const TOOL_MAP = {
  webterm_status:   (a) => ['serial', 'status', a],
  serial_connect:   (a) => ['serial', 'connect', a],
  serial_disconnect:(a) => ['serial', 'disconnect', a],
  serial_send:      (a) => ['serial', 'send', a],
  serial_read:      (a) => ['serial', 'read', a],
  modbus_control:   (a) => ['modbus', 'control', a],
  modbus_request:   (a) => ['modbus', 'request', a],
  modbus_log:       (a) => ['modbus', 'log', a],
  ui_action:        (a) => ['ui', 'action', a],
  ui_inspect:       (a) => ['ui', 'inspect', a],
  dev_serial:       (a) => ['dev', a.action, a],
};

async function dispatchTool(name, args, request) {
  const mapper = TOOL_MAP[name];
  if (!mapper) {
    return { content: [{ type: 'text', text: `✖ 未知工具: ${name}` }], isError: true };
  }
  const [domain, op, payload] = mapper(args || {});
  // dev_serial 从 args.action 推导 op：缺参时 op 是 undefined，请求会带着
  // "dev.undefined" 上路，页面只能回 OP_UNSUPPORTED，而那句翻译会建议
  // "请让用户刷新页面"——把调用方的参数错误诊断成了页面版本问题。本地拦住，
  // 让模型看到的是自己少传了参数。
  if (typeof op !== 'string' || op === '') {
    return { content: [{ type: 'text', text: `✖ 缺少 action 参数：${name}` }], isError: true };
  }
  try {
    const res = await request(domain, op, payload);
    if (!res || res.ok !== true) {
      // 兜底码取自协议常量而非字面量：写成字面量的话，ERROR_CODES 一旦改名，
      // 这两处不会跟着走，translateError 会查不到而静默退化成兜底文案。
      const code = (res && res.error && res.error.code) || P.ERROR_CODES.PAGE_ERROR;
      const message = (res && res.error && res.error.message) || '无响应';
      return { content: [{ type: 'text', text: translateError(code, message) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
  } catch (e) {
    // 建连类失败（缺 token / server.js 没起 / 桥断开）自带完整的补救指引，而且
    // 根本不是"页面内部"的错误：套上 PAGE_ERROR 会追加"这通常是 WebTerm 自身的
    // 缺陷"，于是同一条消息里既有正确的补救步骤、又有自相矛盾的归因。原文透出。
    // 注意这里不走 translateError：页面的 message 是诊断信息，建连的 message 是
    // 给用户的指令，两者形状不同，不该共用同一套包装。
    if (e && e.bridgeUnavailable) {
      return { content: [{ type: 'text', text: '✖ ' + e.message }], isError: true };
    }
    return { content: [{ type: 'text', text: translateError(P.ERROR_CODES.PAGE_ERROR, e.message) }], isError: true };
  }
}

// ════ 与桥的连接 ════
const WebSocket = require('ws');
const { readToken } = require('./bridge-auth.js');

const SERVER_NAME = 'webterm-serial-bridge';
const SERVER_VERSION = '1.0.0';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const BRIDGE_URL = process.env.WEBTERM_BRIDGE_URL || 'ws://127.0.0.1:1982/bridge';

/**
 * 与桥"建立/恢复连接"这一环节的失败：缺 token、server.js 没起、桥断开。
 *
 * 与页面内部错误区别对待，是因为两者的 message 形状不同：页面的 message 是诊断
 * 信息（需要 translateError 包装成人话），而这里的 message 本身就是给用户的
 * 补救指令。套上 PAGE_ERROR 会追加"这通常是 WebTerm 自身的缺陷"，与原文自相矛盾。
 */
const bridgeDown = msg => Object.assign(new Error(msg), { bridgeUnavailable: true });

/** 与桥的长连接。断线自动重连；连不上时请求立即失败而不是永久挂起。 */
function createBridgeClient() {
  const state = { ws: null, connecting: null, seq: 0, pending: new Map(), retryMs: 500,
                  // 每个适配器进程一个随机标签，用于保证请求 id 全局唯一
                  tag: require('node:crypto').randomBytes(4).toString('hex') };

  /**
   * 取一条连通的 socket。在途的连接尝试必须缓存下来并复用。
   *
   * 只看 "state.ws 是否 OPEN" 是不够的：state.ws 要等 open 才赋值，所以首个 socket
   * 打开之前到达的每个调用都会各开一条 socket（并发 tools/call、以及桥重启后退避
   * 窗口内到达的请求，都会落进这个窗口）。输掉的那些 socket 永远不会被 state.ws
   * 引用，可它们的 close 处理器会无条件清空 state.ws 并 reject 全部在途请求——
   * 于是一个孤儿 socket 关闭，就能弄挂跑在健康 socket 上的请求。
   * 让并发汇合到同一次尝试，孤儿就无从产生。
   */
  function ensure() {
    if (state.ws && state.ws.readyState === 1) return Promise.resolve(state.ws);
    if (!state.connecting) {
      state.connecting = connect().then(
        ws => { state.connecting = null; return ws; },
        err => { state.connecting = null; throw err; },
      );
    }
    return state.connecting;
  }

  /** 真正建立一条连接。只应由 ensure() 调用——它就是"汇合"这件事本身 */
  function connect() {
    return new Promise((resolve, reject) => {
      let token;
      // 每次建连都重读 token 文件，不在进程内缓存——server.js 重启后 token 会变，
      // 缓存会让适配器拿着已失效的旧值反复被拒。读失败是部署问题（服务端没起 /
      // WEBTERM_HOME 指错），原文已是可操作指引，故原样透出。
      try { token = readToken(); } catch (e) { reject(bridgeDown(e.message)); return; }

      const ws = new WebSocket(BRIDGE_URL, { headers: { 'x-webterm-token': token } });
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch {}
        reject(bridgeDown(`连接桥超时（${BRIDGE_URL}）。请确认 server.js 已启动。`));
      }, 3000);
      // 本项目反挂死标准：有界等待计时器一律 unref，否则连不上桥时它会独自
      // 拖着事件循环 3 秒，`node --test` 又没有 --test-timeout，挂起是无界的。
      // 正常情况下 ws 的 socket 句柄仍持有事件循环，计时器照常触发。
      timer.unref();

      ws.on('open', () => {
        clearTimeout(timer);
        state.ws = ws;
        state.retryMs = 500;
        resolve(ws);
      });
      ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.kind !== 'res' || !state.pending.has(msg.id)) return;
        const p = state.pending.get(msg.id);
        state.pending.delete(msg.id);
        p.resolve(msg);
      });
      ws.on('close', () => {
        // 只有【当前连接】关闭才清空 state.ws 并失败在途请求。一个已被取代的
        // socket 无权处置这些：桥重启时 A 进入 CLOSING（close 尚未派发）、
        // 此刻到来的请求另建 B，随后 A 的 close 才触发——若无条件执行，A 会把
        // state.ws 清成 null 并 reject 掉跑在 B 上的请求（症状还会自我复制：
        // 下一个请求再建 C，B 沦为真正的孤儿，它关闭时又去弄挂 C）。
        if (state.ws === ws) state.ws = null;
        if (!state.ws) {
          for (const [, p] of state.pending) p.reject(bridgeDown('桥连接已断开'));
          state.pending.clear();
          // 重连只能排在这里：它的条件是"当前没有可用连接"。首次连不上桥时该
          // socket 从未 open、state.ws 恒为 null——若改写成像
          // `if (state.ws !== ws) return;` 那样的身份早退，这条最常见的故障恢复
          // 路径会被整个跳过，客户端将永远不再重试。
          //
          // 这个计时器没有清零点（它本身就是等待下一次尝试），不 unref 的话
          // 一次断线就能让进程再也退不掉。unref 后进程仍由 stdin 持有，重连照常。
          // 注意不能写成 setTimeout(ensure, ...).catch(...)：setTimeout 返回的是
          // Timeout 对象而非 Promise，那个 .catch 会在 close 处理器里抛
          // TypeError，把整个 MCP 进程带崩（重连也就永远停在第一级退避）。
          // 必须在回调里显式调用 ensure() 并吞掉它的 rejection——否则 token 缺失
          // 时的拒绝会变成 unhandledRejection，同样致命。
          setTimeout(() => { ensure().catch(() => {}); }, state.retryMs).unref();
          state.retryMs = Math.min(state.retryMs * 2, 10000);
        }
      });
      ws.on('error', err => {
        clearTimeout(timer);
        reject(bridgeDown(`无法连接桥（${BRIDGE_URL}）：${err.message}。请确认 server.js 已启动。`));
      });
    });
  }

  return {
    async request(domain, op, args) {
      const ws = await ensure();
      const id = `${state.tag}-${++state.seq}`;
      // id 必须【全局】唯一，不是"适配器内唯一"：桥的请求表是全桥共享的一张 map，
      // 而多个 Claude Code 会话各起一个适配器、各自从 1 开始编号 —— 必然撞车。
      // 撞车的后果是静默摧毁活跃请求：孤儿计时器、把 BRIDGE_TIMEOUT 误发给第二个
      // 请求者、页面的 res 只回给最后写入者而第一个请求者永远收不到。
      // 桥侧另有冲突守卫作纵深防御，但正确的修法是在源头保证唯一。
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pending.delete(id);
          reject(new Error(`桥未在 30s 内返回 ${domain}.${op}`));
        }, 30000);
        timer.unref();   // 同上：请求超时不该把进程钉在事件循环上
        state.pending.set(id, {
          resolve: v => { clearTimeout(timer); resolve(v); },
          reject: e => { clearTimeout(timer); reject(e); },
        });
        try { ws.send(JSON.stringify(P.makeReq(id, domain, op, args))); }
        catch (e) { state.pending.delete(id); clearTimeout(timer); reject(e); }
      });
    },
  };
}

// ════ JSON-RPC 分派 ════

async function handleMessage(msg, request) {
  if (!msg || typeof msg !== 'object') return null;
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;   // 通知不得回响应

      case 'ping':
        return reply(id, {});

      case 'tools/list':
        return reply(id, { tools: buildTools() });

      case 'tools/call': {
        const name = params && params.name;
        if (typeof name !== 'string') {
          return error(id, -32602, 'Invalid params: 缺少 tools/call 的 name');
        }
        const result = await dispatchTool(name, (params && params.arguments) || {}, request);
        return reply(id, result);
      }

      default:
        return isNotification ? null : error(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    // 任何异常都要转成 JSON-RPC 错误——抛出去会让整个 MCP 进程退出
    return isNotification ? null : error(id, -32603, `Internal error: ${e.message}`);
  }
}

const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// ════ 入口：stdio 换行分隔 JSON ════

function main() {
  const bridge = createBridgeClient();
  let buf = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { continue; }   // 畸形行直接跳过，不能因此退出
      handleMessage(msg, bridge.request).then(res => {
        if (res) process.stdout.write(JSON.stringify(res) + '\n');
      }).catch(err => {
        process.stderr.write(`[mcp-server] 分派失败: ${err.message}\n`);
      });
    }
  });

  process.stdin.on('end', () => process.exit(0));
  // stdout 只许放协议消息；日志一律走 stderr，否则会污染 MCP 流
  process.stderr.write(`[mcp-server] 就绪，目标桥 ${BRIDGE_URL}\n`);
}

if (require.main === module) main();

module.exports = { buildTools, dispatchTool, translateError, TOOL_MAP, handleMessage, createBridgeClient };
