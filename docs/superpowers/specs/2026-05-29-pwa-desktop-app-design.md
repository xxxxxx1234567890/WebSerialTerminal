# WebTerm Pro PWA 桌面应用封装设计

## 概述

将单文件 Web Serial 调试终端 `WebSerialTerminal.html` 封装为可安装到 Windows 任务栏的独立 PWA 桌面应用。参照 WebTools 项目的成熟 PWA 实现模式，修复此前 `install.bat` 批处理文件的 UTF-8 编码兼容性问题，补全 Service Worker 等 PWA 必需组件。

## 架构

```
用户点击任务栏 PWA 图标
        ↕ 独立窗口 (display: standalone)
浏览器 PWA 运行时
        ↕ HTTP localhost:1982
Node.js HTTP 服务器 (后台静默运行)
        ↕ Windows 登录时自启
注册表 HKCU\...\Run → start.vbs → node server.js
```

- **PWA `display: standalone`** 提供独立窗口体验（无地址栏、无标签页）
- **Node.js 原生 `http` 模块** 提供静态文件服务，零第三方依赖
- **注册表自启** 实现开机自动启动（HKCU，无需管理员权限）
- **VBS 隐藏窗口** 避免控制台黑框常驻
- **PowerShell 安装脚本** 替代批处理，彻底规避 UTF-8 编码问题

## 端口

`1982` — 保持不变，高位端口，冲突概率低。

## 文件清单

### 修改的文件

| 文件 | 变更说明 |
|------|----------|
| `server.js` | 重写 — 完整 MIME 类型表、`Service-Worker-Allowed` 头、路径遍历防护 |
| `manifest.json` | 修改 — 增加 `scope`、`id`、`display_override`、`purpose: maskable` |
| `WebSerialTerminal.html` | 追加 — 在 `</body>` 前添加 service worker 注册和 `pwa-install.js` 引用 |

### 新增的文件

| 文件 | 说明 |
|------|------|
| `sw.js` | Service Worker — 预缓存静态资源，网络优先策略 |
| `pwa-install.js` | PWA 安装提示弹窗，处理 `beforeinstallprompt` 事件 |

### 替换的文件

| 文件 | 替换为 | 原因 |
|------|--------|------|
| `install.bat` | `install.ps1` | PowerShell 脚本，解决 UTF-8 编码导致的变量解析错误 |
| `uninstall.bat` | `uninstall.ps1` | 同上 |

### 保留的文件

`install.cmd`、`uninstall.cmd`、`generate-icons.js`、`icons/icon-192x192.png`、`icons/icon-512x512.png`

## 组件详细设计

### server.js

使用 Node.js 原生 `http` + `fs` + `path` 模块，零第三方依赖。

```js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 1982;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/WebSerialTerminal.html' : req.url;

  // 路径遍历防护
  const fullPath = path.join(ROOT, filePath);
  if (!fullPath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end();
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404).end();
      return;
    }
    const headers = { 'Content-Type': contentType };
    if (filePath === '/sw.js') {
      headers['Service-Worker-Allowed'] = '/';
      headers['Cache-Control'] = 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(content);
  });
}).listen(PORT, () => {
  console.log(`WebTerm Pro running at http://localhost:${PORT}`);
}).on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请关闭占用进程后重试`);
    process.exit(1);
  }
  console.error('服务器启动失败:', err.message);
  process.exit(1);
});
```

关键变更：
- 完整的 MIME 类型表，覆盖 .js、.css、.svg、.ico
- `Service-Worker-Allowed: /` 头部，允许 sw.js 控制根作用域
- 路径遍历防护
- 保留端口占用检测

### manifest.json

```json
{
  "name": "WebTerm Pro",
  "short_name": "WebTerm",
  "description": "Web Serial 调试终端",
  "start_url": "/",
  "scope": "/",
  "id": "/",
  "display": "standalone",
  "display_override": ["window-controls-overlay", "standalone"],
  "background_color": "#0a0a0a",
  "theme_color": "#00ff41",
  "icons": [
    {
      "src": "icons/icon-192x192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any maskable"
    },
    {
      "src": "icons/icon-512x512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ]
}
```

关键变更：
- `start_url` 从绝对 URL 改为相对路径 `/`
- 新增 `scope: "/"` 和 `id: "/"`，PWA 安装必需
- 新增 `display_override`，更好的窗口控件支持
- 新增 `purpose: "any maskable"`，自适应图标

### sw.js

最小可行 Service Worker，仅缓存静态资源以满足 PWA 安装要求。

```js
const CACHE = 'webterm-v1';
const URLS = [
  '/',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
```

策略说明：
- 网络优先：保证每次都加载最新版本
- 缓存回退：离线时至少显示界面
- 不缓存串口通信数据
- 安装时预缓存：HTML、manifest、图标

### pwa-install.js

参照 WebTools 的 `pwa-install.js`，适配 WebTerm Pro 的深色赛博朋克主题。

