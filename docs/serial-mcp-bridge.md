# AI 串口桥（Serial MCP Bridge）

让 Claude Code 直接读写你的串口设备：查连接状态、收发字节、跑 Modbus 请求、看终端实际渲染结果。

桥是**附加能力**，不是依赖——它挂掉、没装依赖、甚至从没启动过，终端本身都照常工作。

---

## 1. 部署前提：先 `npm install`

**使用 AI 桥功能前，必须在本目录运行一次 `npm install`。** 桥的服务端依赖 `ws`：

```bash
npm install
```

| 功能 | 是否需要 `node_modules` |
|---|---|
| 终端本体（页面静态服务、收发串口、日志保存到磁盘） | **不需要**，只用 Node 内置模块 |
| AI 桥（`/bridge` 端点、`mcp-server.js`） | **需要**（`ws`） |

没装依赖时终端照常可用，但启动会**明确打印**为什么 AI 桥不可用：

```
WebTerm Pro running at http://localhost:1982
[bridge] AI 桥不可用：Cannot find module 'ws'。请在本目录运行 npm install 后重启。终端本身不受影响。
```

看到这一行就说明：页面能用，AI 用不了。装完依赖重启即可。

---

## 2. 启动步骤

顺序不能反——**先起服务端，再开 Claude Code**。

```bash
# 第 1 步：起服务端（会同时生成当次的桥 token）
npm start
# → WebTerm Pro running at http://localhost:1982
# → [bridge] token 已写入 C:\Users\<你>\.webterm\bridge-token

# 第 2 步：在浏览器打开页面（Chrome 89+ / Edge 89+）
#   http://localhost:1982
#   页面侧会自动连上桥（终端日志不提示，但侧栏「AI 控制」区块存在即已加载）

# 第 3 步：在该目录下启动 Claude Code，首次会询问是否信任本项目的 MCP 服务器
claude
```

第 3 步依赖仓库根目录的 `.mcp.json`：

```json
{
  "mcpServers": {
    "webterm-serial": {
      "command": "node",
      "args": ["mcp-server.js"],
      "env": {}
    }
  }
}
```

要点：

- `node` 必须在 `PATH` 上（能跑 `npm start` 就说明没问题）。
- `args` 是相对路径，Claude Code 在**项目根目录**下拉起它，因此请从本目录启动 `claude`。
- 首次连接时 Claude Code 会弹一次「是否信任此项目的 MCP 服务器」，需选允许。
- 多个 Claude Code 会话会各起一个 `mcp-server.js` 进程，互不冲突（请求 ID 全局唯一）。
- **`mcp-server.js` 启动时读不到 token 会立即报错**，不会静默重试——请确认 `npm start` 已经跑起来了。

用 `/mcp` 可以确认 `webterm-serial` 已连接、能看到 11 个工具。

---

## 3. 首次串口授权必须真人点一次

**这是浏览器的硬约束，无法绕过。**

Web Serial 的 `navigator.serial.requestPort()`（弹串口选择框）要求 **transient activation**——也就是"用户刚刚真的点了一下"。脚本调用会被浏览器直接拒绝。而 `getPorts()`（列出**已授权**端口）不需要手势。

所以分工是：

| 谁 | 用哪个 API | 结果 |
|---|---|---|
| 页面上的"连接"按钮（真人点击） | `requestPort()` | 弹选择框，用户选设备并授权 |
| AI 的 `serial_connect` | `getPorts()` | 免手势，直接连已授权端口 |

由此得出：

- **第一次**用某个设备：必须真人点一次页面上的「连接」按钮完成授权。
- 在那之前 AI 调 `serial_connect` 会返回 `NEEDS_USER_GESTURE`。**此时重试没有任何用**——AI 应当停下来请用户操作，而不是反复重试。
- 授权**按来源（origin）持久**：`http://localhost:1982` 下授权过一次之后，AI 就能反复自动重连，刷新页面也不会丢授权。

> 换浏览器、换端口（改用 `PORT=xxxx` 启动）、用 `https://` 而不是 `localhost`，都会被当作新来源，需要重新授权一次。

---

## 4. 武装开关：「允许 AI 写入」

页面左侧栏有一个 **◈ AI 控制** 区块，里面是复选框 **「允许 AI 写入」**，旁边的小字标明当前状态（`AI 只读` / `已允许 AI 写入`）。

- **默认关闭。** 首次打开页面、清空浏览器数据、隐私模式，都会回到关闭状态。
- **关闭时**：所有**写入类**操作返回 `NOT_ARMED`，AI 改不动硬件。
- **打开时**：AI 完全自主执行，不再逐次确认。

**读取类操作不受开关限制**，任何时候 AI 都能诊断现状：

```
serial.status, serial.read, modbus.status, modbus.log,
ui.inspect, ui.list_macros, dev.fake_capture
```

除以上 7 项外的操作都算写入（包括 `serial.connect` / `serial.send` / `modbus.control` / `ui.action` 里的 `pause`、`run_macro`、`save_log` 等）。

