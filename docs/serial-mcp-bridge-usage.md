# 串口 MCP 桥 · 使用说明

> 一页速查。**完整参考见 [`serial-mcp-bridge.md`](./serial-mcp-bridge.md)**（部署细节、排障、错误码表、11 个工具逐项说明）。

## 这是什么

让 AI 工具（Claude Code 等）通过 MCP 操作 WebTerm Pro 的串口调试能力：开发期用假设备跑通链路，运行期操作真机。

```
Claude Code ──stdio──► mcp-server.js ──ws://127.0.0.1:1982/bridge──► bridge.js（挂在 server.js 进程内）
                                                                            │ ws
                                                                            ▼
                                                                     浏览器页面 ──► Web Serial ──► 串口
```

桥挂在 `server.js` 里，所以**进程没了桥就没了**，而页面可以比它活得久（见 §六.G：停掉 `server.js` 页面仍能当终端用）。反方向并不对称：进程活着、桥也可能压根没挂上（没装依赖、token 写不出来、装配失败——见 `serial-mcp-bridge.md` §7.4），那时终端照常可用，只有 AI 用不了。不需要额外的常驻进程。多个 AI 会话各起一个适配器连同一个桥，不会抢端口。

---

## 一、前置：两件不做就会白折腾的事

**1. `npm install`。**

桥依赖 `ws`。**终端本身的静态服务与日志保存不依赖任何外部模块**——缺依赖时终端照常可用，启动会明确提示 AI 桥不可用及原因。所以：想用 AI 桥，先装依赖。

**2. 确认 1982 端口上没有"本分支之前"的旧 `server.js`。**

如果这个端口被一个更早启动的、不认识 `/bridge` 的进程占着，症状会极具误导性：页面永远 `PAGE_NOT_CONNECTED`，而 `mcp-server.js` 看起来又"连上了"。

**最可靠的判定方式**：直接起服务端，看它是否抱怨端口被占——

```bash
npm start
# 若输出「端口 1982 已被占用，请关闭占用进程后重试」并退出，则确实有旧进程占着
```

再找出并结束它：

```powershell
Get-NetTCPConnection -LocalPort 1982 -State Listen | Select-Object OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId=<上面查到的PID>" | Select-Object CommandLine
# 确认那是一条旧的 server.js（启动时间早于本次、或指向另一份代码）后：
taskkill /PID <PID> /F
```

> ⚠️ **不要用 `curl http://127.0.0.1:1982/bridge` 的 404 当作判据。** 新旧服务器上它**都是 404**：`server.js` 的 HTTP 处理器只特判 `/api/save-log`，其余交给静态文件服务，而 `/bridge` 没有对应文件。`/bridge` 只接受 WebSocket **升级**请求，普通 GET 区分不出是哪一版在跑。判据只能是进程本身。

---

## 二、快速开始（5 步）

```bash
# 1. 装依赖（只需一次）
npm install

# 2. 起服务端 —— 会同时生成本次会话的桥 token
npm start
# → WebTerm Pro running at http://localhost:1982
# → [bridge] token 已写入 C:\Users\<你>\.webterm\bridge-token

# 3. 浏览器打开 http://localhost:1982 （Chrome 89+ / Edge 89+）
#    页面侧会自动连上桥

# 4. 在**本目录**下启动 Claude Code
claude
#    首次会询问是否信任本项目的 MCP 服务器 —— 需选允许
#    用 /mcp 确认 webterm-serial 已连接

# 5. 首次连串口：必须真人点一次页面上的「连接」按钮（原因见下）
```

### 为什么第一次必须真人点

Web Serial 的 `requestPort()` **每次都弹选择框、且必须由用户手势触发**——即使页面已经持有授权端口也一样。AI 无法伪造用户手势。

所以路径是：**真人授权一次 → 之后 AI 全自动**。真人点过一次之后，AI 的 `serial_connect` 会直接取已授权端口，不再需要人。

