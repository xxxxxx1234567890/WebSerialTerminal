# 串口 MCP 桥 — 设计文档

> 目标：让 AI 工具（Claude Code 等）通过 MCP 控制 WebTerm Pro 的**串口调试能力**——开发期驱动自测，运行期操作真机。

## 1. 背景

WebTerm Pro 目前是"人在浏览器里点"的工具。AI 无法参与，导致两类问题：

1. **开发期**：`test/client.test.js` 是源码级结构断言（正则 + 大括号配对提取函数），注释自述"真实的降级链 UI 流程仍需手工或 E2E 验证"。**恰恰缺少"应用真实运行时的行为验证"这一层**。
2. **运行期**：串口调试需要人工收发、人工判断响应，AI 无法介入闭环。

### 1.1 关键发现（探查结论）

**发现 A：页面是全局作用域，无需重构即可驱动。**

`WebSerialTerminal.html:2280` 的 `<script>` 没有 IIFE 包裹。`connectPort`(2942)、`disconnectPort`(2979)、`sendData`(3106)、`clearTerminal`(3501)、`modbusSetMode`(4625)、`modbusRequest` 一族等全部挂在页面全局。外部投递调用即可驱动，**不需要动那 4853 行的内部逻辑**。

**发现 B：页面里有两条并行的串口栈。**

| | 终端栈 | Modbus 栈 |
|---|---|---|
| 端口对象 | `port` | `modbusPort` |
| 读循环 | `readLoop()` (3021) | `modbusReadLoop()` (4744) |
| 连接 | `connectPort()` (2942) | `modbusConnectPort()` (4678) |
| 断开 | `disconnectPort()` (2979) | `modbusDisconnectPort()` (4716) |
| 取端口 | `navigator.serial.requestPort()` (2944) | `navigator.serial.requestPort()` (4680) |

另有 `modbusPortMode` 的 **shared / independent** 两种模式：shared 模式下 Modbus 复用终端端口，代价是**冻结终端**（`isPaused = true`，输入/发送/中断按钮全部 disabled，见 4667-4671）；independent 模式下 Modbus 自己开端口。

> 注：`2026-05-23-modbus-rtu-design.md` 原计划"复用现有串口连接"，实现时演化成了双栈 + 模式开关。

**发现 C：两条栈都只从 `navigator.serial.requestPort()` 取端口。**

这使串口抽象（seam）可以极小——只需替换 2 个调用点，`readLoop` / `modbusReadLoop` 一行都不用改。

### 1.2 Web Serial 的硬约束

| 方法 | 需要用户手势？ |
|---|---|
| `navigator.serial.requestPort()` | **需要**（transient activation） |
| `navigator.serial.getPorts()` | 不需要 |
| `SerialPort.open()` | 不需要（已有授权时） |

因此：**AI 永远无法触发端口选择框**。路径是"真人手动授权一次 → 之后 AI 全自动接管"。若 `getPorts()` 路径在某个浏览器版本上不成立，退路是"AI 操作前真人点一下连接按钮"——体验降级，但不影响可行性。

**实现含义（关键，且"放在哪里"同样关键）**：`requestPort()` 每次调用都会弹出选择框并要求用户手势——**即使已存在授权端口也一样**。因此自动重连**绝不能**走 `requestPort()`，必须直接取 `getPorts()` 返回的端口对象。

但这条策略**不得放进 `serialProvider`**。那个 seam 同时服务**两条**路径——真人点按钮与 AI 调用——而真人点按钮要的恰恰是选择框。把策略放进 seam 会造成三处功能回归（均由 Task 7 审查发现）：

- **Modbus「连接独立串口」永远进不去**：Chromium 对同一物理设备只暴露一个 `SerialPort` 对象，故 `getPorts()[0]` 往往就是主连接已打开的那个，`open()` 必抛——而独立模式的存在意义正是接第二个适配器
- **已授权多个设备时用户再也选不了别的设备**（`ports[0]` 是固定选择）
- **静默失败**：与 `connectPort` 的 catch 过滤 `NotFoundError` 叠加后，点「连接」既无提示、也无选择框、也没有任何途径去授权别的设备

**正确位置是 AI 自己的入口**：`bridge-client.js` 的 `serial.connect` 与 Modbus 独立连接，在自己的调用期间临时把 `serialProvider` 替换为免手势变体，`finally` 换回。人工路径因此 100% 不变，而"授权一次、之后全自动"依然成立。见第 5.2 节与计划 Task 8 的 `withAuthorizedPort`。

另有两条次要约束：页面必须开着（AI 控制的是浏览器里的那个连接）；本地 WS 端口任何网页都能连，必须做 Origin 校验。

### 1.3 同构先例