**审计轨迹**：每一次写入都会往终端日志追加一行 `[AI]` 开头的记录，写明意图（对哪个端口、发了什么字节），失败时再补一行 `[AI] ✖ 失败：…`。这条轨迹复用终端自己的滚动缓冲和「保存日志」功能，事后可导出追溯。**开着开关不关 = 没有事前拦截，只有事后可追溯**，请按需开关。

开关状态存在浏览器 localStorage（键 `wtp_ai_armed`），刷新页面、服务端重启后都保持。

---

## 5. 用假设备跑通全链路（无需硬件）

`dev_serial` 提供一个假串口，让你在没有硬件时也能验证整条链路。它替换的是页面的串口来源，**数据仍走完整的 `readLoop` 解析路径**。

四个 action：

| action | 参数 | 作用 |
|---|---|---|
| `serial_source` | `mode: "fake"` / `"real"` | 切换串口来源。切到 `fake` 前必须已断开真实串口 |
| `fake_inject` | `data`、`encoding`（默认 `hex`） | 假设备**向页面注入接收数据**（模拟设备主动上报） |
| `fake_capture` | `clear`（可选） | **读回页面实际发出去的字节**——验证 AI 到底往线缆写了什么 |
| `fake_script` | `rules: [...]` | 设置「请求 → 应答」规则，让假设备**自动应答** |

`fake_script` 规则形状：

```jsonc
{ "rules": [
    { "matchHex": "0103000000",   // TX 累积缓冲的前缀匹配（hex，按字节比较）
      "respondHex": "0103030064000a", // 命中后回注的 RX 字节
      "delayMs": 20 }             // 回注延迟，用来测超时边界
] }
```

规则语义：

- **前缀匹配**：只比对 TX 累积缓冲的开头，不要求全文相等（串口分包不可预测）。
- **首个命中生效**：按数组顺序，命中后清空 TX 累积缓冲，同一请求不会被重复应答。
- **未命中 = 不回注任何数据**：这样你可以**主动测超时路径**（Modbus 页面侧超时是 500ms）。
- **清空**：传 `{ "rules": [] }`；`serial_source` 切回 `real` 时也会自动清空。

典型闭环（全程无硬件）：

```text
1. dev_serial {action:"serial_source", mode:"fake"}          → {source:"fake"}
2. dev_serial {action:"fake_script", rules:[{matchHex:"0103000000",
               respondHex:"0103030064000a", delayMs:20}]}     → {ruleCount:1}
3. serial_connect                                              → {connected:true}
4. serial_send  {data:"01030000000A", encoding:"hex"}          → {bytesWritten:6}
5. dev_serial  {action:"fake_capture"}                         → {hex:"01030000000a"}
6. serial_read {cursor:0}                                      → 出现假设备回注的响应行
```

> 第 2 步的 `respondHex` 必须是**完整的 Modbus 响应帧**（从站号 + 功能码 + 数据 + CRC），假设备原样回注，页面侧会照常做 CRC 校验。

---

## 6. 错误码速查表

AI 拿到的不是裸错误码，而是翻译过的人话。下表是对照：

| 错误码 | 含义 | 该怎么办 |
|---|---|---|
| `NEEDS_USER_GESTURE` | 没有已授权端口，浏览器要求用户手势 | **停下请用户点一次页面「连接」按钮**；重试无效 |
| `PORT_BUSY` | 物理端口被另一套串口栈占用 | 断开占用方，或把 Modbus 切到 `shared` 复用终端端口 |
| `PAGE_NOT_CONNECTED` | 桥上没有页面 | 请用户打开 `http://localhost:1982` |
| `BRIDGE_TIMEOUT` | 页面未在 10s 内响应 | 页面可能卡住；先用 `webterm_status` 探活 |
| `PORT_NOT_CONNECTED` | 端口没开 | 先 `serial_connect` |
| `NOT_ARMED` | 写入类操作，但武装开关没开 | 请用户打开「允许 AI 写入」 |
| `INVALID_ARGS` | 参数校验失败（也用于请求过频、请求 ID 冲突） | 按消息修正参数；放慢调用频率 |
| `OP_UNSUPPORTED` | 页面能力清单里没有该域/操作 | 提示用户刷新页面（页面版本较旧） |
| `PAGE_ERROR` | 页面内部抛错 | 转告用户排查 |

限额：单帧 256 KB；`serial_read` 单次最多 1000 行；桥侧限速 60 次/秒。

---

## 7. 排障

### 7.1 token 文件

| 项 | 值 |
|---|---|
| 位置 | Windows `C:\Users\<你>\.webterm\bridge-token`，其他平台 `~/.webterm/bridge-token` |
| 覆盖 | 环境变量 `WEBTERM_HOME` 指向别处时，改为 `%WEBTERM_HOME%\.webterm\bridge-token` |
| 内容 | 64 个十六进制字符（32 字节随机数） |
| 生命周期 | **每次 `server.js` 启动重新生成**，不持久化；重启即失效 |
| 权限 | 目录 `0o700`、文件 `0o600`（Windows 上由 Node 尽力而为，实际依赖用户目录 ACL） |

它**不在仓库里**，`.gitignore` 另外补了一条 `.webterm/` 作防御性忽略。

