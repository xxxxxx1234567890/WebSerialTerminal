// bridge-client.js
// 页面侧：WS 客户端 + 命令 dispatcher + 武装开关。
//
// 铁律：本文件任何路径都不得把异常抛回页面代码——AI 控制是附加能力，
// 桥挂掉绝不能影响终端正常使用（spec 第 5.6 节）。所以这里没有"抛出后不管"的分支：
// 初始化整体包 try，每个探测点各自兜底，WS 断线只做指数退避重连，不弹错误、不阻塞 UI。
//
// 结构上分两层：可脱离 DOM 单测的纯函数（经 module.exports 暴露给 node:test），
// 以及只做"调哪个全局函数"的薄 dispatcher。页面无 DOM 测试环境，
// 可测逻辑必须抽出来（spec 第 9.2 节）。
//
// 注意 factory 只能调用一次：本文件的浏览器分支带副作用（开 WS、绑 DOM 事件），
// 调用两次会产生两条连接和两组监听器。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else factory(root);   // 浏览器：副作用式初始化，返回值丢弃
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const isNode = typeof module === 'object' && module.exports;
  const P = isNode ? require('./bridge-protocol.js') : root.BridgeProtocol;
  const FakeSerial = isNode ? require('./fake-serial.js') : root.FakeSerial;

  // ════ 纯函数层（可在 Node 单测） ════

  /**
   * 环形缓冲 + 单调游标。挤占时必须显式报告 dropped——
   * AI 在"以为输出连续"的前提下做判断，比收到报错更危险。
   * firstSeq 供 serial.read 在结果被 max 截断时算出正确的续读游标。
   */
  function makeRingBuffer(capacity) {
    const items = [];
    let total = 0;      // 累计写入条数，作为单调游标
    let nextSeq = 0;    // 最旧一条的序号
    return {
      push(line) {
        items.push({ seq: total++, line });
        while (items.length > capacity) items.shift();
        nextSeq = items.length ? items[0].seq : total;
      },
      since(cursor) {
        if (cursor >= total) return { lines: [], cursor: total, dropped: 0, firstSeq: total };
        const dropped = Math.max(0, nextSeq - cursor);
        const kept = items.filter(it => it.seq >= cursor);
        return {
          lines: kept.map(it => it.line),
          cursor: total,
          dropped,
          firstSeq: kept.length ? kept[0].seq : total,
        };
      },
      get cursor() { return total; },
    };
  }

  function normalizeSendArgs(args) {
    const a = args || {};
    if (typeof a.data !== 'string' || a.data === '') throw new Error('data 必填且不能为空');
    const encoding = a.encoding || 'ascii';
    const bytes = P.encodeToBytes(a.data, encoding);   // 非法 hex 在此抛错
    return { bytes, encoding };
  }

  // 只读操作不受武装开关限制——AI 任何时候都该能诊断现状
  const READ_ONLY = new Set([
    'serial.status', 'serial.read',
    'modbus.status', 'modbus.log',
    'ui.inspect', 'ui.list_macros',
    'dev.fake_capture',
  ]);
  const classifyWrite = (domain, op) => !READ_ONLY.has(`${domain}.${op}`);

  /**
   * 判定一次请求是否属于"写入"。
   * ui.action 是多态入口：list_macros 是纯读，run_macro 是写入，只按 op='action'
   * 判定会把前者一起挡在武装开关后面，而工具说明与 spec 都要求读取类不受限制。
   * 其余域的操作键与 op 一一对应，直接交给 classifyWrite。
   */
  function isWriteOp(domain, op, args) {
    const a = args || {};
    if (domain === 'ui' && op === 'action' && typeof a.action === 'string') {
      return classifyWrite('ui', a.action);
    }
    return classifyWrite(domain, op);
  }

  const MODBUS_WRITE_FUNCS = [5, 6, 15, 16];
  const MODBUS_FUNCS = [1, 2, 3, 4, 5, 6, 15, 16];

  /**
   * 解析并规范化 Modbus 写数据。页面 #mbWriteData 是按 token 逐个 parseInt(,16) 解析的，
   * 所以 '000A' 这种连写会被它当成一个 token（第二个字节变 undefined → 帧里成 0）。
   * 这里统一解析成字节再回吐给页面的规范形式（空格分隔的字节），保证页面解析出的
   * 字节与桥侧重建的帧完全一致。
   *
   * 校验在桥侧做，不改既有的 modbusSend()：非法参数应当得到 INVALID_ARGS，
   * 而不是把字面量 "undefined" 写进用户可见的表单再等 1500ms 超时。
   *
   * quantity 用于 FC15/16 的长度核对，**必须**传：modbusConstructFrame 按 quantity
   * 推出 byteCount 后逐字节取 writeData[i]，越界取到的 undefined 会经
   * `new Uint8Array()` 静默变成 0——线缆上的字节与调用方给的数据不一致却不报错
   * （FC15/16 是"写多寄存器"，补零写下去会真的改掉设备状态）。
   * 不传（undefined/非整数）时跳过长度核对，保留"只做编码检查"的单参用法。
   */
  function normalizeWriteData(funcCode, raw, quantity) {
    let bytes;
    try {
      bytes = P.hexToBytes(String(raw).trim());
    } catch (e) {
      throw new Error('writeData 必须是十六进制字节（如 "00 0A" / "000A" / "0x00,0x0A"）：' + e.message);
    }
    if (funcCode === 5 || funcCode === 6) {
      if (bytes.length !== 2) {
        throw new Error(`功能码 ${funcCode} 的 writeData 必须正好 2 字节（16 位值），收到 ${bytes.length} 字节`);
      }
      return { text: Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' '), value: (bytes[0] << 8) | bytes[1] };
    }
    // FC15 按位打包（ceil(quantity/8) 字节），FC16 每寄存器 2 字节。
    // 与 modbusConstructFrame 的 byteCount 用同一个算式，两处必须同源。
    if (Number.isInteger(quantity) && (funcCode === 15 || funcCode === 16)) {
      const expect = funcCode === 15 ? Math.ceil(quantity / 8) : quantity * 2;
      if (bytes.length !== expect) {
        throw new Error(funcCode === 15
          ? `功能码 15 的 writeData 必须正好 ${expect} 字节（${quantity} 个线圈 → 每 8 个 1 字节），收到 ${bytes.length} 字节`
          : `功能码 16 的 writeData 必须正好 ${expect} 字节（${quantity} 个寄存器 × 2 字节），收到 ${bytes.length} 字节`);
      }
    }
    return {
      text: Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' '),
      // modbusConstructFrame 对 FC5/6 取 16 位整数，对 FC15/16 取字节数组
      value: bytes,
    };
  }

  /** 渲染 send / fake_inject 的 data 供审计使用。编码失败时退回原文——
   *  审计行是事后唯一的线索，不能因为参数本身非法就整行消失（那正是最该留痕的时候）。 */
  function describeData(args, encoding) {
    const a = args || {};
    if (typeof a.data !== 'string' || a.data === '') return '（无数据）';
    try {
      const bytes = P.encodeToBytes(a.data, encoding);
      let hex = '';
      for (const b of bytes) hex += b.toString(16).padStart(2, '0');
      return hex + '（' + encoding + '）';
    } catch {
      return JSON.stringify(a.data) + '（无法按 ' + encoding + ' 编码）';
    }
  }

  /**
   * 从终端行里取出"连接为何失败"。
   *
   * connectPort() 的 catch 只把原因 appendLine 进终端、**不重抛**（既有函数体不改，
   * 这是最小侵入的替代路径），所以失败原因只能从它刚写下的那一行里读回来。
   * 丢了原因，serial.connect 就只剩一句"连接未成功建立"，而 translateError 会给它
   * 追加"这通常是 WebTerm 自身的缺陷"——把端口占用这类外部原因诊断成自家的 bug。
   *
   * 取**最后**一条匹配：一次失败的连接尝试可能留下多条错误行，最新的一条才对应本次。
   * 形如 `✖ 连接失败: Failed to open serial port.`（内容由页面 appendLine 决定）。
   * 锚定在行首：不锚的话，设备恰好回显一句含"连接失败: "的文本（它也会进同一缓冲区）
   * 就会被当成连接失败的原因——一条凭空捏造的归因。锚定后只有整行以此开头才命中。
   */
  function parseConnectFailure(lines) {
    if (!Array.isArray(lines)) return null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = String(lines[i] == null ? '' : lines[i]).trim();
      const m = /^(?:✖\s*)?连接失败\s*[:：]\s*(.+)$/.exec(raw);
      if (m && m[1].trim()) return m[1].trim();
    }
    return null;
  }

  /**
   * 写入类操作的审计描述。
   *
   * spec 第 5.5 节把 [AI] 轨迹定为"不做逐次确认"这个决策的唯一补偿控制
   * （design 第 7.2 节），所以"每个写入都留痕"必须由 dispatcher 统一保证——
   * 集中在这一处，将来新增写操作不可能漏掉；散在各个 handler 里则迟早会漏。
   *
   * `page` 是页面侧快照：args 里没有、只有页面才知道的事实。审计行必须报
   * **线缆上真正会发生的事**，所以这些字段一律取自"实际驱动该操作的那个来源"，
   * 由调用方读好后传入，本函数保持可脱离 DOM 单测。
   *   page.cycle    = 轮询实际使用的表单（mv*，见 readPageSnapshot 的说明）
   *   page.macroCmd = 宏实际会发出的命令
   * 返回 null 表示不是写操作（读取类无需审计）。
   */
  function describeWrite(domain, op, args, page) {
    const a = args || {};
    if (!isWriteOp(domain, op, a)) return null;
    const pg = page || {};
    // 缺参一律给可读占位：审计行里出现字面量 "undefined" 会看起来像一个真实取值，
    // 事后追溯会因此得出错误结论（与表单字段同一条规则，不因为这里是 args 就放宽）
    const or = v => (v === undefined || v === null || v === '' ? '?' : v);
    const f = k => or((pg.cycle || {})[k]);
    const idx = Number.isInteger(a.index) ? a.index : 0;
    switch (domain + '.' + op) {
      case 'serial.connect': return `连接串口（已授权端口 index=${idx}）`;
      case 'serial.disconnect': return '断开串口';
      case 'serial.send': return '发送 ' + describeData(a, a.encoding || 'ascii');
      case 'serial.set_params': return '记录串口参数（需断开重连才生效）';
      case 'modbus.control': {
        switch (a.action) {
          case 'set_mode': return `Modbus 模式切到 ${or(a.mode)}`;
          case 'connect': return `Modbus 独立串口连接（已授权端口 index=${idx}）`;
          case 'disconnect': return 'Modbus 独立串口断开';
          case 'activate': return 'Modbus 启用';
          case 'deactivate': return 'Modbus 停用';
          // 轮询会持续对真实硬件发报文，而终端里本来零痕迹——这条必须带上"对谁发什么"，
          // 否则事后无从追溯，与"不做逐次确认"的前提直接冲突。
          // 参数只能取自 mv*：modbusStartCycle → modbusViewSend → modbusViewSync 会用
          // mv* 覆盖 mb* 之后才构造帧，读 mb* 会报出一个线缆上不会发生的目标。
          case 'cycle_start': {
            // 只有写功能码的帧才携带载荷：modbusConstructFrame 对 FC 1-4 只放
            // quantity，对非写功能码取不到 writeData。表格里留着旧值也照打的话，
            // 审计行会声称一个线缆上不存在的载荷（对人类输入同一条规则：记的必须
            // 是线缆上的字节，而不是输入框里恰好还剩什么）。
            const cycFc = Number(f('funcCode'));
            const cycData = MODBUS_WRITE_FUNCS.includes(cycFc) && f('writeData') !== '?'
              ? ' 数据=' + f('writeData') : '';
            return `Modbus 启动轮询 slave=${f('slaveId')} fc=${f('funcCode')} addr=${f('address')}`
                 + ` qty=${f('quantity')} 间隔=${f('cycleIntervalMs')}ms${cycData}`;
          }
          case 'cycle_stop': return 'Modbus 停止轮询';
          default: return 'Modbus control：' + or(a.action);
        }
      }
      case 'modbus.request': {
        // 载荷只在写功能码的帧里存在。读功能码（1/2/3/4）即便调用方顺手带了
        // writeData，modbusConstructFrame 也不会把它放进帧——照打就会报出一个
        // 线缆上不存在的载荷，而那正是"事后追溯得出错误结论"的形态。
        // 格式化后的值来自人类输入，但**写这一行的动作**可以由 AI 触发，
        // 因此它同样会进 AI 读取的缓冲，必须按帧的真实内容设门。
        const reqData = MODBUS_WRITE_FUNCS.includes(Number(a.funcCode))
          && a.writeData !== undefined && a.writeData !== null && a.writeData !== ''
          ? ' 数据=' + a.writeData : '';
        return `Modbus 请求 slave=${or(a.slaveId)} fc=${or(a.funcCode)} addr=${or(a.address)}`
             + ` qty=${or(a.quantity)}${reqData}`;
      }
      case 'ui.action': {
        // 宏必须带上实际会发出的命令：只记宏名的话，追溯要靠"宏定义在被查时仍未改动"，
        // 用户一改宏，记录就误导了
        if (a.action === 'run_macro') return `执行宏「${or(a.name)}」→ ${or(pg.macroCmd)}`;
        if (a.action === 'set_theme') return `主题切到 ${or(a.theme)}`;
        if (a.action === 'set_font') return `字号切到 ${or(a.size)}`;
        return '界面动作 ' + or(a.action);
      }
      case 'dev.serial_source': return `串口源切到 ${or(a.mode)}`;
      case 'dev.fake_inject': return '假设备注入 ' + describeData(a, a.encoding || 'hex');
      // 规则条数：非数组真值（如 rules:'abc'）经 .length 会产出字面量 undefined，
      // 审计行里的 "undefined" 看起来像一个真实取值。与 or() 同一条规则。
      case 'dev.fake_script': {
        const n = Array.isArray(a.rules) ? a.rules.length : (a.rules == null ? 0 : '?');
        return `设置 ${n} 条假设备应答规则`;
      }
      default: return domain + '.' + op;
    }
  }

  if (isNode) {
    return {
      makeRingBuffer, normalizeSendArgs, classifyWrite, isWriteOp,
      normalizeWriteData, describeWrite, describeData, parseConnectFailure,
    };
  }

  // ════ 浏览器侧 ════
  // 初始化失败（旧浏览器缺 crypto/WebSocket 等）绝不能从 <script> 抛出去——
  // 那会让页面看起来"坏了"，而实际上只是 AI 那半边不可用。
  try {
    return initBrowser();
  } catch (e) {
    try { console.warn('[bridge-client] 初始化失败，AI 控制不可用：', e); } catch { /* 忽略 */ }
    return { initError: (e && e.message) || String(e) };
  }

  function initBrowser() {
    const READ_DEFAULT = P.READ_DEFAULT_LINES;

    const rb = makeRingBuffer(P.READ_MAX_LINES);
    const state = {
      ws: null,
      retryMs: 1000,
      pageId: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())).slice(0, 8),
      serialSource: 'real',
      fakePort: null,
      everOpen: false,
      warnedNoBridge: false,
      // 桥明确拒绝过我们（目前只有协议版本不匹配这一种）。这是终局状态：
      // 重连不会变好，只会每 30 秒往终端里再刷一条同样的告警。
      rejected: false,
    };

    const err = (code, message) => Object.assign(new Error(message), { code });

    // ── 武装开关：默认关闭 ──
    // 用独立的 localStorage 键，不塞进 wtp_settings。理由有两条，都和
    // "把安全状态混进界面配置"有关：
    //   1) loadState() 用 { ...settings, ...存档 } 整体合并存档，settings 是主题/字号
    //      这类显示偏好的容器。武装状态一旦成为它的字段，任何一次"设置回退/清空重来"
    //      都会顺带改掉"AI 能否写硬件"——反过来，用户以为重置了设置，写入权限却还在。
    //   2) 独立键可以单独清除（localStorage.removeItem('wtp_ai_armed')，或只清这一项），
    //      不必为了收回一次授权而连带丢掉全部终端配置。
    const ARMED_KEY = 'wtp_ai_armed';
    function isArmed() {
      try { return localStorage.getItem(ARMED_KEY) === '1'; } catch { return false; }
    }
    function setArmed(on) {
      try { localStorage.setItem(ARMED_KEY, on ? '1' : '0'); } catch { /* 隐私模式下可能抛 */ }
      syncArmedUI();
    }
    function syncArmedUI() {
      const el = document.getElementById('aiArmedToggle');
      if (el) el.checked = isArmed();
      const hint = document.getElementById('aiArmedHint');
      if (hint) hint.textContent = isArmed() ? '已允许 AI 写入' : 'AI 只读';
    }

    /** 审计轨迹复用既有终端日志，无需新建日志系统 */
    function audit(text) {
      try { appendLine('sys', '[AI] ' + text); } catch { /* 页面函数异常不得外泄 */ }
    }

    // modbusSend() 把解析结果直接渲染进 DOM 而不返回。既有函数不能改，
    // 因此用包装器在既有函数外面套一层截获结果——这是唯一不触碰既有代码的接入点。
    // 必须覆盖两种结局：ok / exception / crc_error 走 modbusShowResponse；
    // timeout 只走 modbusAddLog（modbusStartWait 的超时分支不调用 showResponse）。
    let mbCapture = null;
    const MODBUS_EXCEPTION_TEXT = {
      1: '非法功能码', 2: '非法数据地址', 3: '非法数据值', 4: '从站设备故障',
      5: '确认', 6: '从站设备忙', 8: '存储奇偶性错误',
      10: '网关路径不可用', 11: '网关目标无响应',
    };
    function installModbusCapture() {
      const origShow = window.modbusShowResponse;
      if (typeof origShow === 'function') {
        window.modbusShowResponse = function (result) {
          if (mbCapture) mbCapture.settle({ outcome: result.type, result });
          return origShow.apply(this, arguments);
        };
      }
      const origLog = window.modbusAddLog;
      if (typeof origLog === 'function') {
        window.modbusAddLog = function (frame, status) {
          if (mbCapture && status === 'timeout') mbCapture.settle({ outcome: 'timeout' });
          return origLog.apply(this, arguments);
        };
      }
      // 包装失败要能察觉——否则 modbus.request 会永远等到 1500ms 超时
      if (typeof origShow !== 'function' || typeof origLog !== 'function') {
        audit('警告：无法包装 Modbus 结果截获点，modbus.request 可能不可用');
      }
    }

    // ── 免手势端口获取（**仅供 AI 入口使用**） ──
    // 人工路径不得使用本函数：那两个按钮要的就是选择框。详见 WebSerialTerminal.html
    // 里 seam 块上方的说明（为什么策略不能放进 seam 本身）。
    // requestPort() 每次弹框且需用户手势，getPorts() 两者都不需要——所以 AI 的自动重连
    // 必须绕开 requestPort()，做法是在自己的调用期间临时替换 serialProvider。
    async function withAuthorizedPort(index, fn) {
      let authorized;
      try {
        authorized = await serialProvider.getPorts();
      } catch (e) {
        throw err(P.ERROR_CODES.NEEDS_USER_GESTURE,
          '无法查询已授权端口（' + ((e && e.message) || e) + '）。请手动点击一次页面上的"连接"按钮。');
      }
      if (!authorized || authorized.length === 0) {
        throw err(P.ERROR_CODES.NEEDS_USER_GESTURE,
          '没有已授权端口。浏览器要求用户手势才能弹出串口选择框，请手动点击一次页面上的"连接"按钮。');
      }
      const idx = Number.isInteger(index) ? index : 0;
      if (idx < 0 || idx >= authorized.length) {
        throw err(P.ERROR_CODES.INVALID_ARGS,
          `index 越界：已授权端口 ${authorized.length} 个，请求的 index=${idx}`);
      }

      // 当前 provider 已经不是真实实现（典型是 dev.serial_source 切到 fake）时不得替换：
      // 换成 navigator.serial 会绕开假设备，之后 connect 永远连不上，而注入/截获工具
      // 仍"看起来正常"——这种半坏状态比直接报错难查得多。
      if (serialProvider !== root.realSerialProvider) return await fn();

      const prev = serialProvider;
      // 复用页面声明的真实实现，不在这里另写一份 navigator.serial 调用——
      // 全仓库"Web Serial API 只被 seam 引用"这条不变式（client.test.js 有断言）
      // 才守得住，将来 seam 改了这里不会悄悄落后
      serialProvider = {
        getPorts: () => root.realSerialProvider.getPorts(),
        requestPort: async () => (await root.realSerialProvider.getPorts())[idx],
      };
      // finally 换回：任何失败路径都不得把免手势 provider 泄漏给人工路径
      try { return await fn(); } finally { serialProvider = prev; }
    }

    // ── 命令分派（薄层：只负责"调哪个全局函数"） ──
    const OPS = {
      'serial.status': async () => {
        // 串口参数取自连接时使用的 DOM 输入（页面没有把它们存回 settings）
        const val = id => {
          const el = document.getElementById(id);
          return el ? el.value : null;
        };
        const info = (isConnected && port && port.getInfo) ? port.getInfo() : {};
        return {
          connected: !!isConnected,
          portInfo: info.usbVendorId
            ? `VID:${info.usbVendorId.toString(16).toUpperCase().padStart(4, '0')} PID:${(info.usbProductId || 0).toString(16).toUpperCase().padStart(4, '0')}`
            : (isConnected ? 'Serial Port' : null),
          params: {
            baudRate: Number(val('baudRate')) || null,
            dataBits: Number(val('dataBits')) || null,
            stopBits: Number(val('stopBits')) || null,
            parity: val('parity'),
            flowControl: val('flowControl'),
          },
          counters: { rxBytes, txBytes, rxLines, errors },
          paused: !!isPaused,
          // 显示模式取自 #chkHex 复选框；引擎没有把它存进变量
          hexDisplay: !!(document.getElementById('chkHex') || {}).checked,
          source: state.serialSource,
          modbus: {
            mode: modbusPortMode,
            connected: !!modbusConnected,
            active: !!modbusActive,
            cycling: !!modbusCycling,
            terminalFrozen: !!modbusActive && modbusPortMode === 'shared',
          },
        };
      },

      'serial.connect': async args => {
        if (isConnected) {
          // 空操作也要有结果行：dispatcher 已经写过意图行，只留意图没有结果，
          // 事后无法区分"连上了"和"根本没执行"（与失败行同一个理由）
          audit('已处于连接状态，未重复连接');
          return { alreadyConnected: true };
        }
        // 记下游标：connectPort() 失败时只把原因写进终端、不重抛，所以"为什么没连上"
        // 只能从它刚写下的那几行里读回来（见 parseConnectFailure）。
        const mark = rb.cursor;
        // 走 withAuthorizedPort：AI 免手势，绝不弹选择框（人工点按钮才弹）
        await withAuthorizedPort(args && args.index, () => connectPort());
        if (!isConnected) {
          const reason = parseConnectFailure(rb.since(mark).lines);
          // 另一套串口栈正持有端口时（Modbus 独立模式），本次失败最可能就是争用——
          // 这正是 spec §4.5 为 PORT_BUSY 定义的场景，此前实现里没有任何产出点。
          // 不把页面报告的原因藏起来：即便归因错了，原文也在消息里，可被推翻。
          if (modbusConnected && modbusPortMode === 'independent') {
            throw err(P.ERROR_CODES.PORT_BUSY,
              'Modbus 独立串口当前正持有一个物理端口，终端很可能与之争用同一台设备'
              + (reason ? '（页面报告：' + reason + '）' : '（页面未给出具体原因）'));
          }
          // 真实原因原样带出，而不是笼统的"连接未成功建立"——后者会被
          // translateError 追加"这通常是 WebTerm 自身的缺陷"
          throw err(P.ERROR_CODES.PAGE_ERROR, reason || '连接未成功建立');
        }
        // 成功后补一条带结果的审计（哪个口、多少波特）——连接失败时只有 dispatcher
        // 那条"意图"审计，成功时两条合起来才说得清"对哪台设备做了什么"
        const info = (port && port.getInfo) ? port.getInfo() : {};
        const ports = info.usbVendorId
          ? `VID:${info.usbVendorId.toString(16).toUpperCase().padStart(4, '0')}`
          : 'Serial Port';
        audit(`已连接 ${ports} @ ${(document.getElementById('baudRate') || {}).value} baud`);
        return { connected: true };
      },

      'serial.disconnect': async () => { await disconnectPort(); return { connected: false }; },

      // 刻意不走 sendData()——它对这个用途有三个致命问题：
      //   1) 会自动追加 #eolSelect 的 CR/LF，Modbus 二进制帧会被直接损坏
      //   2) 非 HEX 分支用 charCodeAt 构造字节（UTF-16 低位），中文会变乱码
      //   3) 未连接时静默 return，错误只写进 DOM，AI 无从得知发送失败
      // 直写 writer 才是"原始字节通道"该有的语义。
      'serial.send': async args => {
        const { bytes } = normalizeSendArgs(args);
        if (!isConnected || !writer) {
          throw err(P.ERROR_CODES.PORT_NOT_CONNECTED, '终端未连接串口，请先调用 serial_connect');
        }
        await writer.write(bytes);
        txBytes += bytes.length;
        updateCounters();
        const chk = document.getElementById('chkLocalEcho');
        if (chk && chk.checked) appendLine('tx', P.bytesToHex(bytes));
        return { bytesWritten: bytes.length };
      },

      'serial.read': async args => {
        const max = Math.min(Number(args && args.max) || READ_DEFAULT, P.READ_MAX_LINES);
        // 负数游标必须先夹到 0：rb.since(-5) 会算出 dropped = nextSeq + 5，
        // 报出一个**不存在的**"你漏了 N 条"信号——AI 据此会去重新同步一个
        // 它其实从未落后过的读取位置（实测 since(-5) → dropped:7）。
        const cursor = Math.max(0, Number(args && args.cursor) || 0);
        const r = rb.since(cursor);
        const truncated = r.lines.length > max;
        const lines = truncated ? r.lines.slice(0, max) : r.lines;
        return {
          lines,
          // 被 max 截断时游标停在最后一条已返回的行之后，AI 用它能接着读剩下的部分。
          // 若一律返回最新游标，被截掉的那段会无声消失（dropped 仍是 0，AI 以为没丢）。
          cursor: truncated ? r.firstSeq + lines.length : r.cursor,
          dropped: r.dropped,
          truncated,
        };
      },

      'serial.set_params': async () => ({
        applied: false,
        note: '参数已记录，但串口需重新连接后方能生效。请先 disconnect 再 connect。',
      }),

      'modbus.status': async () => ({
        mode: modbusPortMode, connected: !!modbusConnected, active: !!modbusActive,
        cycling: !!modbusCycling,
        terminalFrozen: !!modbusActive && modbusPortMode === 'shared',
      }),

      'modbus.control': async args => {
        const action = args && args.action;
        switch (action) {
          case 'set_mode': modbusSetMode(args.mode); break;
          // 独立模式连接同样走 withAuthorizedPort：AI 免手势，且可用 index 选第二个
          // 适配器（Chromium 对同一设备只暴露一个 SerialPort 对象，故 getPorts()[0]
          // 往往是终端已打开的那个——多适配器场景必须能指定 index）
          case 'connect': await withAuthorizedPort(args.index, () => modbusConnectPort()); break;
          case 'disconnect': await modbusDisconnectPort(); break;
          case 'activate':
            if (modbusPortMode === 'shared' && !isConnected) {
              throw err(P.ERROR_CODES.PORT_NOT_CONNECTED, '共享模式需要终端已连接串口');
            }
            if (!modbusActive) { document.getElementById('mbActivate').checked = true; modbusToggleActive(); }
            break;
          case 'deactivate':
            if (modbusActive) { document.getElementById('mbActivate').checked = false; modbusToggleActive(); }
            break;
          case 'cycle_start':
            // modbusStartCycle() 在 !modbusActive 时会 early-return，什么也没发生；
            // 若不在这里先行拒绝，dispatcher 写的"意图"审计行就会成为一条**没有对应
            // 失败行**的记录——事后会把"从未启动的轮询"读成真的在跑。
            // modbus.request 有同样的前置，这里也必须一致。
            if (!modbusActive) {
              throw err(P.ERROR_CODES.INVALID_ARGS, 'Modbus 未启用，轮询无法启动，请先 modbus_control activate');
            }
            modbusStartCycle(); break;
          case 'cycle_stop': modbusStopCycle(); break;
          default: throw err(P.ERROR_CODES.INVALID_ARGS, '未知 action: ' + action);
        }
        return {
          mode: modbusPortMode, active: !!modbusActive, cycling: !!modbusCycling,
          // 冻结终端是 shared 模式的既定代价，必须显式告知 AI
          terminalFrozen: !!modbusActive && modbusPortMode === 'shared',
        };
      },

      // modbusSend() 从 DOM 读取参数、并把解析结果直接渲染进 DOM 而不返回。
      // 既有函数不能改，因此先回填输入框再调用它，并用包装器截获结果。
      'modbus.request': async args => {
        const a = args || {};
        if (!modbusActive) {
          throw err(P.ERROR_CODES.INVALID_ARGS, 'Modbus 未启用，请先 modbus_control activate');
        }
        // shared 模式**收不到响应**，所以这里必须先行拒绝，不能"发出去等超时"。
        //
        // 依据：shared 模式下 modbusToggleActive()/modbusSetMode() 会把 isPaused 置为
        // true（冻结终端），而 readLoop 的暂停分支是 `rxDecoder.decode(); continue;`——
        // 它在 modbusFeedResponse(value) 之前就 continue 了。于是响应字节被丢弃、
        // 页面永远解析不出结果，modbusStartWait 必然 500ms 后超时。
        // 对写操作尤其危险：字节真的写到了线缆上，而返回值说"设备没响应"——
        // 据此重试就是重复写。宁可失败得早、说得清楚。
        // （页面既有逻辑不改；本限制是可预期的行为，不是缺陷，故用 INVALID_ARGS
        //  传达"当前状态/参数组合不可用"，九个错误码清单不动。）
        if (modbusPortMode === 'shared') {
          throw err(P.ERROR_CODES.INVALID_ARGS,
            'shared 模式无法执行 modbus_request：该模式会冻结终端读循环，'
            + 'Modbus 响应字节在解析前就被丢弃，本请求只会等到 500ms 超时'
            + '（写操作更危险——字节已经写到线缆上，返回值却说设备没响应）。'
            + '请先 modbus_control {action:"set_mode", mode:"independent"} 再 connect 独立串口。'
            + '若当前只有终端那一个串口可用，则本工具在此模式下不可用；'
            + '请让用户在页面的 Modbus 面板里手动收发。');
        }
        const hasWriter = modbusPortMode === 'independent' ? modbusConnected : isConnected;
        if (!hasWriter) throw err(P.ERROR_CODES.PORT_NOT_CONNECTED, 'Modbus 当前没有可用串口');
        // 截获点是单例：并发请求会互相顶掉，结局是两条都超时，
        // 而超时消息完全指不到真正的原因。显式拒绝比让它们悄悄踩踏好。
        if (mbCapture) {
          throw err(P.ERROR_CODES.PAGE_ERROR, '已有 Modbus 请求在等待响应，请串行调用');
        }

        // 先校验干净再碰 DOM、再写审计行。理由：字段缺省时现在会把字面量 "undefined"
        // 写进用户可见的 Modbus 表单，并记下一帧用零值构造、从未真正发出的报文——
        // 虚假的审计行比缺失的审计行更糟，它让事后追溯得出错误结论。
        // 校验放在最前，非法参数得到的是 INVALID_ARGS，而不是 1500ms 之后的超时。
        const slaveId = Number(a.slaveId), funcCode = Number(a.funcCode);
        const address = Number(a.address), quantity = Number(a.quantity);
        if (!Number.isInteger(slaveId) || slaveId < 1 || slaveId > 247) {
          throw err(P.ERROR_CODES.INVALID_ARGS, `slaveId 必须是 1-247 的整数，收到 ${JSON.stringify(a.slaveId)}`);
        }
        if (!MODBUS_FUNCS.includes(funcCode)) {
          throw err(P.ERROR_CODES.INVALID_ARGS, `funcCode 必须是 ${MODBUS_FUNCS.join('/')} 之一，收到 ${JSON.stringify(a.funcCode)}`);
        }
        if (!Number.isInteger(address) || address < 0 || address > 65535) {
          throw err(P.ERROR_CODES.INVALID_ARGS, `address 必须是 0-65535 的整数，收到 ${JSON.stringify(a.address)}`);
        }
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 2000) {
          throw err(P.ERROR_CODES.INVALID_ARGS, `quantity 必须是 1-2000 的整数，收到 ${JSON.stringify(a.quantity)}`);
        }
        let write = null;
        if (MODBUS_WRITE_FUNCS.includes(funcCode)) {
          if (a.writeData === undefined || a.writeData === null || a.writeData === '') {
            throw err(P.ERROR_CODES.INVALID_ARGS, `功能码 ${funcCode} 需要 writeData（十六进制，如 "00 0A"）`);
          }
          try { write = normalizeWriteData(funcCode, a.writeData, quantity); }
          catch (e) { throw err(P.ERROR_CODES.INVALID_ARGS, e.message); }
        }

        const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };
        set('mbSlaveId', slaveId);
        set('mbFuncCode', funcCode);
        set('mbQuantity', quantity);
        // 地址必须按 DEC 解析：modbusParseAddress() 看 modbusAddrHex 决定进制。
        // 两个地址模式复选框要一起置成 DEC 再同步——modbusViewSyncAddrMode() 会用
        // #mvAddrMode 覆盖 #mbAddrMode 并重算 modbusAddrHex，只写变量会被它改回去，
        // 于是 AI 给的十进制地址被当成十六进制解析，静默发到错误地址上。
        const mvAddrMode = document.getElementById('mvAddrMode');
        if (mvAddrMode) mvAddrMode.checked = false;
        modbusAddrHex = false;
        if (typeof modbusViewSyncAddrMode === 'function') modbusViewSyncAddrMode();
        set('mbAddress', address);
        // 回填的是规范化后的字节串（空格分隔），页面按同样的形式解析出同样的字节
        if (write) set('mbWriteData', write.text);
        if (typeof modbusOnFuncCodeChange === 'function') modbusOnFuncCodeChange();

        const frame = modbusConstructFrame(slaveId, funcCode, address, quantity,
          write ? write.value : null);
        // 这条是线缆级真相（实际字节），dispatcher 的统一审计行给不出，故保留
        audit('Modbus → ' + P.bytesToHex(frame));

        const captured = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            mbCapture = null;
            reject(new Error('Modbus 请求未在 1500ms 内结束'));
          }, 1500);
          mbCapture = { settle: v => { clearTimeout(timer); mbCapture = null; resolve(v); } };
          try { modbusSend(); }
          catch (e) { clearTimeout(timer); mbCapture = null; reject(e); }
        });

        if (captured.outcome === 'timeout') {
          return { txHex: P.bytesToHex(frame), outcome: 'timeout',
                   note: '设备在页面设定的 500ms 内未响应。若这是在有意测试超时路径，属预期结果。' };
        }

        const r = captured.result;
        const out = {
          txHex: P.bytesToHex(frame),
          outcome: captured.outcome,
          rxHex: r.raw ? P.bytesToHex(r.raw) : null,
          responseTimeMs: Date.now() - modbusSendTime,
        };
        if (r.type === 'success') {
          out.slaveId = r.slaveId;
          out.funcCode = r.funcCode;
          out.pduHex = P.bytesToHex(r.pdu);
        }
        if (r.type === 'exception') {
          out.slaveId = r.slaveId;
          out.exceptionCode = r.exceptionCode;
          out.exceptionText = MODBUS_EXCEPTION_TEXT[r.exceptionCode] || '未知异常';
        }
        if (r.type === 'crc_error') {
          out.note = '响应帧的 CRC 校验失败，可能是波特率/校验位不匹配或线路噪声。';
        }
        return out;
      },

      'modbus.log': async args => {
        const max = Math.min(Number(args && args.max) || 20, 100);
        return { frames: (modbusLog || []).slice(-max) };
      },

      'ui.action': async args => {
        const action = args && args.action;
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };

        switch (action) {
          case 'clear': clearTerminal(); break;
          case 'pause':
            if (!isPaused) togglePause();
            // 让轨迹本身带上这个事实：暂停期间到达的数据被直接丢弃、且 dropped 不会
            // 反映它（spec §4.4：AI 在"以为输出连续"的前提下做判断比收到报错更危险）。
            // 工具描述里也写了，但描述只在模型的上下文里；这一行落在**事后可导出**的
            // 终端日志里，是追溯时唯一看得到的形态。
            audit('注意：暂停期间到达的串口数据会被直接丢弃且无法补读，恢复后 serial_read 的 dropped 仍为 0；需要不丢数据的观察窗口请用 serial_read 拉取，不要 pause');
            break;
          case 'resume': if (isPaused) togglePause(); break;

          // applySettings() 从 DOM 读值、不接参数，所以先回填输入框再调用。
          // 它本身不落盘，需补 saveState()。
          case 'set_theme': {
            const themes = ['green', 'amber', 'cyan', 'white'];
            if (!themes.includes(args.theme)) {
              throw err(P.ERROR_CODES.INVALID_ARGS, `theme 必须是 ${themes.join('/')} 之一`);
            }
            set('colorTheme', args.theme);
            applySettings(); saveState();
            return { theme: settings.colorTheme };
          }
          case 'set_font': {
            const size = Number(args.size);
            if (!Number.isFinite(size) || size < 8 || size > 48) {
              throw err(P.ERROR_CODES.INVALID_ARGS, 'size 必须是 8-48 之间的数字');
            }
            set('fontSize', size);
            applySettings(); saveState();
            return { fontSize: settings.fontSize };
          }
          case 'toggle_sidebar': toggleSidebar(); break;

          // 宏的行为必须与人工点击 ▶ 完全一致（含 EOL 追加），所以照样走 sendData
          case 'run_macro': {
            if (!isConnected) throw err(P.ERROR_CODES.PORT_NOT_CONNECTED, '端口未连接，无法执行宏');
            const m = (macros || []).find(x => x.label === args.name);
            if (!m) {
              const names = (macros || []).map(x => x.label).join('、');
              throw err(P.ERROR_CODES.INVALID_ARGS,
                `找不到宏「${args.name}」。现有宏：${names || '（无）'}`);
            }
            await sendData(m.cmd);
            return { ran: m.label, command: m.cmd };
          }
          case 'list_macros':
            return { macros: (macros || []).map(m => ({ label: m.label, cmd: m.cmd })) };
          case 'save_log': await saveLog(); break;
          default: throw err(P.ERROR_CODES.INVALID_ARGS, '未知 action: ' + action);
        }
        return { action, ok: true };
      },

      'ui.inspect': async () => {
        const out = document.getElementById('terminalOutput');
        const rows = out ? Array.from(out.children).slice(-20) : [];
        const chkHex = document.getElementById('chkHex');
        return {
          // 显示模式来自 #chkHex 复选框（不是 #chkHexInput，那个管输入模式）
          hexDisplay: !!(chkHex && chkHex.checked),
          theme: settings.colorTheme,
          fontSize: settings.fontSize,
          maxLines: settings.maxLines,
          paused: !!isPaused,
          sidebarOpen: !!sidebarOpen,
          lineCount: rows.length,
          lastLines: rows.map(el => {
            const content = el.querySelector('.line-content') || el;
            return {
              text: content.textContent || '',
              // 取计算后颜色，AI 才能验证 ANSI 解析与关键字高亮的实际效果
              color: getComputedStyle(content).color,
              className: el.className || '',
            };
          }),
        };
      },

      'dev.serial_source': async args => {
        const mode = args && args.mode;
        if (mode === 'fake') {
          if (isConnected || modbusConnected) {
            throw err(P.ERROR_CODES.INVALID_ARGS, '切到假设备前必须先断开真实串口');
          }
          const fake = new FakeSerial.FakeSerialPort({
            rules: (args.rules || []),
          });
          serialProvider = {
            requestPort: async () => fake,
            getPorts: async () => [fake],
          };
          state.serialSource = 'fake';
          state.fakePort = fake;
        } else if (mode === 'real') {
          if (state.fakePort && isConnected) await disconnectPort();
          // 直接引用页面声明的真实实现，不在这里重写一份——
          // 重写会让"优先用已授权端口"那条策略被悄悄丢掉
          serialProvider = root.realSerialProvider;
          state.fakePort = null;
          state.serialSource = 'real';
        } else {
          throw err(P.ERROR_CODES.INVALID_ARGS, 'mode 必须是 real 或 fake');
        }
        return { source: state.serialSource };
      },

      'dev.fake_inject': async args => {
        requireFake();
        const a = args || {};
        // 这里的默认值必须是 hex，与 dev_serial 工具 schema 声明的 default 一致。
        // dispatchTool 不会把 schema 默认值 materialize 进 args，默认值只能在页面侧落实；
        // 若沿用 normalizeSendArgs 的 ascii，文档化的 {data:'41'} 会注入 0x34 0x31，
        // 静默匹配不上任何 fake_script 规则，症状是"设备从不回应"，极难归因。
        // （serial.send 的默认仍是 ascii——那是它 schema 声明的默认值，两者不可混同。）
        const { bytes } = normalizeSendArgs({ data: a.data, encoding: a.encoding || 'hex' });
        state.fakePort.injectBytes(bytes);
        return { injected: bytes.length };
      },

      'dev.fake_capture': async args => {
        requireFake();
        const all = state.fakePort.capturedBytes;
        if (args && args.clear) state.fakePort.clearCaptured();
        return { hex: P.bytesToHex(all), length: all.length };
      },

      'dev.fake_script': async args => {
        requireFake();
        state.fakePort.setRules((args && args.rules) || []);
        return { ruleCount: ((args && args.rules) || []).length };
      },
    };

    function requireFake() {
      if (state.serialSource !== 'fake') {
        throw err(P.ERROR_CODES.INVALID_ARGS, '当前不是假设备模式，请先 dev.serial_source 切到 fake');
      }
    }

    // ── 请求处理 ──
    /**
     * 页面侧快照：args 里没有、只有页面才知道的事实，供 describeWrite 使用。
     *
     * 轮询参数必须读 **mv\***（右侧 Modbus 视图）而不是 mb\*：调用链是
     *   modbusStartCycle → modbusViewSend → modbusViewSync（此处用 mv* 覆盖 mb*）
     *   → modbusSend（到这一步才构造帧）
     * 而 mvSlaveId/mvFuncCode/mvAddress/mvQuantity 没有任何 JS 赋值，只有 HTML 默认值。
     * 所以 AI 每调一次 modbus.request（它只写 mb*）两个表单就分叉一次，
     * 此后读 mb* 报出的目标与实际轮询发往的目标不是一回事——那正是虚假审计记录。
     * （间隔字段本来就读 mvCycleInterval，说明这里必须与轮询同源。）
     *
     * 注意：这里**不能**为了对齐而调用 modbusViewSync()——那会改动用户可见的表单，
     * 还会经 modbusToggleAddrMode() 重算 modbusAddrHex，把 modbus.request 特意设定的
     * DEC 地址模式一起带偏。只做纯读取。
     */
    function readPageSnapshot(domain, op, args) {
      const val = id => {
        const el = document.getElementById(id);
        return el ? el.value : undefined;
      };
      const snapshot = {};
      if (domain === 'modbus' && (args || {}).action === 'cycle_start') {
        snapshot.cycle = {
          slaveId: val('mvSlaveId'), funcCode: val('mvFuncCode'), address: val('mvAddress'),
          quantity: val('mvQuantity'), writeData: val('mvWriteData'),
          cycleIntervalMs: val('mvCycleInterval'),
        };
      }
      if (domain === 'ui' && (args || {}).action === 'run_macro') {
        const m = (macros || []).find(x => x.label === (args || {}).name);
        snapshot.macroCmd = m ? m.cmd : undefined;   // 宏不存在时由 handler 报 INVALID_ARGS
      }
      return snapshot;
    }

    async function handleReq(msg) {
      const opKey = `${msg.domain}.${msg.op}`;
      const handler = OPS[opKey];
      if (!handler) {
        return P.makeErr(msg.id, P.ERROR_CODES.OP_UNSUPPORTED, `本页面不支持操作 ${opKey}`);
      }
      const caps = ['serial', 'modbus', 'ui', 'dev'];
      if (!caps.includes(msg.domain)) {
        return P.makeErr(msg.id, P.ERROR_CODES.OP_UNSUPPORTED, `本页面不支持域 ${msg.domain}`);
      }
      // 武装检查与审计一并放进 try：readPageSnapshot 要读 DOM、describeWrite 要解析
      // 参数，任何一处抛错都会越过下面的 catch 落到 ws.onmessage 的外层 catch——
      // 那条路径**不发响应**，AI 只能白等 30s 超时。本文件的铁律是任何路径都不得把
      // 异常抛回页面代码，等价地：也不得有任何一条路径不给响应。
      try {
        if (isWriteOp(msg.domain, msg.op, msg.args)) {
          if (!isArmed()) {
            return P.makeErr(msg.id, P.ERROR_CODES.NOT_ARMED,
              'AI 写入未启用。请在页面上打开"允许 AI 写入"开关后重试（读取类操作不受限制）。');
          }
          // 审计在这里集中做，不下放到各 handler：spec 第 5.5 节把 [AI] 轨迹定为
          // "不做逐次确认"的唯一补偿控制，覆盖必须是结构性的——散着写迟早会漏掉一个，
          // 而漏掉的那个（比如"启动轮询"）正是事后唯一说不清的操作。
          // 审计行本身不得因参数问题消失，故 describeWrite 保证不抛。
          audit(describeWrite(msg.domain, msg.op, msg.args,
            readPageSnapshot(msg.domain, msg.op, msg.args)));
        }
        const data = await handler(msg.args || {});
        return P.makeRes(msg.id, data);
      } catch (e) {
        const code = P.isErrorCode(e && e.code) ? e.code : P.ERROR_CODES.PAGE_ERROR;
        const message = (e && e.message) || String(e);
        // 写操作失败必须补一条结果行：只有"意图"行而无结果行，事后会把一次被拒的
        // 请求读成真的发出去过——虚假的审计记录比缺失的记录更糟（同 modbus.request 的校验顺序）。
        if (isWriteOp(msg.domain, msg.op, msg.args)) audit('✖ 失败：' + message);
        return P.makeErr(msg.id, code, message);
      }
    }

    // ── WS 连接与重连 ──
    /** WS URL 从 location 推导，不写死 ws://：页面按 CLAUDE.md 可以用 https 打开
     *  （server.js 也接受 https 来源），而 https 页面连 ws:// 会被混合内容策略直接拦掉——
     *  表现为"永远连不上且在无限重试"，终端里却一个字都没有。 */
    function bridgeUrl() {
      const scheme = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss:' : 'ws:';
      const host = (typeof location !== 'undefined' && location.host) ? location.host : 'localhost';
      return `${scheme}//${host}/bridge`;
    }

    function connectBridge() {
      let ws;
      const url = bridgeUrl();
      try {
        ws = new WebSocket(url);
      } catch (e) {
        scheduleRetry();
        return;
      }
      state.ws = ws;

      ws.onopen = () => {
        state.retryMs = 1000;
        state.everOpen = true;
        try {
          ws.send(JSON.stringify({
            kind: 'hello', role: 'page', pageId: state.pageId,
            protocolVersion: P.PROTOCOL_VERSION, appVersion: '2.2',
            capabilities: ['serial', 'modbus', 'ui', 'dev'],
          }));
        } catch { /* 已断开，交给 onclose 重连 */ }
      };

      ws.onmessage = async e => {
        // 整个处理器包住：async 函数里逃逸的异常会变成 unhandled rejection，
        // 在控制台里显示成错误——桥的毛病不该看起来像页面的毛病
        try {
          let msg;
          try { msg = JSON.parse(e.data); } catch { return; }

          // 桥用自己的 kind:'error' 通报拒绝（目前只有协议版本不匹配）。
          // isValidEnvelope 只认 req/res/evt，若把它与其它未知消息一起丢掉，
          // 版本不匹配就变成"页面静默重连、AI 永远超时"的无解谜题。
          if (msg && msg.kind === 'error') {
            state.rejected = true;
            audit('桥拒绝了连接：' + (msg.message || '未提供原因'));
            return;
          }

          if (!P.isValidEnvelope(msg) || msg.kind !== 'req') return;
          const res = await handleReq(msg);
          try { ws.send(JSON.stringify(res)); } catch { /* 已断开 */ }
        } catch (e) {
          try { console.warn('[bridge-client] 处理桥消息失败：', e); } catch { /* 忽略 */ }
        }
      };

      ws.onclose = () => {
        state.ws = null;
        // 从没连上过就说一声，且只说一次：端口不符、混合内容拦截、服务端没装依赖
        // 都会让重连永远失败，而"终端里什么都没发生"让人根本想不到问题出在桥这一侧。
        // 只报一次是为了不刷屏；不弹错误、不阻塞 UI 的约束照旧。
        if (!state.everOpen && !state.warnedNoBridge) {
          state.warnedNoBridge = true;
          audit(`未能连接本机 AI 桥（${url}），AI 控制不可用；终端自身功能不受影响`);
        }
        scheduleRetry();
      };
      ws.onerror = () => { try { ws.close(); } catch { /* 忽略 */ } };
    }

    function scheduleRetry() {
      // 被桥明确拒绝过就别再连了：重连不会让协议版本对上，只会周期性地刷屏
      if (state.rejected) return;
      // 指数退避，1s → 30s 封顶。不弹错误、不阻塞 UI
      setTimeout(connectBridge, state.retryMs);
      state.retryMs = Math.min(state.retryMs * 2, 30000);
    }

    // ── 把终端输出灌进环形缓冲 ──
    window.bridgeNoteOutput = function (line) {
      try { rb.push(line); } catch { /* 不得外泄 */ }
    };

    /** OPS 依赖的页面全局函数。页面是单文件、易被重构，缺一个函数会让对应的 MCP 工具
     *  静默退化成超时——不如启动时就在终端里点名，比事后猜快得多。 */
    const REQUIRED_PAGE_API = [
      'connectPort', 'disconnectPort', 'clearTerminal', 'togglePause', 'toggleSidebar',
      'sendData', 'saveLog', 'applySettings', 'saveState', 'appendLine',
      'modbusSetMode', 'modbusConnectPort', 'modbusDisconnectPort', 'modbusToggleActive',
      'modbusStartCycle', 'modbusStopCycle', 'modbusSend', 'modbusConstructFrame',
      'modbusShowResponse', 'modbusAddLog', 'modbusParseAddress', 'modbusViewSyncAddrMode',
    ];
    function verifyPageApi() {
      const missing = REQUIRED_PAGE_API.filter(n => typeof window[n] !== 'function');
      if (missing.length) audit('警告：页面缺少 AI 桥依赖的函数 → ' + missing.join('、'));
      return missing;
    }

    document.addEventListener('DOMContentLoaded', () => {
      try {
        syncArmedUI();
        const toggle = document.getElementById('aiArmedToggle');
        if (toggle) toggle.addEventListener('change', () => setArmed(toggle.checked));
        installModbusCapture();
        verifyPageApi();
        connectBridge();
      } catch (e) {
        try { console.warn('[bridge-client] 启动失败，AI 控制不可用：', e); } catch { /* 忽略 */ }
      }
    });

    return { state, isArmed, setArmed, connectBridge, verifyPageApi, REQUIRED_PAGE_API };
  }
});