- **[DG1001/webserial-mcp](https://github.com/DG1001/webserial-mcp)** — 架构完全一致（MCP client → WebSocket → 浏览器 → Web Serial → 设备），自带 Mock 设备用于无硬件开发
- [@thegreataxios/webmcp-bridge](https://www.npmjs.com/package/@thegreataxios/webmcp-bridge) — 本地 stdio MCP + localhost WS，绑 127.0.0.1、token 鉴权、Origin 限制
- [ofershap/real-browser-mcp](https://github.com/ofershap/real-browser-mcp)、[ICWR-TEAM/Firefox-Browser-MCP](https://github.com/ICWR-TEAM/Firefox-Browser-MCP) — 同类形状

架构照抄成熟形状，不自行发明。

## 2. 范围

### 2.1 做

- MCP 桥：MCP 工具调用 → WebSocket → 页面 → 串口
- 四个控制域：`serial`（数据 + 连接）、`modbus`、`ui`、`dev`（假设备）
- 开发期假串口（可替换的串口源），支持完整链路测试与模拟设备应答
- 运行期真机操作，全自动（无人为确认门）
- 三类测试进 CI，端到端留一层人工（仅需开页面）

### 2.2 明确不做（YAGNI）

- **多页面路由**：一期只服务一个页面（最近连接者），工具返回带 page id。多个标签页同时开是边缘情况
- **桥的消息持久化 / 重放**：不做，掉线的请求直接失败
- **页面掉线时挂起等待**：不做，立即返回明确错误
- **TFTP 相关**：本次完全不涉及
- **推送式读取**：不做（见 4.4）
- **AI 写入的逐次确认门**：不做（见 8.2）

### 2.3 已知问题（记录，本次不处理）

`tftp-proxy.js:9` 的 `new WebSocketServer({ port: 52345 })` **未传 `host`**（绑 `0.0.0.0`）且**无 Origin 校验**。WebSocket 不受同源策略约束，因此浏览任意网站时该网站均可连接 52345 触发 TFTP 上传。按用户决定，本次不修，仅记录。

> 设计含义：**形状可抄，安全基线不可抄**。本设计的桥必须显式绑回环 + 校验 Origin。

## 3. 整体架构

### 3.1 进程与连接拓扑

```
┌─────────────────────────────┐
│  Chrome 页面                 │
│  WebSerialTerminal.html      │  ← 真人开着的标签页，串口持有者
│  （WS 客户端）                │
└──────────┬──────────────────┘
           │ ws://<location.host>/bridge     Origin: http://localhost:1982
           ▼
┌─────────────────────────────┐
│  server.js 进程              │
│   ├─ HTTP: 静态文件 + save-log│
│   └─ bridge.js（挂载）        │  ← WS 服务端，唯一仲裁者
└──────────▲──────────────────┘
           │ ws://127.0.0.1:1982/bridge     无 Origin，带 token
           │
┌──────────┴──────────────────┐
│  mcp-server.js（stdio MCP）  │  ← 由 AI 工具按会话拉起，可多开
└──────────┬──────────────────┘
           │ stdio
           ▼
      Claude Code
```

页面与 MCP 适配器**都是 WS 客户端**，桥是唯一服务端。桥因此天然是消息中转与仲裁点：页面侧无需知道 AI 存在，MCP 侧无需知道页面实现。

### 3.2 决定 ①：端口复用 1982，路径 `/bridge`

用 `WebSocketServer({ noServer: true })` + 手动监听 `server.on('upgrade')`，在握手**之前**完成 Host / Origin 校验——直接复用 `server.js:51` 的 `isLocalHostname()` 与 `server.js:62` 的 `isTrustedOrigin()`，不复制代码。

### 3.3 决定 ②：两类客户端，两套鉴权

| 客户端 | 携带 | 校验方式 |
|---|---|---|
| 页面 | 有 `Origin` 头（浏览器强制发送） | `isTrustedOrigin(origin, actualPort)`；非本服务来源一律拒 |
| mcp-server.js | 无 `Origin`（非浏览器） | 一次性 token |

浏览器**总是**发送 `Origin`，所以"无 Origin"等价于"非浏览器"。于是：任何网页（即便探测到端口与路径）都因 Origin 不符被拒；本机其他进程想冒充适配器则需先拿到 token。token 由 `server.js` 启动时生成并写入受限权限文件，`mcp-server.js` 读取——**不放进环境变量**，避免泄漏到无关子进程。

token 的具体约定（消除实现歧义）：

| 项 | 约定 |
|---|---|
| 路径 | `path.join(baseDir, '.webterm', 'bridge-token')`，其中 `baseDir` 默认 `os.homedir()`。**放在仓库之外**，避免误提交；目录以 `0o700` 创建，文件以 `0o600` 写入 |
| 可测试性覆盖 | 环境变量 `WEBTERM_HOME` 可覆盖 `baseDir`。测试据此写入临时目录，**不污染真实用户目录**。这是测试 seam 而非安全缺口——能设置环境变量者本就已控制该进程 |
| 生命周期 | 每次 `server.js` 启动**重新生成**，不持久化——token 是会话级的，重启即失效 |
| 内容 | 32 字节随机数的 hex（`crypto.randomBytes(32).toString('hex')`，即 64 字符） |
| 启动顺序 | `mcp-server.js` 启动时若文件不存在或读取失败，**立即报错退出**并提示"请先启动 server.js（`npm start`）"。不静默重试——静默重试会让 AI 看到一个永远连不上的工具，比直接报错更难排查 |
| 比较 | 用 `crypto.timingSafeEqual` 比较；**长度不等时先返回 false**（`timingSafeEqual` 对不等长输入会抛异常，必须先挡） |

> Windows 无 POSIX 权限位，`0o600` 由 Node 尽力而为；实际依赖用户目录 ACL（其他用户默认不可读）。这是可接受的务实取舍——攻击者若已能以本用户身份读写用户目录，token 已不是主要短板。

### 3.4 决定 ③：页面侧 WS URL 从 `location` 推导

```js
new WebSocket(`ws://${location.host}/bridge`)
```

不硬编码端口。`server.js` 支持 `PORT=0`（系统分配空闲端口），硬编码在那种情况下连不上。

### 3.5 决定 ④：协议无状态

每个请求自带完整上下文，桥不维护"页面当前状态"的镜像。理由：页面掉线重连后任何状态镜像都会失真；无状态协议让重连退化为"等页面回来"，无需状态同步逻辑。

### 3.6 分层原则

```
Claude Code ──stdio──► mcp-server.js ──bridge 消息──► bridge.js ──► 页面
            (MCP 工具定义)  (工具→op 映射)   (哑路由)      (执行)
```

桥**只做鉴权 + 路由 + 限流，不理解任何域语义**。工具定义、参数校验、域语义全在 `mcp-server.js`。页面侧改动不碰桥，AI 侧加工具不碰桥，桥可作为基础设施单测。

## 4. 消息协议

### 4.1 信封格式

```jsonc
// 请求（mcp-server.js → 页面）
{ "id": "r-7f3a", "kind": "req", "domain": "serial", "op": "send",
  "args": { "data": "AT\r\n", "encoding": "ascii" } }

// 响应（页面 → mcp-server.js）
{ "id": "r-7f3a", "kind": "res", "ok": true, "data": { "bytesWritten": 4 } }
{ "id": "r-7f3a", "kind": "res", "ok": false,
  "error": { "code": "PORT_NOT_CONNECTED", "message": "终端未连接串口" } }

// 事件（页面主动上报，无 id）
{ "kind": "evt", "domain": "serial", "op": "state", "data": { "connected": false } }
```

`id` 由 `mcp-server.js` 生成，且必须**全局唯一**（形如 `<适配器标签>-<序号>`，适配器标签是进程启动时的随机值）——**不是"适配器内唯一"**。桥用一张全桥共享的请求表按键路由；而多个 Claude Code 会话各起一个适配器、各自从 1 开始编号，只保证适配器内唯一则必然撞车。撞车会静默摧毁活跃请求：孤儿计时器、把 `BRIDGE_TIMEOUT` 误发给第二个请求者、页面的响应只回给最后写入者。桥侧另有**冲突守卫**：遇到已在处理中的 id 时响亮拒绝（`INVALID_ARGS`），不覆盖既有条目。

> 修订记录（审查时发现）：本节原写"（适配器内唯一）"并称"桥按适配器身份 + id 路由响应"，与实现的全局请求表自相矛盾。核心不变——页面不需要知道是哪个适配器发的请求。

传输用 **JSON 文本帧**，串口数据一律 base64/hex 编码——不搞二进制帧，便于抓包排查。

### 4.2 决定 ⑤：`hello` 握手带版本与能力清单

页面连上桥的第一条消息：

```json
{ "kind": "hello", "role": "page", "pageId": "p-3f9a2c",
  "protocolVersion": 1, "appVersion": "2.1",
  "capabilities": ["serial", "modbus", "ui", "dev"] }
```

`pageId` 由页面在**加载时随机生成**（`crypto.randomUUID()` 截断），同一标签页生命周期内保持不变，刷新即换新。它只用于诊断——让工具返回能标明"当前控制的是哪个页面"，本身不做路由（一期单页面）。

页面是浏览器里的标签页，可能开了数天未刷新。桥据此提前知道"该页面不支持 modbus 域"，直接返回 `OP_UNSUPPORTED`，而非每次调用都超时。协议版本不匹配时桥**响亮拒绝**并说明原因。

### 4.3 域与操作清单

| 域 | 操作 | 说明 |
|---|---|---|
| `serial` | `status` | 连接状态、端口信息、baud、rx/tx 计数、是否暂停 |
| | `connect` / `disconnect` | 优先 `getPorts()` 自动连；返回多个已授权端口时取第一个，可用可选参数 `index` 指定；无授权端口返回 `NEEDS_USER_GESTURE` |
| | `send` | `{ data, encoding: ascii\|hex\|base64 }` |
| | `read` | `{ cursor, max }` → 新输出 + 新游标 + `dropped` + `truncated` |
| | `set_params` | baud/dataBits/stopBits/parity/flowControl；响应须说明"需重连生效" |
| `modbus` | `status` | `modbusPortMode`、连接态、轮询态、是否冻结终端 |
| | `set_mode` | `shared` / `independent`（复用 `modbusSetMode`） |
| | `connect` / `disconnect` | independent 模式（复用 `modbusConnectPort`） |
| | `activate` / `deactivate` | shared 模式；响应**必须说明终端已被冻结** |
| | `request` | 语义化：`{ slaveId, funcCode, address, quantity, writeData }` → 原始 TX/RX 帧 + `pduHex` + 异常码 + 响应时间（**不解析寄存器值、不给线圈位图**，见下方修订记录）。**仅 independent 模式**：shared 模式冻结终端读循环，响应在解析前就被丢弃，故直接拒绝而不是发出去等超时 |
| | `cycle_start` / `cycle_stop` / `log` | 轮询控制与历史报文 |
| `ui` | `set_theme` / `set_font` / `toggle_sidebar` / `run_macro` / `list_macros` / `save_log` | 复用现有函数 |
| | `clear` / `pause` / `resume` | 视图状态操作，复用 `clearTerminal()` / `togglePause()` |
| | `inspect` | **结构化渲染信息**：最后 N 行文本 + 计算后颜色、HEX 视图开关、高亮命中 |
| `dev` | `serial_source` | `{ mode: "real" \| "fake" }` 切换串口 seam |
| | `fake_inject` | 假设备向页面注入 RX 字节 |
| | `fake_capture` | 读回假设备收到的 TX 字节 |
| | `fake_script` | 预设 `[{match, respond, delayMs}]`，让假设备**自动应答** |

`fake_script` 是把假串口从"手动喂字节"升级为"模拟一台真设备"的关键——使完整的 Modbus 往返可无硬件闭环。

> 修订记录（终审，文档纠错后重写）：`request` 原设计的 `format` 参数**未实现**；但也**不是**
> 本行先前所写的"改为总返回全格式（HEX/U16/I16/F32 一次给全）"——那句话与实现不符。
> 实现（`bridge-client.js` 的 `modbus.request`）返回的是：
> `{ txHex, outcome, rxHex, responseTimeMs, slaveId, funcCode, pduHex }`，
> **原始 TX/RX 帧与 PDU，没有任何解析后的寄存器值，也没有线圈位图**。异常时以
> `exceptionCode` / `exceptionText` 取代 `funcCode` / `pduHex`（`slaveId` 仍在）；
> 超时时只回 `txHex` / `outcome` / `note`。多格式渲染只存在于页面自己的 DOM 表格
> （`WebSerialTerminal.html` 的 `modbusShowParsedData()`，属于本次改动之前就存在的
> Modbus 调试面板），**MCP 工具从不上报它**。解码留给调用方：寄存器字节在 `pduHex` 里，
> 功能码 03/04 的首字节是字节数，其后每 2 字节一个寄存器。
>
> 本次一并改正原句"**工具描述已同步说明**"：那句话断言的一致性当时并不存在——描述里
> 写的是同一套多格式承诺。现已真正同步：`mcp-server.js` 的 `modbus_request` 描述、
> `serial-mcp-bridge.md` §8 工具表、使用说明 §六.E 均已改为"返回原始帧、解码在调用方"。

> 另两处与本文的偏离，实现为准（终审收口）：
> - §5.5 的武装开关**存独立的 `wtp_ai_armed` 键**，不塞进 `wtp_settings`：武装是安全状态，
>   不该与主题/字号这类显示偏好共用一条存档（`loadState()` 用 `{...settings, ...存档}`
>   整体合并，任何一次"恢复默认设置"都会顺带改掉写入权限），且独立键可单独清除。
> - §8.2 的超时统一为桥侧一档 10s，见该节修订记录。

### 4.4 决定 ⑥：读取用拉取式，不用推送式

**本节最重要的决定。** MCP 工具调用是请求/响应模型，**没有可靠的"服务端主动推给模型"通道**。因此：

- 页面维护**环形缓冲 + 单调游标**，记录所有 RX
- AI 用 `serial_read({ cursor, max })` 拉取 → `{ lines: [...], cursor, dropped, truncated }`
- `dropped > 0` 表示游标过旧、数据已被环形缓冲挤掉——**必须显式告知 AI 它漏了数据**。AI 在"以为输出连续"的前提下做出的判断比收到报错更危险
- 事件（`evt`）仍然发送，但仅用于桥侧观测/日志，**不作为 AI 的数据来源**

附带收益：页面掉线重连不影响读取——游标在页面侧，重连后用同一游标继续拉取（呼应 3.5 的无状态协议）。

### 4.5 决定 ⑦：错误分类显式且可操作

| 错误码 | 含义 | AI 应做什么 |
|---|---|---|
| `NEEDS_USER_GESTURE` | 无已授权端口，`requestPort()` 需用户手势 | **停下请用户点击连接按钮**；重试无效 |
| `PORT_BUSY` | 物理端口被另一套栈占用 | 先断开占用方（`serial_disconnect` / `modbus_control {action:"disconnect"}`）再重试。**不要**为腾端口把 Modbus 切到 shared——切过去确实会断开独立串口、腾出端口，但终端读循环随之冻结、`modbus_request` 不可用 |
| `PAGE_NOT_CONNECTED` | 桥上没有页面 | 提示用户打开 `localhost:1982` |
| `BRIDGE_TIMEOUT` | 页面未在时限内响应 | 检查页面是否卡住 |
| `PORT_NOT_CONNECTED` | 端口未打开 | 先 `connect` |
| `NOT_ARMED` | 写入类操作但武装开关未开 | 请用户打开武装开关 |
| `INVALID_ARGS` | 参数校验失败 | 修正参数 |
| `OP_UNSUPPORTED` | 页面能力清单不含该域/操作 | 提示刷新页面 |
| `PAGE_ERROR` | 页面内部抛错（带 stack） | 转发给用户排查 |

> **修订记录（终审）**：`PORT_BUSY` 行原写"先断开另一栈，**或切 Modbus 至 shared 模式**"。
> 那条建议的隐含前提是**假的**——切 shared 时 `modbusSetMode` 会调 `modbusDisconnectPort()`
> （内含 `await modbusPort.close()`），独立串口确实被断开、端口确实腾得出来。不推荐的理由
> 只剩**不划算**：shared 模式下终端读循环被冻结，Modbus 响应字节在解析前就被丢弃，实现为此
> **直接拒绝** `modbus_request`（见 §4.3 该行）——切过去等于拿"Modbus 工具不可用"换端口。
> 工具文案与用户文档已同步此政策。

`NEEDS_USER_GESTURE` 与普通失败必须区分——否则 AI 会陷入重试循环，这是最容易踩的坑。

### 4.6 边界与限制

- 桥强制**单帧上限 256 KB**
- `read` 单次上限：1000 行 / 256 KB，超出截断并置 `truncated: true`
- 桥做**速率限制**，防止 AI 循环调用打死页面

## 5. 页面侧改造

### 5.1 改动面（对现有文件仅 3 处）

```js
// ① 串口段附近新增 ~4 行：seam 定义
let serialProvider = {
  requestPort: () => navigator.serial.requestPort(),
  getPorts:    () => navigator.serial.getPorts(),
};

// ② WebSerialTerminal.html:2944  （connectPort 内）
- port = await navigator.serial.requestPort();
+ port = await serialProvider.requestPort();

// ③ WebSerialTerminal.html:4680  （modbusConnectPort 内）
- modbusPort = await navigator.serial.requestPort();
+ modbusPort = await serialProvider.requestPort();
```

其余全部落在新文件 `bridge-client.js`，以 `<script src>` 加载（项目已有先例：`pwa-install.js` 于 4851 行）。

### 5.2 决定 ⑧：seam 定义在主脚本，假实现放在 `bridge-client.js`

`connectPort` / `modbusConnectPort` 是 seam 的消费方，依赖声明应与消费方同居。跨 `<script>` 块引用顶层 `let` 绑定虽然可行（全局词法环境共享），但那是"能跑"而非"清晰"。因此：主脚本声明接口与真实实现，`bridge-client.js` 在收到 `serial_source: fake` 时**重新赋值**。

### 5.3 决定 ⑨：假串口必须建在平台原生流之上

假 `SerialPort` **不得**手写 Promise 模拟 `readable` / `writable`，必须直接使用平台的 `ReadableStream` / `WritableStream`：

```js
class FakeSerialPort {
  // 内部用 new ReadableStream(...) / new WritableStream(...) 构造
  async open(opts) { /* 已打开则 throw InvalidStateError */ }
  async close()    { /* 关闭流，令待决 read() 以 done:true 收尾 */ }
  getInfo()        { return { usbVendorId: 0x1A86, usbProductId: 0x7523 }; }
}
```

原因：现有代码**依赖真实流的精确语义**。以下已在 Node v24 实测确认（原生 `ReadableStream` / `WritableStream`）：

| 场景 | 实测结果 |
|---|---|
| `getReader()` 对已锁定流二次调用 | `TypeError: ReadableStream is locked` |
| `reader.cancel()` 时存在待决 `read()` | **resolve `{done: true}`** |
| `controller.close()` 时存在待决 `read()` | resolve `{done: true}` |
| `getWriter()` 对已锁定流二次调用 | `TypeError: WritableStream is locked` |
| `releaseLock()` 后再 `getWriter()` | 正常可用 |

**重要纠正**：`WebSerialTerminal.html:2992-2993` 的注释称 `reader.cancel()` 会让待决 `read()` **抛 `AbortError`**——该说法与原生流实测语义**不符**，原生行为是 resolve `{done: true}`。

现有 `readLoop`（3031-3035）两条路径都处理了（`if (done) break;` 与 `catch`），因此**代码本身正确**，注释不准确而已。但假串口的测试断言必须对准**实测语义**（`{done: true}`），不能对准注释。

手写 shim 的风险正在于此：若待决 `read()` 既不 resolve 也不 reject，`disconnectPort()` 会白等满 500ms 轮询（2997 的 `for (let i = 0; i < 50; i++)`），随后对着**仍然锁定的**流调用 `getReader()` 而抛异常。使用原生流则这些语义"构造正确"，而非"猜测正确"。

### 5.4 假设备能力（对应 `dev` 域）

| 能力 | 参数 | 实现 |
|---|---|---|
| `fake_inject` | `{ data, encoding }` | 向假 `readable` 的 controller 推字节 → 走完 `readLoop` 全链路 |
| `fake_capture` | `{ clear? }` | 从假 `writable` 的 write 回调收集字节 → 断言 AI 实际发出的内容 |
| `fake_script` | `{ rules: [...] }` | 见下 |

`fake_script` 的规则形状：

```jsonc
{ "rules": [
    { "matchHex": "0103000000",          // TX 累积缓冲的前缀匹配（hex）
      "respondHex": "0103020064",        // 匹配后回注的 RX 字节
      "delayMs": 20 }                    // 回注延迟，用于测超时边界
] }
```

语义约定（消除歧义）：

- **匹配方式**：TX 累积缓冲的**前缀匹配**（`matchHex` 按字节比较）。不用全文匹配，因为串口分包不可预测
- **多规则**：按数组顺序，**首个匹配生效**；匹配后清空 TX 累积缓冲，避免同一请求被重复命中
- **未匹配**：不回注任何字节——这样 AI 可以**主动测试超时路径**（页面侧 Modbus 有 500ms 响应超时），这是模拟真设备时最容易被遗漏的分支
- **清除**：传 `{ "rules": [] }` 清空；`serial_source` 切回 `real` 时也自动清空

### 5.5 决定 ⑩：武装开关 + 免费审计日志

按"完全自主"决策，不做逐次确认，但加两条零摩擦护栏：

**武装开关**：页面侧 `aiWriteArmed` 标志，**默认关闭**，持久化进现有 `wtp_settings`（与 `logDir` 同机制）。关闭时写入类操作返回 `NOT_ARMED`；打开后 AI 完全自主。读取类操作（`status` / `read` / `inspect` / `fake_capture`）**不受开关限制**——AI 任何时候都能诊断现状。

**审计日志**：AI 每个写入操作追加进终端日志，带可区分前缀：

```
[AI] → AT+RST\r\n
```

审计轨迹因此**免费**——复用已有的滚动日志、`saveLog` 三级降级导出、以及 `test/client.test.js` 已锁死的 BOM / 编码处理，无需新建日志系统。

### 5.6 非功能要求

**桥挂掉绝不能影响终端正常使用。** AI 控制是附加能力而非依赖：

- `bridge-client.js` 所有代码路径必须包住异常，不允许抛回页面代码
- WS 断线用指数退避重连（1s → 30s 封顶），不弹错误、不阻塞 UI
- 武装开关默认关闭 → 即使桥被恶意连接也写不动硬件

**该原则同样约束服务端**（实现期由审查发现后补充，见下方修订记录）：桥的引入**不得让原本可用的终端变得不可用**。

- `server.js` 对桥模块的 `require` 失败必须**非致命但响亮**——继续提供静态服务与 `/api/save-log`，并在启动时明确打印缺哪个依赖、如何安装。终端是本工具的主功能，桥是附加项
- 同理，`writeToken()` 失败（例如用户目录不可写）**不得让已绑定端口的进程以未处理异常退出**，而应响亮降级
- 关键区别在**响亮**：静默降级不可接受（用户会看到一个莫名不工作的桥），响亮降级可以（消息直接说明原因与补救）

> **修订记录**：本节原文只列了页面侧三条。实现 Task 6 时引入了一个硬依赖——`server.js` require 桥模块会传递拉入 `ws`，使 `node_modules` 缺失时 `node server.js` 直接 `MODULE_NOT_FOUND`，而 `install.ps1` 没有安装步骤。这**回退了改动前的行为**（`server.js` 原本只用 `node:*` 内置模块、零依赖即可运行）。审查者建议改 `install.ps1`，实现者反对惰性加载（会让桥静默缺失）——两者都不如本节原则直接：**做成响亮降级**即同时满足"终端可用"与"不静默"。

> **部署前提（需写入用户文档）**：AI 桥依赖 `ws`，因此**使用 AI 桥功能前必须 `npm install`**。终端本身的静态服务与日志保存不依赖任何外部模块。未安装时启动会明确提示。


## 6. MCP 工具面

### 6.1 决定 ⑪：约束必须写进工具描述

模型只能看到工具名、描述、参数 schema。4.5 的错误码语义若不写进描述，对 AI 等于不存在。描述须带操作指引，而非功能简介：

```jsonc
{
  "name": "serial_connect",
  "description": "连接终端串口。优先用浏览器已授权的端口自动连接。\n\n若返回 NEEDS_USER_GESTURE：表示没有已授权端口，浏览器要求用户手势才能弹出选择框。此时重试无效——必须请用户手动点击页面上的\"连接\"按钮一次，之后即可自动重连。"
}
```

```jsonc
{
  "name": "serial_read",
  "description": "按游标读取终端输出。必须传入上次返回的 cursor 以只取增量。\n\n注意 dropped 字段：大于 0 表示输出量超过环形缓冲、该段数据已丢失。出现 dropped 时不要假设输出连续，应缩短读取间隔或缩小范围后重试。"
}
```

### 6.2 工具清单（11 个）

| # | 工具 | 用途 | 备注 |
|---|---|---|---|
| 1 | `webterm_status` | 终端 + Modbus **两栈**状态快照 | 合并，AI 通常先看全貌 |
| 2 | `serial_connect` | 连接终端串口 | 无授权端口 → `NEEDS_USER_GESTURE` |
| 3 | `serial_disconnect` | 断开终端串口 | |
| 4 | `serial_send` | 发送数据 | `encoding: ascii\|hex\|base64` |
| 5 | `serial_read` | 按游标读取输出 | 返回 `cursor` / `dropped` / `truncated` |
| 6 | `modbus_control` | 模式/连接/激活/轮询（`action` 枚举） | 合并 6 个操作，避免工具爆炸 |
| 7 | `modbus_request` | 语义化 Modbus 请求 | 含写操作 |
| 8 | `modbus_log` | 历史报文 | |
| 9 | `ui_action` | 清屏/暂停/继续/主题/字体/侧栏/宏/存日志（`action` 枚举） | 视图与配置类操作统一入口 |
| 10 | `ui_inspect` | **结构化渲染信息** | 开发期验证渲染的抓手 |
| 11 | `dev_serial` | 假设备：切源/注入/捕获/脚本（`action` 枚举） | 服务开发期自测 |

**合并策略**：语义差别大的保持独立（`serial_send` vs `modbus_request`）；同一对象的同类操作合并为 `action` 枚举工具。11 个在模型可接受规模内，再多会稀释选择准确率。

### 6.3 决定 ⑫：默认返回要小

`serial_read` 默认 `max` 取 **50 行**，而非 1000。工具结果直接消耗模型上下文，默认返回大块内容是**为省事而烧上下文**，且会把关键信号淹没在噪声中。大输出必须显式截断并标注 `truncated: true`，附"如何取更多"的提示。

### 6.4 决定 ⑬：错误码翻译成人话

MCP 工具结果是文本，AI 读的是句子而非 JSON：

```
✖ 无法连接：浏览器要求用户手动授权串口（首次连接必须真人点一下页面上的"连接"按钮）。
  重试不会有帮助——请让用户操作后再说"继续"。
```

把"该做什么"直接写进去，而非只报错误名。

## 7. 安全

### 7.1 威胁模型

| 威胁 | 防线 | 来源 |
|---|---|---|
| 任意网页连上桥驱动串口 | 页面连接的 `Origin` 必须等于本服务来源 | 复用 `isTrustedOrigin()`（`server.js:62`） |
| DNS rebinding | `Host` 必须为本机主机名 | 复用 `isLocalHostname()`（`server.js:51`） |
| 本机其他进程冒充适配器 | 一次性 token（适配器连接无 `Origin`，走 token 分支） | 新增 |
| AI 误操作真实硬件 | 武装开关（默认关）+ 全量审计日志 | 5.5 |
| AI 循环调用打垮页面 | 桥侧速率限制 | 新增 |
| 超大帧打爆内存 | 桥单帧上限 256 KB + `read` 单次上限 | 新增 |

### 7.2 决定 ⑭：护栏是"显式打开 + 事后可追溯"，不是"事前拦截"

按用户决策**不给 AI 写入加逐次确认**。护栏为：物理上需显式打开武装开关一次；事后全部可追溯（终端日志 + `saveLog` 导出）。不做逐次确认是本设计的**明确取舍**，非疏漏。

## 8. 错误处理

### 8.1 三个失败点

| 失败点 | 行为 |
|---|---|
| 页面内部抛错 | 捕获为 `PAGE_ERROR` + stack，**绝不冒泡**（否则 AI 的调用能弄崩终端页面） |
| 页面 N 秒不响应 | 桥判 `BRIDGE_TIMEOUT`，从请求表清理，避免内存泄漏 |
| 适配器进程退出 | 桥清理该适配器的挂起请求 |

### 8.2 超时默认值

- 桥侧统一 **10s**（`bridge.js` 的 `DEFAULT_TIMEOUT_MS`），读操作与写操作同一档

> **修订记录（终审）**：本节原写"读操作 5s / 写操作 10s"两档，实现是统一 10s。
> 按实现收口（而不是给读操作加一条更短的路径）：桥的超时计时器只有一条路径，
> 分档需要额外分支与额外测试，而读操作同样可能触发页面侧的慢路径（DOM 遍历、
> `ui.inspect` 的 `getComputedStyle`），5s 反而更容易误判成"页面卡死"。
> 真正区分"页面卡死"与"页面慢"的是 `BRIDGE_TIMEOUT` 的文案，不是两档阈值。
> 测试可用 `attachBridge` 的 `deps.timeoutMs` 覆盖，不受此默认值限制。

- `modbus_request`：页面侧 500ms 响应超时 + 余量

桥的请求表**必须有容量上限 + 过期清理**，否则反复超时会持续吃内存。

## 9. 测试策略

| 层 | 内容 | 需要真人？ | 进 CI？ |
|---|---|---|---|
| 1. 单元（`node:test`，零依赖） | `bridge.js` 的 Origin/token 校验、路由、限流、超时清理、帧上限；假串口的流语义（`cancel`/`close` 均 resolve `{done:true}`、锁定抛 `TypeError`、背压） | 否 | ✅ |
| 2. 结构断言（延续 `test/client.test.js` 风格） | seam 回归测试、`serialProvider` 只声明一次、桥代码不进主脚本 | 否 | ✅ |
| 3. 集成 | 起 `server.js` + Node 假页面（WS 客户端），跑完整往返、鉴权拒绝、超时 | 否 | ✅ |
| 4. 端到端 | 真人开 Chrome → `dev_serial` 切假设备 → AI 驱动"连接 → 发 Modbus 请求 → 断言响应"闭环 | **是**（仅需开页面） | ❌ |

### 9.1 seam 回归测试（关键保障）

```js
test('串口端口只能经 serialProvider 获取', () => {
  const hits = html.match(/navigator\.serial\.(requestPort|getPorts)\s*\(/g) || [];
  assert.strictEqual(hits.length, 2,
    '应只有 seam 定义处引用 navigator.serial，实际 ' + hits.length);
});
```

若后续重构图省事写回 `navigator.serial.requestPort()`，此测试立即变红。这是让假设备方案**长期有效**的唯一保障。

### 9.2 决定 ⑮：dispatcher 必须写成薄映射层

页面里的 dispatcher 无 DOM 测试环境，难以真单测。因此**把可测逻辑抽成纯函数**放进 `bridge-client.js`——编码转换、参数校验、游标管理、环缓挤占判定——让第 1 层覆盖它们；dispatcher 本身只剩"调用哪个全局函数"这一句。

这是**为了可测性反过来约束设计**，不是事后补测试。

### 9.3 关键结论

**"测真机"这一层不需要真人。** `fake_script` 已覆盖传输层之下的所有逻辑；剩下的物理层差异（时序、电气）本非自动化能保证。真正需要真人的只有"开一次浏览器并授权端口"。

覆盖率目标 80%（遵循项目规则），主力在第 1、2 层。

### 9.4 `sw.js` 缓存

`CACHE = 'webterm-v4'` 的 `URLS` 列表不变，且 fetch 为网络优先，故新增文件在线时正常加载。离线时 `bridge-client.js` 不可得——而离线本就连不上 localhost 的桥。**结论：不修改，记为已验证的已知取舍。**

## 10. 风险与待确认

| 项 | 说明 | 应对 |
|---|---|---|
| 首次授权需真人 | `requestPort()` 需用户手势（1.2） | 设计已接纳；AI 收到 `NEEDS_USER_GESTURE` 即引导用户 |
| `getPorts()` 免手势未实测 | 结论来自 MDN 规范 + StackOverflow 实证，**未在本机实测**（搜索结果中部分中文资料说法相反） | 不影响可行性（9.3 的退路只降体验）；实现时优先实测验证 |
| 假串口语义偏差 | 手写 shim 会致测试假通过（5.3） | 强制使用原生流；单元测试按**实测语义**断言（`cancel`/`close` → `{done:true}`、锁定 → `TypeError`），不按现有注释断言 |
| 武装开关被长期打开 | 用户可能开着不关，等于无护栏 | 审计日志兜底（可追溯）；开关状态在 UI 上常驻可见 |
| 触及现有工作代码 | 需改 `connectPort` / `modbusConnectPort` 取端口的方式 | 改动仅 2 行；由 9.1 回归测试 + 现有 `test/client.test.js` 锁定行为 |
| `server.js` 职责变杂 | 静态服务 + save-log + AI 桥 | 逻辑全部放 `bridge.js`，`server.js` 只增加挂载与 upgrade 路由 |
| MCP 客户端假设 | 假定为 Claude Code stdio（`.mcp.json`） | 适配器为薄层；若需支持其他 MCP 客户端，改动局限在 `mcp-server.js` |

## 11. 交付物清单

### 新增

| 文件 | 说明 |
|---|---|
| `bridge.js` | WS 服务端模块（鉴权/路由/限流/超时清理），由 `server.js` require 挂载 |
| `mcp-server.js` | stdio MCP 适配器：11 个工具定义 + 工具→op 映射 + 错误码翻译 |
| `bridge-client.js` | 页面侧 WS 客户端 + dispatcher + 假串口实现 |
| `.mcp.json` | Claude Code 的 MCP 注册配置 |
| `test/bridge.test.js` | 桥单元测试 |
| `test/bridge-client.test.js` | 假串口与纯函数单元测试 |

### 修改

| 文件 | 改动 |
|---|---|
| `WebSerialTerminal.html` | 3 处：seam 声明 + 2 个 `requestPort()` 调用点；加载 `bridge-client.js`；武装开关 UI |
| `server.js` | 挂载 `bridge.js`、`upgrade` 事件路由、启动时生成 token 文件 |
| `test/client.test.js` | 新增 seam 回归断言 |
| `package.json` | 无新依赖（`ws ^8.16.0` 已在） |