- 报错 `读不到桥 token（…）。请先启动 server.js（npm start）。` → 服务端没起，或 `WEBTERM_HOME` 与启动 `server.js` 时不一致。
- `token 无效` → 服务端重启过（token 换了），但 `mcp-server.js` 还拿着旧的。重启 Claude Code 会话即可。

### 7.2 端口占用

```
端口 1982 已被占用，请关闭占用进程后重试
```

`server.js` 只监听回环地址 `127.0.0.1`。查占用：

```powershell
netstat -ano | findstr :1982      # 取最后一列的 PID
Get-CimInstance Win32_Process -Filter "ProcessId=<PID>" | Select-Object CommandLine
```

**换了进程但没换端口时尤其注意**：如果 1982 上跑的是**旧版本**的 `server.js`（AI 桥之前启动的），它没有 `/bridge` 端点——页面会一直 `PAGE_NOT_CONNECTED`，而 `mcp-server.js` 却像是连上了。重启服务端即可。

用别的端口启动（同时要告诉 `mcp-server.js`）：

```powershell
# PowerShell
$env:PORT=3000; npm start
```

```bash
# bash / Git Bash
PORT=3000 npm start
```

`mcp-server.js` 那一侧通过 `.mcp.json` 的 `env` 指过去：

```json
{ "mcpServers": { "webterm-serial": {
    "command": "node", "args": ["mcp-server.js"],
    "env": { "WEBTERM_BRIDGE_URL": "ws://127.0.0.1:3000/bridge" }
} } }
```

### 7.3 页面未连接

`PAGE_NOT_CONNECTED` 的唯一含义是：**桥上没有页面 socket**。逐个排查：

1. 浏览器打开了 `http://localhost:1982` 吗？（改过端口就用新端口）
2. 页面是 `https://` 打开的吗？https 页面会去连 `wss://`，而本服务是 `http`——请统一用 `http://localhost:1982`。
3. 页面的 `bridge-client.js` 加载成功了吗？按 F12 看 Console 有没有 `[bridge-client] 启动失败`。终端日志里出现 `[AI] 警告：页面缺少 AI 桥依赖的函数 → …` 说明页面代码版本不匹配，刷新页面。
4. 服务端启动日志里有 `[bridge] 页面已连接 pageId=…` 吗？没有就是页面没连上。
5. 同一时刻**只有一个页面**能当"当前页面"：后连接的标签页会取代先连接的那个。

### 7.4 桥不接受连接

| 现象 | 原因 |
|---|---|
| `拒绝连接：非法来源` | 浏览器发的 `Origin` 不是本服务自身（端口不一致 / 非 `localhost`/`127.0.0.1`） |
| `拒绝连接：非法 Host` | `Host` 头不是本机（DNS rebinding 防线） |
| `拒绝连接：token 无效` | 适配器没带或不匹配 token，见 7.1 |
| `协议版本不匹配：页面 X，桥 1` | 页面与服务端版本不一致，刷新页面 |
| `/bridge` 返回 404 | 服务端没挂上桥——多半是没 `npm install`，看启动日志的 `[bridge] AI 桥不可用：…` |

注意 `/bridge` **只接受** `ws://127.0.0.1:1982/bridge`（或 `localhost`）——服务端只绑回环地址，局域网内其他机器连不上，这是刻意设计。

### 7.5 服务端重启后

- 页面会自动重连（指数退避，1s → 30s 封顶），**不弹错、不卡 UI**。
- 「允许 AI 写入」的勾选状态仍在（存在 localStorage）。
- 但 **token 会重新生成**，所以 `mcp-server.js` 持有的旧连接会失效——重启 Claude Code 会话最干净。

---

## 8. 11 个 MCP 工具

| 工具 | 说明 |
|---|---|
| `webterm_status` | 终端 + Modbus 两套栈的完整状态快照（排障第一步） |
| `serial_connect` / `serial_disconnect` | 连接 / 断开终端串口 |
| `serial_send` | 发数据（`ascii` / `hex` / `base64`），记入 `[AI]` 审计 |
| `serial_read` | 按游标拉取增量输出，含 `dropped` / `truncated` |
| `modbus_control` | 模式切换、连断、启停、轮询控制 |
| `modbus_request` | 语义化 Modbus RTU 请求（CRC 自动计算，寄存器多种格式解析） |
| `modbus_log` | Modbus 历史报文 |
| `ui_action` | 清屏、暂停、主题、字号、宏、保存日志 |
| `ui_inspect` | 终端**实际渲染结果**（行文本 + 计算后颜色），验证 ANSI 解析/高亮的手段 |
| `dev_serial` | 假串口控制，见第 5 节 |

---

## 附：链路一览

```
Claude Code ──stdio──► mcp-server.js ──ws(带 token)──► bridge.js（在 server.js 进程内）
                                                              │ ws(带 Origin)
                                                              ▼
                                                     浏览器页面 ──► 串口设备
```

`.mcp.json` 注册的是 `mcp-server.js`；`bridge.js` 由 `server.js` 启动时挂载，与静态服务**同生共死**——页面能打开，就说明桥服务端在跑，不需要额外常驻进程。