> **一个已知未实测的假设**：AI 免手势重连依赖 `navigator.serial.getPorts()` 不需要用户手势。这一点来自浏览器规范描述，**未在本机实测**。若在某个浏览器版本上不成立，退路是每次由真人点一次连接——体验降级，但不影响可用性。

---

## 三、日常用法

### 武装开关：「允许 AI 写入」

页面侧栏的开关，**默认关闭**，状态记在 `localStorage` 的 `wtp_ai_armed`。

| | 关（默认） | 开 |
|---|---|---|
| 读取类操作 | 可用 | 可用 |
| 写入类操作 | 返回 `NOT_ARMED` | 可用 |

读取类白名单：`serial.status`、`serial.read`、`modbus.status`、`modbus.log`、`ui.inspect`、`ui.list_macros`、`dev.fake_capture`。其余都算写入。

**AI 的每个写入操作都会在终端日志留下一条 `[AI]` 前缀的记录**（失败时另有一条 `✖ 失败`）。这是"不做逐次确认"这个取舍的补偿控制——事后可追溯，且会随日志导出一起保存。

### 按任务找工具

| 我想…… | 调用 |
|---|---|
| 看整体状态（两套串口栈） | `webterm_status` |
| 连/断终端串口 | `serial_connect` / `serial_disconnect` |
| 发数据（ASCII / HEX / base64） | `serial_send` |
| 读输出（按游标取增量） | `serial_read` |
| 清屏 / 暂停 / 继续 | `ui_action {action:"clear"\|"pause"\|"resume"}` |
| Modbus 模式、连接、启停轮询 | `modbus_control` |
| 发一条 Modbus 请求并拿结果（原始 TX/RX 帧） | `modbus_request` |
| 看 Modbus 历史报文 | `modbus_log` |
| 主题 / 字体 / 侧栏 / 宏 / 存日志 | `ui_action` |
| 看终端**实际渲染**的颜色与行 | `ui_inspect` |
| 无硬件跑通全链路 | `dev_serial` |

### 读取必须用游标，且必须看 `dropped`

`serial_read` **首次调用不传 `cursor`**（从最旧可用位置开始），之后要传入上次返回的 `cursor`。**`dropped > 0` 表示输出量超过环形缓冲、那段数据已永久丢失**——此时不要假设输出是连续的。`truncated: true` 表示本次被 `max` 截断，用返回的 `cursor` 继续读。

---

## 四、两个必须知道的坑

### 1. `modbus_request` 只在 `independent` 模式下可用

`shared` 模式下 Modbus 复用终端端口，代价是**冻结终端的读循环**（`isPaused = true`，输入/发送按钮变灰）——响应因此无法被解析。所以在 `shared` 模式下 `modbus_request` 会**直接拒绝**并提示切到 `independent`，而不是等 500ms 后报"设备没响应"。

> 历史注记：早先的文案建议"用 `shared` 复用终端端口"来腾出被占用的端口。那句话的理由是假的——切 `shared` 确实会断开独立串口从而腾出端口，但那样 `modbus_request` 就不可用了。现已改为推荐 `serial_disconnect` / `modbus_control {action:"disconnect"}`。

### 2. `ui_action {action:"pause"}` 会丢数据

暂停期间到达的串口数据**既不渲染也不进入读取缓冲，且事后无法补读**；而 `serial_read` 的 `dropped` 仍为 0（它统计的是环形缓冲的挤占，不是暂停期间的丢弃）。

**别把 `pause` 当成"先缓冲着、待会儿再读"。** 要冻结显示又不丢数据，用 `serial_read` 自己控制节奏。

---

## 五、错误码速查

固定九项。**限流、id 冲突、请求表超限都复用 `INVALID_ARGS`**，具体原因在消息里。

