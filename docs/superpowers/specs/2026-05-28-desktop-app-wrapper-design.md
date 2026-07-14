# WebTerm Pro 桌面应用封装设计

## 概述

将单文件 Web Serial 调试终端 `WebSerialTerminal.html` 封装为可固定到 Windows 任务栏的独立应用，通过 PWA + 本地 Node.js HTTP 服务器实现，无需修改核心 HTML 文件。

## 架构

```
任务栏 PWA 独立窗口 (Chrome/Edge)
        ↕ HTTP (localhost:1982)
Node.js HTTP 服务器 (后台静默运行)
        ↕ Windows 登录时自启
注册表 HKCU\...\Run → start.vbs → node server.js
```

- **PWA + `display: standalone`** 提供独立窗口体验（无地址栏、无标签页）
- **Node.js 原生 `http` 模块** 提供静态文件服务，零第三方依赖
- **注册表自启** 实现开机自动启动，比任务计划程序更轻量，无需管理员权限
- **VBS 隐藏窗口** 避免控制台黑框常驻

## 端口

`1982` — 高位端口，冲突概率低。

## 文件清单

| 文件 | 用途 | 类型 |
|------|------|------|
| `WebSerialTerminal.html` | 核心应用 | 不修改 |
| `server.js` | Node.js HTTP 服务器 | 新建 |
| `manifest.json` | PWA 应用清单 | 新建 |
| `start.vbs` | 静默启动脚本（隐藏控制台窗口） | 新建 |
| `install.bat` | 安装脚本：生成 VBS、注册自启、启动服务器、引导 PWA 安装 | 新建 |
| `uninstall.bat` | 卸载脚本：移除自启、终止进程 | 新建 |
| `icons/icon-192x192.png` | PWA 应用图标 192px | 新建 |
| `icons/icon-512x512.png` | PWA 应用图标 512px | 新建 |
| `generate-icons.js` | 图标生成脚本（用完可删） | 新建 |

## server.js

极简 Node.js HTTP 服务器，仅服务静态文件：

- 响应 `/` → `WebSerialTerminal.html`
- 响应 `/manifest.json` → `manifest.json`
- 响应 `/icons/*` → 对应图标文件
- 其余路径 → 404

使用原生 `http` + `fs` 模块，无第三方依赖。

## manifest.json

PWA 配置关键参数：

```json
{
  "name": "WebTerm Pro",
  "short_name": "WebTerm",
  "start_url": "http://localhost:1982",
  "display": "standalone",
  "background_color": "#0a0a0a",
  "theme_color": "#00ff41"
}
```

`display: standalone` 是 PWA 独立窗口的核心配置。图标指向 `icons/icon-192x192.png` 和 `icons/icon-512x512.png`。

## 应用图标

占位图标：深色圆角背景 + 绿色发光 `>_` 终端符号 + CRT 风格扫描线。通过 SVG → sharp 自动生成，用户可随时替换 `icons/` 目录下的 PNG 文件。

## 启动流程

### 安装步骤（install.bat）

1. 检测 `node` 是否已安装（如果缺失则提示错误）
2. 动态生成 `start.vbs`，写入服务器启动命令（隐藏窗口）
3. 写入注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 指向 `start.vbs`
4. 通过 `start.vbs` 启动 `node server.js`
5. 用默认浏览器打开 `http://localhost:1982`
6. 提示用户在浏览器地址栏点击安装 PWA

### 运行时

1. Windows 登录 → 注册表触发 → `start.vbs` → 隐藏窗口启动 `node server.js`
2. 用户点击任务栏 PWA 图标 → 浏览器以独立窗口打开 `http://localhost:1982`
3. 终端功能完全通过原有 `WebSerialTerminal.html` 运行

### 卸载步骤（uninstall.bat）

1. 从注册表中删除自启条目
2. 终止 `node server.js` 进程
3. 提示手动从浏览器中卸载 PWA

## package.json 更新

追加脚本：

```json
{
  "scripts": {
    "start": "node server.js",
    "generate-icons": "node generate-icons.js"
  }
}
```

## 边界情况

- **Node.js 未安装**：install.bat 检测并提示用户安装，不继续执行
- **端口 1982 被占用**：server.js 启动失败时输出友好错误信息，指导用户关闭占用进程
- **Web Serial API 不可用**：这是浏览器限制（需要 HTTPS 或 localhost），PWA 窗口通过 localhost 访问，因此兼容
- **浏览器不支持 PWA**：Edge 和 Chrome 均完全支持，无需降级方案
- **用户移动项目目录后**：需要重新运行 install.bat（路径变了需要更新 VBS 和注册表）