功能：
- 监听 `beforeinstallprompt` 事件
- 右下角弹出安装提示卡片（绿色主题，与 WebTerm Pro 风格一致）
- 用户拒绝后 7 天内不再提示（localStorage 记录）
- 点击安装按钮触发原生 PWA 安装弹窗
- 如果 `deferredPrompt` 不可用，显示手动安装指引
- 检测 `display-mode: standalone`，已安装则不显示

样式要点：
- 暗色背景 (`#0a0a0a`)，绿色强调色 (`#00ff41`)
- 等宽字体，与终端风格统一
- 右下角固定定位，滑入动画

### WebSerialTerminal.html 追加内容

在 `</body>` 前追加：

```html
<script>
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}
</script>
<script src="pwa-install.js"></script>
```

不影响现有任何功能，仅当通过 HTTP 服务器访问时生效。

### install.ps1

PowerShell 安装脚本，替代原有 `install.bat`。

流程：
1. 检测 Node.js 是否已安装（`Get-Command node`）
2. 检测端口 1982 是否被占用（可选警告）
3. 动态生成 `start.vbs`，内容：`CreateObject("WScript.Shell").Run "node ""<绝对路径>\server.js""", 0, False`
4. 写入注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，键名 `WebTermPro`
5. 通过 `Start-Process wscript.exe` 启动 `start.vbs`
6. `Start-Sleep 2` 等待服务器就绪
7. `Start-Process http://localhost:1982` 打开浏览器
8. 提示用户在浏览器中点击安装 PWA

错误处理：
- Node.js 未安装 → `Write-Host -ForegroundColor Red` 错误提示 + 下载链接
- 注册表写入失败 → `try/catch` 静默继续（catch 中输出黄色警告）
- 所有步骤有中文状态输出

### uninstall.ps1

PowerShell 卸载脚本，替代原有 `uninstall.bat`。

流程：
1. 从注册表删除自启项（`Remove-ItemProperty`，try/catch 忽略不存在错误）
2. 终止运行中的 `node.exe` 进程（`Get-Process node | Stop-Process -Force`）
3. 删除 `start.vbs`
4. 提示在浏览器中卸载 PWA（`edge://apps` 或 `chrome://apps`）

### install.cmd / uninstall.cmd

保留现有内容不变：

```bat
@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
```

用户双击 `.cmd` 文件 → 调用 PowerShell → 执行安装/卸载流程。

## 操作流程

### 安装步骤

1. 用户双击 `install.cmd`
2. PowerShell 检测 Node.js 是否已安装
3. 生成 `start.vbs`（隐藏窗口启动脚本）
4. 写入注册表 `HKCU\...\Run` 实现开机自启
5. 启动 `node server.js`（通过 `start.vbs` 隐藏窗口）
6. 等待 2 秒确保服务器就绪
7. 用默认浏览器打开 `http://localhost:1982`
8. Service Worker 注册成功
9. 浏览器检测到符合 PWA 安装条件，触发 `beforeinstallprompt`
10. `pwa-install.js` 弹出绿色主题安装提示卡片
11. 用户点击"安装" → 原生 PWA 安装弹窗 → 确认安装
12. PWA 以独立窗口启动，可固定到任务栏

### 运行步骤

1. Windows 登录 → 注册表触发 → `start.vbs` → 隐藏窗口启动 `node server.js`
2. 用户点击任务栏 PWA 图标 → 浏览器以独立窗口打开 `http://localhost:1982`
3. 终端功能完全通过原有 `WebSerialTerminal.html` 运行

### 卸载步骤

1. 用户双击 `uninstall.cmd`
2. PowerShell 从注册表删除自启项
3. 终止 `node.exe` 进程
4. 删除 `start.vbs`
5. 提示手动从浏览器卸载 PWA（`edge://apps` 或 `chrome://apps`）

## 边界情况

| 场景 | 处理方式 |
|------|----------|
| Node.js 未安装 | install.ps1 检测并提示用户安装，不继续执行 |
| 端口 1982 被占用 | server.js 启动失败时输出友好错误信息并退出 |
| 注册表写入失败 | 非管理员运行时 try/catch 捕获错误，黄色警告提示，不影响启动 |
| Web Serial API 不可用 | PWA 窗口通过 localhost 访问，Web Serial API 正常工作 |
| 浏览器不支持 PWA | Edge 和 Chrome 均完全支持，无需降级方案 |
| 用户移动项目目录 | 需要重新运行 install.cmd（路径变了需更新 VBS 和注册表） |
| 直接双击 HTML 打开 | 不受任何影响，功能与修改前完全一致 |

## 不变的原则

- `WebSerialTerminal.html` 核心逻辑（CSS、HTML、JS）不受影响
- 直接双击 HTML 文件打开仍然可用
- 零第三方 npm 依赖
- 端口 1982 不变
- 图标文件不变
- 注册表自启路径与现有方案一致