| 码 | 含义 | 该怎么办 |
|---|---|---|
| `NEEDS_USER_GESTURE` | 没有已授权端口 | **停下请用户点一次「连接」**；重试无效 |
| `PORT_BUSY` | 端口被另一套栈占用 | 先 `serial_disconnect` 或 `modbus_control {action:"disconnect"}` |
| `PAGE_NOT_CONNECTED` | 桥上没有页面 | 确认浏览器已打开 `http://localhost:1982` |
| `BRIDGE_TIMEOUT` | 页面未在时限内响应 | 检查页面是否卡住 |
| `PORT_NOT_CONNECTED` | 端口未打开 | 先 `serial_connect` |
| `NOT_ARMED` | 武装开关未开 | 请用户在页面上打开开关 |
| `INVALID_ARGS` | 参数有误（或限流 / id 冲突 / 请求表超限） | 看消息里的具体原因 |
| `OP_UNSUPPORTED` | 页面不支持该域/操作 | 让用户刷新页面 |
| `PAGE_ERROR` | 页面内部错误 | 把消息转告用户 |

---

## 六、必须真人做的验证清单

> 以下需要**真实浏览器（Chrome/Edge 标签页）+ 真人点击**，自动化环境无法覆盖。硬件需求按节而异：**D 明确无需硬件**（见该节标题，全程用假设备闭环）；**E 也无需硬件**——第 1–4、6 步用 D 那套假设备即可跑完，第 5 步见该节的顺序说明；**F、以及 B 的连设备一步需要真实串口设备**（F 要验的正是"设备确实没收到""设备确实收到了"，必须有真设备在旁佐证）；A、C、G 只需服务端与页面。
> 已在测试中以替身尽可能覆盖，但下面这些**只能由人确认**。请按序执行，每步都有期望值。

### A. 前置（必做，否则后面全部会被误导）

先按上面第一节第 2 条，**结束占用 1982 的旧进程**。

### B. ★ 最优先：点「连接」是否仍弹选择框

这一条之所以最优先：本次改动动了串口获取路径（引入 `serialProvider` 间接层）。接缝的**逻辑**已有单测锁死，但**"真人点按钮仍然会弹出串口选择框"只能在真实浏览器里确认**。

1. 打开 `chrome://settings/content/serialPorts`，删掉 `localhost:1982` 的既有授权
2. 刷新 `http://localhost:1982`
3. 点页面上的「连接」

**期望**：**弹出串口设备选择框**，选设备后正常连接、终端可收发。
**若没有弹框** ⇒ 串口获取路径被改坏了，**这是本次最需要发现的问题**。

### C. 页面加载自检

页面**刚加载完**（不需要任何 AI 调用），终端日志里**不得出现**：

```
[AI] 警告：页面缺少 AI 桥依赖的函数 → <函数名列表>
```

出现 ⇒ `Ctrl+F5` 强刷；仍出现 ⇒ 页面代码真的不匹配，先修这个（它只是告警，页面照常能当终端用，所以不看日志会漏掉）。

### D. 假设备闭环（无需硬件）

前置：`npm install` → `npm start` → 开页面 → **确认 C 无告警** → **打开「允许 AI 写入」** → `/mcp` 确认 `webterm-serial` 已连接。

| # | 调用 | 期望 |
|---|---|---|
| 1 | `dev_serial {action:"serial_source", mode:"fake"}` | `{source:"fake"}` |
| 2 | `dev_serial {action:"fake_script", rules:[{matchHex:"0103000000", respondHex:"0103030064000a", delayMs:20}]}` | `{ruleCount:1}` |
| 3 | `serial_connect` | `{connected:true}` |
| 4 | `serial_send {data:"01030000000A", encoding:"hex"}` | `{bytesWritten:6}`，且终端出现 `[AI]` 前缀、含 `01030000000a` 的记录 |
| 5 | `dev_serial {action:"fake_capture"}` | `{hex:"01030000000a"}` —— 证明字节确实写进了假串口 |
| 6 | `serial_read {cursor:0}` | 出现假设备回注的响应行 |
| 7 | `modbus_control {action:"set_mode", mode:"independent"}` | 含 `mode:"independent"` 与 `terminalFrozen:false` |

