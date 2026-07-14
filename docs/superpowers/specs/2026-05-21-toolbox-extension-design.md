# WebTerm Pro — 工具箱扩展设计文档

## 概述

为 WebTerm Pro 单文件串口调试终端新增右侧工具箱面板，包含四个实用工具：校验计算、浮点数转换、ASCII 码表查询、TFTP 客户端。

## 布局变更

### 页面结构

```
┌───────────┬──────────────────────┬───────────┐
│ 左侧面板  │     终端区域          │ 右侧面板  │
│ (220px)   │     (flex: 1)        │ (240px)   │
│           │                      │           │
│ 连接状态  │   终端输出            │ 工具箱    │
│ 数据统计  │                      │ ├ 校验计算│
│ 快捷指令  │   输入区域            │ ├ 浮点数  │
│           │                      │ ├ ASCII表 │
│           │                      │ └ TFTP    │
└───────────┴──────────────────────┴───────────┘
```

- 右侧面板宽度 240px，与左侧面板视觉对称
- 新增 CSS 变量控制显示/隐藏，带切换按钮
- 四个工具以可折叠区块形式排列，可同时展开多个
- 区块标题点击展开/折叠，带 ▶/▼ 箭头指示

### 新增 HTML 结构

```html
<div class="right-sidebar" id="rightSidebar">
  <div class="tool-section">
    <div class="tool-header" onclick="toggleTool('checksum')">⊞ 校验计算</div>
    <div class="tool-body" id="toolChecksum">...</div>
  </div>
  <div class="tool-section">
    <div class="tool-header" onclick="toggleTool('float')">∑ 浮点数转换</div>
    <div class="tool-body" id="toolFloat" style="display:none">...</div>
  </div>
  <!-- ... -->
</div>
```

## 1. 校验计算工具

### 功能

支持多种校验算法的纯前端计算工具。

### 输入模式

- **ASCII 模式**：直接对输入字符串计算校验值
- **HEX 模式**：解析 "AA BB CC" 格式的十六进制字符串为字节数组后计算

模式切换使用拨动开关 (toggle switch)，样式与终端主题一致。

### 支持的算法

| 分组 | 算法 |
|------|------|
| CRC | CRC8, CRC16, CRC32 |
| Hash | MD5, SHA1, SHA256 |
| Simple | Sum8, Sum16, XOR |

### UI 布局（自上而下）

1. 算法选择下拉框
2. 输入模式拨动开关 (ASCII/HEX)
3. 多行文本输入框 (textarea, 72px, 可调高度)
4. HEX 结果显示框 (带 0x 前缀)
5. DEC 结果显示框
6. "复制结果"按钮

### 行为

- 输入实时计算，无需点击按钮
- HEX 模式下输入框下方显示格式提示 "HEX 格式：AA BB CC 0D 0A"
- 结果框点击可复制

## 2. 浮点数转换工具

### 功能

浮点数与十六进制/二进制之间的双向转换。

### 精度选择

- **float (32-bit)**：单精度 IEEE 754
- **double (64-bit)**：双精度 IEEE 754

使用 segmented control（分段滑块）切换，与终端科技风格一致。

### 转换方向

| 方向 | 输入 | 输出 |
|------|------|------|
| 浮点数 → HEX | 浮点数 (如 3.14) | 十六进制 (0x4048F5C3) |
| 浮点数 → BIN | 浮点数 (如 3.14) | 二进制 (01000000 01001000 ...) |
| HEX → 浮点数 | 十六进制 (4048F5C3) | 浮点数 (3.14) |
| 整数 → HEX | 整数 (255) | 十六进制 (0x000000FF) |

### UI 布局

1. 精度选择 segmented control
2. "浮点数" 输入框 → HEX 结果行 + BIN 结果行（上下排列）
3. 分隔线
4. "十六进制 → 浮点数" 输入 + 转换按钮
5. "整数 → 十六进制" 输入 + 转换按钮

### 行为

- 浮点数输入实时转换（双向）
- 二进制每 4 位加空格分组，提升可读性
- 结果框点击可复制
- HEX 输入支持/不带 0x 前缀

## 3. ASCII 码表

