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
      description: '控制 Modbus 调试面板。action 取值：\n- set_mode：切换串口模式，需同时给 mode（shared 复用终端串口 / independent 独立开串口）\n- connect / disconnect：独立模式下连接或断开自己的串口\n- activate / deactivate：启用或停用 Modbus 调试\n- cycle_start / cycle_stop：启停轮询发送\n\n重要：shared 模式下 activate 会「冻结终端」——终端输入框与发送按钮被禁用，目的是防止人工操作干扰 Modbus 报文时序。返回值里的 terminalFrozen 会标明此状态。用完请及时 deactivate 以恢复终端。',
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
      description: '发送一条语义化 Modbus RTU 请求并返回解析后的响应，CRC16 由页面自动计算。\n\n支持的功能码：01 读线圈、02 读离散输入、03 读保持寄存器、04 读输入寄存器、05 写单线圈、06 写单寄存器、15(0F) 写多线圈、16(10) 写多寄存器。\n\n返回值包含：请求与响应的完整 HEX 帧、响应时间、寄存器值（HEX/U16/I16/F32 多种格式）、线圈位图、以及异常码的中文描述。设备超时为 500ms，超时会明确标注。\n\n写操作会直接改变设备状态，请确认目标地址无误。',
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
      description: '操作终端界面。action 取值：clear 清屏、pause 暂停显示、resume 继续显示、set_theme（需 theme）、set_font（需 size）、toggle_sidebar 折叠侧栏、run_macro（需 name，执行已保存的宏）、list_macros 列出宏名、save_log 保存终端日志到文件。\n\n注意 pause 只影响显示，不影响串口接收——数据仍会进入缓冲，可用 serial_read 读取。',
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
const ERROR_TEXT = {
  NEEDS_USER_GESTURE: () => '✖ 无法连接：浏览器要求用户手动授权串口（首次连接必须真人点一下页面上的"连接"按钮）。重试不会有帮助——请让用户操作完成后再继续。',
  PORT_BUSY: (m) => `✖ 串口被占用：${m}\n该物理端口正被另一套串口栈持有。可先用 modbus_control 把模式切到 shared 复用终端端口，或先断开占用方。`,
  PAGE_NOT_CONNECTED: () => '✖ 页面未连接。请确认用户已在浏览器打开 http://localhost:1982 ，且页面上的桥连接正常。',
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
  try {
    const res = await request(domain, op, payload);
    if (!res || res.ok !== true) {
      const code = (res && res.error && res.error.code) || 'PAGE_ERROR';
      const message = (res && res.error && res.error.message) || '无响应';
      return { content: [{ type: 'text', text: translateError(code, message) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: translateError('PAGE_ERROR', e.message) }], isError: true };
  }
}

module.exports = { buildTools, dispatchTool, translateError, TOOL_MAP };