> 第 2 步的 `respondHex` 尾随 CRC 是**刻意不合法**的（为了让这个示例保持简短）：`matchHex` 只对 TX 做前缀匹配，`serial_read` 只显示不校验 CRC，所以在这条假设备链路里照常工作。**要验 Modbus 面板或 `modbus_request`，请用一对合法帧**：请求 `010300000001840a`、应答 `0103020064b9af`。

### E. ★★ `shared` 模式的响应前提（风险最高，自动化覆盖为 0）

**为什么要单列**：D 表只走到 `serial_send` / `serial_read` / `set_mode`，而风险最高的行为——**`shared` 模式到底能不能收到 Modbus 响应**——在自动化里恰好被跳过（测试沙箱里 `modbusFeedResponse` 是空函数）。代码里"`shared` 模式下拒绝 `modbus_request`"这条前置**所依据的前提本身，只有**人工**能证实**。

**前置（同 D，但这里漏了会误判）**：`npm install` → `npm start` → 开页面 → 确认 C 无告警 → **打开「允许 AI 写入」** → `/mcp` 确认 `webterm-serial` 已连接。

> 武装开关这一步在 E 节尤其不能漏：第 2 步的 `modbus_control` 与第 4 步的 `modbus_request` 都是**写入类**操作，未开开关时它们会在写审计之前就被拦下，返回一条**光秃秃的 `NOT_ARMED`**——终端里既不出现意图行、也没有 `✖ 失败` 行，看起来就像工具坏了。

**第一步：在页面里直接验前提（这一步的发送在页面里手点，不经过 AI，从而绕开 `modbus_request` 的守卫）**

1. 先连上该串口
2. `modbus_control {action:"set_mode", mode:"shared"}` → `modbus_control {action:"activate"}`
   - **期望**：终端输入框/发送按钮变灰（`isPaused` 生效）
3. **让从站保持在线**，在页面右侧 Modbus 视图里手点发送（功能码 03、地址 0、数量 1）
   - **期望 A**：RX 显示 **`响应超时 (500ms)`**，即使串口助手能看到从站确实回了帧
     → **前提成立**，`shared` 下拒绝 `modbus_request` 是对的
   - **期望 B（若出现，请立刻回报）**：RX 正常显示寄存器值
     → **前提不成立**，那道守卫属误伤，需要撤掉并把文案改回"可切到 shared"。**这一条比清单里其它任何一项都重要。**

**第二步：AI 侧的期望**

4. `modbus_request {slaveId:1, funcCode:3, address:0, quantity:1}`
   - **期望**：**立刻**返回参数错误（不再等 500ms、不再出现"设备没响应"），终端留下"意图 + `✖ 失败`"两条 `[AI]` 记录
5. `modbus_control {action:"set_mode", mode:"independent"}` → `serial_disconnect` → `modbus_control {action:"connect"}` → 重发第 4 步
   - **顺序不能反：先 `set_mode independent`，再 `serial_disconnect`。** 反过来先断开终端会连带停用 Modbus（`disconnectPort()` 对 `shared` 模式调 `modbusToggleActive()`，`modbusActive` 随之置假），此后重发第 4 步只会得到 `INVALID_ARGS: Modbus 未启用，请先 modbus_control activate`，拿不到 `outcome:"success"`；切模式不触发它，`modbusActive` 保持为真。断开终端本身是因为独立模式开的是**它自己的**端口：终端仍连着时 `connect` 会对**同一个端口对象**再 `open()` 一次，假设备下 `fake-serial.js` 的 `open()` 明确抛 `端口已打开`。
   - **期望**：`outcome:"success"`，并带完整 TX/RX 帧（`txHex`/`rxHex`）、`pduHex`、`responseTimeMs`、`slaveId`、`funcCode`
   - **注意**：返回的是**原始帧 + PDU，不是解析后的寄存器值**（也没有线圈位图）。要读寄存器得自己解 `pduHex`——功能码 03/04 的 `pduHex` **首字节是功能码，第 2 字节才是字节数**，之后每 2 字节一个寄存器、大端序（字节数 = 2 × 寄存器个数）。例：`03020064` = 功能码 03、字节数 02、一个寄存器 `0x0064` = 100。另注：CRC 校验失败时**没有** `pduHex`，只给 `txHex`/`outcome`/`rxHex`/`responseTimeMs`/`note`。多格式（HEX/U16/I16/F32）渲染只存在于页面自己的表格里，MCP 工具不上报它。
