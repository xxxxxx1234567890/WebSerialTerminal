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

  /**
   * 复刻 modbusSend() 从 #mbWriteData 解析写数据的规则，用来在页面之外重建
   * 它即将发送的帧（见 modbus.request 的 txHex）。必须与页面完全一致——
   * 回给 AI 的 txHex 若与实际上线缆的字节不同，比不返回更糟：
   * AI 会拿它去追一个并不存在的差异。
   * modbusConstructFrame 对 FC5/6 取 16 位整数，对 FC15/16 取字节数组。
   */
  function parseWriteData(funcCode, raw) {
    const tokens = String(raw).trim().split(/[\s,]+/).map(s => parseInt(s, 16));
    return funcCode <= 6 ? (tokens[0] << 8 | tokens[1]) : new Uint8Array(tokens);
  }

  if (isNode) {
    return { makeRingBuffer, normalizeSendArgs, classifyWrite, isWriteOp, parseWriteData };
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
      // 桥明确拒绝过我们（目前只有协议版本不匹配这一种）。这是终局状态：
      // 重连不会变好，只会每 30 秒往终端里再刷一条同样的告警。
      rejected: false,
    };

    const err = (code, message) => Object.assign(new Error(message), { code });

    // ── 武装开关：默认关闭 ──
    // 用独立的 localStorage 键，不塞进 wtp_settings：saveState() 按 settings 的固定字段整体
    // 回写，往里加额外字段可能在下次保存时被覆盖掉。独立键也便于用户单独清除。
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
        if (isConnected) return { alreadyConnected: true };
        // 走 withAuthorizedPort：AI 免手势，绝不弹选择框（人工点按钮才弹）
        await withAuthorizedPort(args && args.index, () => connectPort());
        if (!isConnected) throw err(P.ERROR_CODES.PAGE_ERROR, '连接未成功建立');
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
        audit('→ ' + P.bytesToHex(bytes));
        await writer.write(bytes);
        txBytes += bytes.length;
        updateCounters();
        const chk = document.getElementById('chkLocalEcho');
        if (chk && chk.checked) appendLine('tx', P.bytesToHex(bytes));
        return { bytesWritten: bytes.length };
      },

      'serial.read': async args => {
        const max = Math.min(Number(args && args.max) || READ_DEFAULT, P.READ_MAX_LINES);
        const cursor = Number(args && args.cursor) || 0;
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
          case 'cycle_start': modbusStartCycle(); break;
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
        const hasWriter = modbusPortMode === 'independent' ? modbusConnected : isConnected;
        if (!hasWriter) throw err(P.ERROR_CODES.PORT_NOT_CONNECTED, 'Modbus 当前没有可用串口');
        // 截获点是单例：并发请求会互相顶掉，结局是两条都超时，
        // 而超时消息完全指不到真正的原因。显式拒绝比让它们悄悄踩踏好。
        if (mbCapture) {
          throw err(P.ERROR_CODES.PAGE_ERROR, '已有 Modbus 请求在等待响应，请串行调用');
        }

        const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };
        set('mbSlaveId', a.slaveId);
        set('mbFuncCode', a.funcCode);
        set('mbQuantity', a.quantity);
        // 地址必须按 DEC 解析：modbusParseAddress() 看 modbusAddrHex 决定进制。
        // 两个地址模式复选框要一起置成 DEC 再同步——modbusViewSyncAddrMode() 会用
        // #mvAddrMode 覆盖 #mbAddrMode 并重算 modbusAddrHex，只写变量会被它改回去，
        // 于是 AI 给的十进制地址被当成十六进制解析，静默发到错误地址上。
        const mvAddrMode = document.getElementById('mvAddrMode');
        if (mvAddrMode) mvAddrMode.checked = false;
        modbusAddrHex = false;
        if (typeof modbusViewSyncAddrMode === 'function') modbusViewSyncAddrMode();
        set('mbAddress', a.address);
        if (a.writeData !== undefined && a.writeData !== null) set('mbWriteData', a.writeData);
        if (typeof modbusOnFuncCodeChange === 'function') modbusOnFuncCodeChange();

        const writeData = (MODBUS_WRITE_FUNCS.includes(Number(a.funcCode)) && a.writeData)
          ? parseWriteData(Number(a.funcCode), a.writeData)
          : null;
        const frame = modbusConstructFrame(a.slaveId, a.funcCode, a.address, a.quantity, writeData);
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
          case 'pause': if (!isPaused) togglePause(); break;
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
            audit(`宏「${m.label}」→ ${m.cmd}`);
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
          audit('串口源已切到假设备');
        } else if (mode === 'real') {
          if (state.fakePort && isConnected) await disconnectPort();
          // 直接引用页面声明的真实实现，不在这里重写一份——
          // 重写会让"优先用已授权端口"那条策略被悄悄丢掉
          serialProvider = root.realSerialProvider;
          state.fakePort = null;
          state.serialSource = 'real';
          audit('串口源已切回真实设备');
        } else {
          throw err(P.ERROR_CODES.INVALID_ARGS, 'mode 必须是 real 或 fake');
        }
        return { source: state.serialSource };
      },

      'dev.fake_inject': async args => {
        requireFake();
        const { bytes } = normalizeSendArgs(args);
        state.fakePort.injectBytes(bytes);
        audit('假设备注入 ' + P.bytesToHex(bytes));
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
      if (isWriteOp(msg.domain, msg.op, msg.args) && !isArmed()) {
        return P.makeErr(msg.id, P.ERROR_CODES.NOT_ARMED,
          'AI 写入未启用。请在页面上打开"允许 AI 写入"开关后重试（读取类操作不受限制）。');
      }
      try {
        const data = await handler(msg.args || {});
        return P.makeRes(msg.id, data);
      } catch (e) {
        const code = P.isErrorCode(e && e.code) ? e.code : P.ERROR_CODES.PAGE_ERROR;
        return P.makeErr(msg.id, code, (e && e.message) || String(e));
      }
    }

    // ── WS 连接与重连 ──
    function connectBridge() {
      let ws;
      try {
        ws = new WebSocket(`ws://${location.host}/bridge`);
      } catch (e) {
        scheduleRetry();
        return;
      }
      state.ws = ws;

      ws.onopen = () => {
        state.retryMs = 1000;
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

      ws.onclose = () => { state.ws = null; scheduleRetry(); };
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
