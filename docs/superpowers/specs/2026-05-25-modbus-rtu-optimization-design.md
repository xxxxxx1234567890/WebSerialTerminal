# Modbus RTU 工具优化 — 设计文档

## 概述

对 WebTerm Pro 右侧工具箱中的 Modbus RTU 调试工具进行重构，支持两种使用场景：

1. **共享串口模式** — Modbus RTU 使用终端当前打开的串口，激活时终端功能冻结
2. **独立串口模式** — Modbus RTU 和终端各用各的串口，完全独立互不影响

## 架构方案

采用**轻量扩展**方案（方案 A）：在现有代码结构上扩展，不引入连接管理器抽象。

核心思路：Modbus 面板增加「激活」开关和「共享/独立」模式选择，两种模式下收发走不同通路。

## 新增状态变量

```js
let modbusActive = false;         // Modbus 模式总开关
let modbusPortMode = 'shared';    // 'shared' | 'independent'

// 独立串口（仅 independent 模式用）
let modbusPort = null;
let modbusReader = null;
let modbusWriter = null;
let modbusConnected = false;
let modbusReadLoopRunning = false;
```

## UI 布局

在现有 Modbus 面板顶部新增控件：

```
◈ Modbus RTU 调试
├── [🔘 Modbus 模式]          ← 全局开关 toggle
├── [共享串口 | 独立串口]      ← 模式选择 segmented-control
├── [连接独立串口] [状态指示]   ← 仅独立模式显示
├── 请求构建器 (不变)
├── TX/RX 帧显示 (不变)
├── 响应解析 (不变)
└── 日志 (不变)
```

## 数据流

### 共享模式

```
用户开启 Modbus（共享）
  → modbusActive = true
  → 终端 isPaused = true，输入禁用
  → readLoop 继续收 value，但跳过 appendLine
  → 仅 modbusFeedResponse(value) 处理 Modbus 响应
  → 发送走全局 writer.write()
  → 关闭 Modbus → 恢复终端
```

### 独立模式

```
用户开启 Modbus（独立）→ 点击连接独立串口
  → navigator.serial.requestPort() → 打开第二个串口
  → 独立 modbusReadLoop() 运行
  → 终端完全不受影响
  → 发送走 modbusWriter.write()
  → 接收走 modbusReadLoop，不经主终端
  → 关闭 Modbus → 断开独立串口
```

## 关键交互

| 操作 | 共享模式 | 独立模式 |
|------|---------|---------|
| 开启 Modbus | 终端暂停，输入禁用 | 显示连接按钮 |
| 发送 | writer.write() | modbusWriter.write() |
| 接收 | modbusFeedResponse 从 readLoop 分流 | 独立 readLoop 直接解析 |
| 关闭 Modbus | 恢复终端 | 关闭独立串口 |
| 终端断开 | Modbus 被迫退出 | 不受影响 |
| 独立串口断开 | — | 面板显示断开状态 |

## 新增函数

| 函数 | 用途 |
|------|------|
| `modbusToggleActive()` | Modbus 开关切换，管理冻结/恢复 |
| `modbusSetMode(mode)` | 共享/独立模式切换 |
| `modbusConnectPort()` | 独立模式打开第二个串口 |
| `modbusDisconnectPort()` | 独立模式关闭串口 |
| `modbusReadLoop()` | 独立模式的串口读取循环 |

## 修改函数

| 函数 | 改动 |
|------|------|
| `modbusSend()` | 根据 modbusPortMode 选择 writer 或 modbusWriter |
| `modbusFeedResponse()` | 共享模式正常解析；独立模式不进入 |
| `disconnectPort()` | 共享模式时自动关闭 Modbus 状态 |
| `toggleTool('modbus')` | 折叠面板时自动退出 Modbus 模式 |

## 边界情况

- **共享模式时终端断开** → 自动关闭 Modbus 模式，通知用户
- **独立模式时终端断开** → 不影响 Modbus
- **独立模式切回共享** → 先断开独立串口
- **模式切换时** → 若独立串口已连，先断开清理再切换
- **页面刷新** → 独立串口丢失，面板恢复初始状态

## CSS 样式

沿用现有 `.tool-section`, `.tool-header`, `.tool-body`, `.toggle-switch`, `.segmented-control` 等组件样式，新增约 20 行专用样式。

## 代码改动估算

- 新增 JS：~150 行
- 新增 HTML：~30 行
- 新增 CSS：~20 行
- **总计：~200 行净新增**

不修改现有核心连接/读取/发送逻辑的结构。