6. `modbus_control {action:"deactivate"}` → 终端输入框恢复可用

**本节不需要真实设备也能跑**（用 D 那套假设备）：按 D 的前 3 步切到假设备并 `serial_connect`，再用 `fake_script` 换成**合法帧对**（请求 `010300000001840a`、应答 `0103020064b9af`）即可逐条复现上面两步：

- **期望 A 照常出现**。假设备的应答被注进终端读循环正在消费的**同一条** `ReadableStream`（`fake-serial.js` 命中规则后 `_controller.enqueue`），读循环确实读到了它——`serial_status` 的 `counters.rxBytes` 会**上涨**——随后才在暂停分支丢弃，面板显示 `响应超时 (500ms)`。**rxBytes 上涨 + 面板超时**同时出现，就是"从站确实回了帧、页面却收不到"的完整证据，与真机走的是同一段代码；真设备只是把"帧确实回了"从脚本规则换成物理事实。
- **第 4 步与硬件无关**：`shared` 模式下 `modbus_request` 由守卫直接拒绝，它只看模式，不看端口是真是假。
- **第 5 步按上面的顺序**（先 `set_mode independent`、再 `serial_disconnect`）即可（假设备同样只有一个端口对象）。

### F. 真实硬件

1. **关闭**「允许 AI 写入」→ `serial_send` → 必须返回 `NOT_ARMED`，且**用串口助手确认设备没收到任何数据**
2. **打开**开关 → `serial_send` → 成功，设备确实收到
3. 无已授权端口时 `serial_connect` → 应返回 `NEEDS_USER_GESTURE`；真人点一次「连接」后重试 → 成功
4. `ui_inspect` → 返回真实渲染行与**计算后颜色**（验证 ANSI 解析与高亮）

### G. 桥挂掉不影响终端

1. 页面开着，`Ctrl+C` 停掉 `server.js`
2. **期望**：页面终端**仍能正常收发**；WS 断开会触发重连，但**不弹错、不卡 UI**
3. 重新 `npm start` → **期望**：30 秒内自动重连（退避 1s→2s→…→30s 封顶），「允许 AI 写入」的勾选状态仍在

---

## 七、已知限制

- **AI 免手势重连未经实测**（见第二节末尾）。它是本次交付里被明确标注为「未验证」的假设之一——§六.B（真人点「连接」是否仍弹选择框）与 §六.E（`shared` 模式能否收到响应）同样未经实测，但 §六.E 与硬件无关、可用假设备复现，只有 §六.B 非真实浏览器不可；三条的验证步骤都在第六节。
- **`pause` 会丢数据**（见第四节）。
- **`modbus_request` 在 `shared` 模式下不可用**（见第四节）。
- **AI 写入无逐次确认门**：这是刻意的取舍，补偿控制是武装开关 + 全量 `[AI]` 审计日志。请按需开关。
- **TFTP 工具未纳入本次范围**。附带记录：`tftp-proxy.js` 绑 `0.0.0.0` 且无 `Origin` 校验，浏览任意网站均可连 52345 触发 TFTP 上传（已知问题，本次未处理）。