### 功能

ASCII 码表查询工具，支持搜索和完整表格浏览。

### 界面

- **搜索模式**：输入字符 / Dec / Hex，顶部显示高亮结果卡片
  - 显示 Dec、Hex、Bin、Char 四列信息
- **表格模式**：搜索框为空时显示完整码表
  - 控制字符 (0-31)：列表布局，每行显示 Dec、HEX、缩写、中文描述
  - 可打印字符 (32-126)：8 列网格布局，悬停高亮
  - DEL (127)：单独显示在末尾

### 交互

- 搜索支持字符、十进制数、十六进制数（带 0x 前缀）
- 点击网格中任意字符，填充到搜索框并显示详细信息
- 控制字符区域和可打印字符区域分别带标题分隔

## 4. TFTP 客户端

### 功能

通过 Node.js 代理实现的浏览器内 TFTP 文件上传工具。

### 架构

```
浏览器 (WebTerm.html)  ──WebSocket──>  tftp-proxy.js  ──UDP──>  目标设备 TFTP Server
                                       (Node.js)                  (port 69)
```

### UI 布局

1. **目标地址**：IP 输入框 + 端口输入框（默认 69）
2. **代理状态**：指示灯 + "未连接"/"已连接" 文字 + 连接按钮
3. **文件选择**：只读输入框（显示文件名）+ "浏览"按钮（触发 `<input type="file">`）
4. **上传按钮**：渐变背景主按钮 "⇧ 上传文件"
5. **传输日志**：带滚动的小型日志面板，显示代理状态、传输进度、错误信息
6. **进度条**：实时百分比进度条

### TFTP 协议实现

- 仅支持上传 (WRQ)
- octet（二进制）传输模式
- 自动使用本地文件名作为远程文件名
- 标准 TFTP 数据包格式：RRQ/WRQ(2 bytes opcode) + filename + 0 + mode + 0
- 超时重传机制
- 块编号 (block number) 管理

### tftp-proxy.js

- 轻量 Node.js 脚本，依赖 `ws`（WebSocket）和 `dgram`（原生 UDP）
- 通过命令行启动：`node tftp-proxy.js`
- WebSocket 端口 52345（固定）
- 接收浏览器端的 JSON 指令：`{ type: "upload", addr, port, filename, data }`
- 转发为 TFTP UDP 包到目标设备
- 返回传输状态、进度、结果

```javascript
// 协议示例
// 浏览器 → 代理: { type: "upload", addr: "192.168.1.100", port: 69, filename: "fw.bin", data: <base64> }
// 代理 → 浏览器: { type: "progress", sent: 1024, total: 65536 }
// 代理 → 浏览器: { type: "complete", filename: "fw.bin" }
// 代理 → 浏览器: { type: "error", message: "Timeout" }
```

## 技术实现

### 文件变更

1. **WebTerminal.html**：新增右侧面板 HTML/CSS/JS，约 +400 行
   - CSS：右侧面板样式、工具区块、segmented control、进度条等
   - JS：校验算法（CRC/MD5/SHA 纯前端实现）、浮点数转换、ASCII 表渲染、TFTP WebSocket 通信
2. **tftp-proxy.js**：新增文件，约 200 行

### 校验算法实现

- CRC8/16/32：查表法高效计算
- MD5/SHA1/SHA256：使用 Web Crypto API（`crypto.subtle.digest`）+ 纯 JS fallback
- Sum8/Sum16/XOR：简单逐字节累加

### 浮点数转换实现

- float32：使用 `DataView` + `Float32Array` / `Uint32Array` 互转
- float64：使用 `DataView` + `Float64Array` / `BigUint64Array` 互转
- 二进制字符串：逐位提取

### 状态管理

- 右侧面板显示状态（布尔值）
- 各工具展开/折叠状态（对象）
- TFTP 代理连接状态、传输状态
- 所有状态与现有代码风格一致，使用全局变量

### 错误处理

- 校验计算：HEX 格式错误时输入框红色边框提示
- 浮点数转换：无效输入时显示 "--"
- TFTP：代理连接失败、传输超时、文件读取错误，均显示在日志区
