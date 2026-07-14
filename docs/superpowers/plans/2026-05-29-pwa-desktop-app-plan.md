# WebTerm Pro PWA 桌面应用封装 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 WebTerm Pro 封装为可安装到 Windows 任务栏的独立 PWA 桌面应用，修复原批处理安装脚本的编码问题。

**Architecture:** Node.js HTTP 服务器提供静态文件服务（localhost:1982），PWA manifest + Service Worker 满足浏览器安装条件，PowerShell 脚本处理注册表自启和进程管理。参考 WebTools 项目的成熟 PWA 模式。

**Tech Stack:** Node.js (原生 http 模块), PWA (manifest.json + Service Worker), PowerShell 5+

---

### 前置条件检查

- [ ] **Step 0.1: 确认现有文件状态**

```bash
cd "D:/Claude WorkSpace/Web Terminal"
ls -la server.js manifest.json install.bat uninstall.bat icons/
```

Expected: 所有文件存在，icons 目录包含 icon-192x192.png 和 icon-512x512.png

- [ ] **Step 0.2: 确认 Node.js 可用**

```bash
node --version
```

Expected: 输出 v18+ 版本号

---

### Task 1: 创建 sw.js

**Files:**
- Create: `sw.js`

- [ ] **Step 1.1: 创建 Service Worker 文件**

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

- [ ] **Step 1.2: 验证文件创建成功**

```bash
cd "D:/Claude WorkSpace/Web Terminal"
wc -l sw.js
```

Expected: sw.js 存在且约 30 行

---

### Task 2: 重写 server.js

**Files:**
- Modify: `server.js`（完整重写）

- [ ] **Step 2.1: 写入新 server.js**

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

- [ ] **Step 2.2: 验证服务器可启动并返回正确响应**

```bash
cd "D:/Claude WorkSpace/Web Terminal"
# 清理上次运行的实例
taskkill /f /im node.exe 2>/dev/null || true
node server.js &
sleep 2
# 测试 HTML
curl -s -o /dev/null -w "%{http_code}" http://localhost:1982
echo ""
# 测试 manifest
curl -s -o /dev/null -w "%{http_code}" http://localhost:1982/manifest.json
echo ""
# 测试 sw.js (关键：验证 Service-Worker-Allowed 头)
curl -s -D - http://localhost:1982/sw.js 2>/dev/null | head -20
echo ""
# 测试图标
curl -s -o /dev/null -w "%{http_code}" http://localhost:1982/icons/icon-192x192.png
echo ""
# 测试 404
curl -s -o /dev/null -w "%{http_code}" http://localhost:1982/nonexistent
echo ""
# 清理
taskkill /f /im node.exe 2>/dev/null || true
```

Expected: HTML → 200, manifest → 200, sw.js → 200 且包含 `Service-Worker-Allowed: /` 头, icons → 200, 不存在路径 → 404

---

### Task 3: 更新 manifest.json

**Files:**
- Modify: `manifest.json`

- [ ] **Step 3.1: 写入新 manifest.json**

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

- [ ] **Step 3.2: 验证 JSON 格式正确**

```bash
cd "D:/Claude WorkSpace/Web Terminal"
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('JSON valid')"
```

Expected: 输出 "JSON valid"

---

### Task 4: 创建 pwa-install.js

**Files:**
- Create: `pwa-install.js`

- [ ] **Step 4.1: 创建 PWA 安装提示脚本**

```js
// pwa-install.js - 自定义 PWA 安装提示（WebTerm Pro 暗色主题版）
let deferredPrompt;

// 检测是否已安装
const isInstalled = window.matchMedia('(display-mode: standalone)').matches;
// 仅在 localhost 下可用（Web Serial API 需要安全上下文）
const isLocalhost = window.location.hostname === 'localhost' || 
                   window.location.hostname === '127.0.0.1';

if (isInstalled) {
  console.log('[PWA] 已安装为独立应用');
}

// 创建安装提示
function createInstallPrompt() {
  if (isInstalled || !isLocalhost) return;

  const lastDismissed = localStorage.getItem('wtp_pwa_dismiss');
  if (lastDismissed && Date.now() - parseInt(lastDismissed) < 7 * 24 * 60 * 60 * 1000) {
    return;
  }

  const div = document.createElement('div');
  div.id = 'wtp-pwa-prompt';
  div.innerHTML = `
    <div class="wtp-pwa-card">
      <div class="wtp-pwa-icon">&#x233C;</div>
      <div class="wtp-pwa-text">
        <div class="wtp-pwa-title">安装 WebTerm Pro</div>
        <div class="wtp-pwa-desc">安装为独立应用，支持任务栏快捷启动</div>
      </div>
      <button id="wtp-pwa-install-btn" class="wtp-pwa-btn">安装</button>
      <button id="wtp-pwa-dismiss-btn" class="wtp-pwa-close">&times;</button>
    </div>
  `;
  document.body.appendChild(div);

  // 样式
  const style = document.createElement('style');
  style.textContent = `
    #wtp-pwa-prompt {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 99999;
      animation: wtpPwaSlideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .wtp-pwa-card {
      display: flex;
      align-items: center;
      gap: 12px;
      background: #0d1520;
      border: 1px solid #1a3a5c;
      border-radius: 12px;
      padding: 12px 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6), 0 0 20px rgba(0,212,255,0.08);
      font-family: 'Rajdhani', 'Segoe UI', sans-serif;
    }
    .wtp-pwa-icon {
      font-size: 28px;
      color: #00d4ff;
      text-shadow: 0 0 10px rgba(0,212,255,0.4);
    }
    .wtp-pwa-text {
      flex: 1;
      min-width: 0;
    }
    .wtp-pwa-title {
      color: #c8e8ff;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    .wtp-pwa-desc {
      color: #5a8aaa;
      font-size: 12px;
      margin-top: 2px;
    }
    .wtp-pwa-btn {
      background: #00d4ff;
      color: #050709;
      border: none;
      border-radius: 6px;
      padding: 6px 16px;
      font-family: 'Rajdhani', sans-serif;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .wtp-pwa-btn:hover {
      background: #00ff88;
      box-shadow: 0 0 16px rgba(0,255,136,0.3);
    }
    .wtp-pwa-close {
      background: transparent;
      border: none;
      color: #2a4a6a;
      font-size: 18px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    .wtp-pwa-close:hover {
      color: #5a8aaa;
    }
    @keyframes wtpPwaSlideUp {
      from { transform: translateX(-50%) translateY(20px); opacity: 0; }
      to   { transform: translateX(-50%) translateY(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  document.getElementById('wtp-pwa-install-btn').onclick = () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(choice => {
        if (choice.outcome === 'accepted') {
          console.log('[PWA] 用户已安装');
          hideInstallPrompt();
        }
        deferredPrompt = null;
      });
    } else {
      showManualInstructions();
    }
  };

  document.getElementById('wtp-pwa-dismiss-btn').onclick = () => {
    localStorage.setItem('wtp_pwa_dismiss', Date.now());
    hideInstallPrompt();
  };
}

function hideInstallPrompt() {
  const el = document.getElementById('wtp-pwa-prompt');
  if (el) {
    el.style.transition = 'opacity 0.3s, transform 0.3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(10px)';
    setTimeout(() => el.remove(), 300);
  }
}

function showManualInstructions() {
  const overlay = document.createElement('div');
  overlay.id = 'wtp-pwa-manual';
  overlay.innerHTML = `
    <div class="wtp-pwa-manual-overlay">
      <div class="wtp-pwa-manual-card">
        <h3>手动安装说明</h3>
        <p>您的浏览器未触发自动安装提示，请按以下步骤操作：</p>
        <div class="wtp-pwa-manual-step"><strong>Chrome：</strong>点击地址栏右侧的安装图标 <span class="wtp-pwa-manual-icon">&#x2197;</span></div>
        <div class="wtp-pwa-manual-step"><strong>Edge：</strong>点击菜单 → "应用" → "安装此站点作为应用"</div>
        <button id="wtp-pwa-manual-close" class="wtp-pwa-btn">知道了</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const style = document.createElement('style');
  style.textContent = `
    #wtp-pwa-manual {
      position: fixed; inset: 0; z-index: 99999;
      display: flex; align-items: center; justify-content: center;
      background: rgba(5,7,9,0.85);
      animation: wtpFadeIn 0.3s;
      font-family: 'Rajdhani', 'Segoe UI', sans-serif;
    }
    .wtp-pwa-manual-card {
      background: #0d1520;
      border: 1px solid #1a3a5c;
      border-radius: 12px;
      padding: 32px;
      max-width: 420px;
      box-shadow: 0 16px 48px rgba(0,0,0,0.6);
      color: #c8e8ff;
    }
    .wtp-pwa-manual-card h3 {
      color: #00d4ff;
      margin: 0 0 12px;
      font-size: 18px;
    }
    .wtp-pwa-manual-card p {
      color: #5a8aaa;
      margin: 0 0 16px;
      font-size: 14px;
    }
    .wtp-pwa-manual-step {
      background: #090d12;
      border: 1px solid #1a3a5c;
      border-radius: 8px;
      padding: 10px 14px;
      margin-bottom: 8px;
      font-size: 13px;
    }
    .wtp-pwa-manual-step strong {
      color: #00ff88;
    }
    .wtp-pwa-manual-icon {
      color: #00d4ff;
    }
    #wtp-pwa-manual-close {
      margin-top: 16px;
      float: right;
    }
    @keyframes wtpFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  document.getElementById('wtp-pwa-manual-close').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

// 监听 beforeinstallprompt
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  setTimeout(createInstallPrompt, 2000);
});

// 监听安装完成
window.addEventListener('appinstalled', () => {
  console.log('[PWA] 应用已安装');
  localStorage.removeItem('wtp_pwa_dismiss');
  hideInstallPrompt();
});
```

- [ ] **Step 4.2: 验证文件语法**

```bash
cd "D:/Claude WorkSpace/Web Terminal"
node -c pwa-install.js
```

Expected: 无语法错误输出

---

### Task 5: 修改 WebSerialTerminal.html

**Files:**
- Modify: `WebSerialTerminal.html`（在 `</body>` 前追加两段脚本）

- [ ] **Step 5.1: 在 `</body>` 前追加脚本引用**

在 `WebSerialTerminal.html` 的 `</body>` 标签前一行的位置插入：

```html
<script>
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}
</script>
<script src="pwa-install.js"></script>
```

修改后该区域应为：

```html
  if (e.ctrlKey && e.key === 'd') { e.preventDefault(); if (isConnected) disconnectPort(); }
});
</script>
<script>
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}
</script>
<script src="pwa-install.js"></script>
</body>
</html>
```

- [ ] **Step 5.2: 验证 HTML 结构完整**

```bash
cd "D:/Claude WorkSpace/Web Terminal"
# 确认 </body> 前有新增脚本
grep -n "serviceWorker" WebSerialTerminal.html
grep -n "pwa-install.js" WebSerialTerminal.html
```

Expected: 两行 grep 均返回匹配行号

---

### Task 6: 创建 install.ps1

**Files:**
- Create: `install.ps1`

- [ ] **Step 6.1: 创建 PowerShell 安装脚本**

```powershell
$ErrorActionPreference = "Stop"
$installDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "============================================" -ForegroundColor Cyan
Write-Host " WebTerm Pro - 桌面应用安装脚本" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# 检测 Node.js
try {
    $nodeVersion = & node --version
    Write-Host "[OK]  Node.js $nodeVersion" -ForegroundColor Green
}
catch {
    Write-Host "[错误] 未检测到 Node.js，请先安装 Node.js" -ForegroundColor Red
    Write-Host "下载地址: https://nodejs.org/" -ForegroundColor Yellow
    Read-Host "按回车键退出"
    exit 1
}

# 生成 start.vbs（隐藏窗口启动）
$vbsContent = 'CreateObject("WScript.Shell").Run "node """' + $installDir + '\server.js""", 0, False'
Set-Content -Path "$installDir\start.vbs" -Value $vbsContent -Encoding ASCII
Write-Host "[OK]  已生成 start.vbs" -ForegroundColor Green

# 添加到注册表自启
$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$regValue = "wscript.exe `"$installDir\start.vbs`""
try {
    Set-ItemProperty -Path $regPath -Name "WebTermPro" -Value $regValue -Type String -ErrorAction Stop
    Write-Host "[OK]  已添加开机自启" -ForegroundColor Green
}
catch {
    Write-Host "[警告] 无法写入注册表，可能需要管理员权限" -ForegroundColor Yellow
    Write-Host "       不影响手动启动，可稍后以管理员身份运行" -ForegroundColor Yellow
}

# 启动服务器
Start-Process -FilePath "wscript.exe" -ArgumentList "`"$installDir\start.vbs`"" -WindowStyle Hidden
Write-Host "[OK]  已启动服务器" -ForegroundColor Green

# 等待服务器就绪
$maxWait = 10
$serverReady = $false
for ($i = 1; $i -le $maxWait; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:1982" -TimeoutSec 1 -UseBasicParsing
        if ($response.StatusCode -eq 200) {
            $serverReady = $true
            break
        }
    }
    catch {
        Start-Sleep -Seconds 1
    }
}

if ($serverReady) {
    Write-Host "[OK]  服务器已就绪 (localhost:1982)" -ForegroundColor Green
}
else {
    Write-Host "[警告] 服务器启动超时，请手动检查" -ForegroundColor Yellow
}

# 打开浏览器
Start-Process "http://localhost:1982"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host " 安装完成!" -ForegroundColor Cyan
Write-Host ""
Write-Host " 请在打开的浏览器中：" -ForegroundColor White
Write-Host " 1. 等待右下角弹出安装提示" -ForegroundColor White
Write-Host " 2. 点击「安装」按钮" -ForegroundColor White
Write-Host " 3. 安装后即可固定到任务栏" -ForegroundColor White
Write-Host ""
Write-Host " 提示：浏览器地址栏右侧也可能出现安装图标" -ForegroundColor DarkGray
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Read-Host "按回车键退出"
```

- [ ] **Step 6.2: 验证 PowerShell 语法**

```bash
cd "D:/Claude WorkSpace/Web Terminal"
powershell -NoProfile -Command "Get-Command $pwd\install.ps1" 2>&1 || echo "语法检查通过（脚本需要运行时实际验证）"
```

Expected: 无解析错误（PowerShell 脚本的语法错误在运行时才会暴露）

---

### Task 7: 创建 uninstall.ps1

**Files:**
- Create: `uninstall.ps1`

- [ ] **Step 7.1: 创建 PowerShell 卸载脚本**

```powershell
$ErrorActionPreference = "Stop"
$installDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "============================================" -ForegroundColor Cyan
Write-Host " WebTerm Pro - 卸载脚本" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# 删除注册表自启项
$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
try {
    Remove-ItemProperty -Path $regPath -Name "WebTermPro" -ErrorAction Stop
    Write-Host "[OK]  已删除开机自启" -ForegroundColor Green
}
catch {
    Write-Host "[信息] 注册表中未找到自启项" -ForegroundColor DarkGray
}

# 终止运行的 Node.js 服务器
Write-Host "正在关闭 WebTerm Pro 服务器..." -ForegroundColor Yellow
try {
    $nodeProcesses = Get-Process -Name "node" -ErrorAction SilentlyContinue
    foreach ($proc in $nodeProcesses) {
        try {
            if ($proc.CommandLine -match "server.js") {
                $proc.Kill()
                Write-Host "[OK]  已终止 Node.js 进程 (PID: $($proc.Id))" -ForegroundColor Green
            }
        }
        catch { }
    }
}
catch {
    Write-Host "[信息] 没有正在运行的服务器进程" -ForegroundColor DarkGray
}

# 删除 start.vbs
$vbsPath = "$installDir\start.vbs"
if (Test-Path $vbsPath) {
    Remove-Item $vbsPath -Force
    Write-Host "[OK]  已删除 start.vbs" -ForegroundColor Green
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host " 卸载完成!" -ForegroundColor Cyan
Write-Host ""
Write-Host " 请在浏览器中手动卸载 PWA 应用：" -ForegroundColor White
Write-Host " Chrome: chrome://apps → 找到 WebTerm Pro → 右键卸载" -ForegroundColor White
Write-Host " Edge:   edge://apps → 找到 WebTerm Pro → 右键卸载" -ForegroundColor White
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Read-Host "按回车键退出"
```

- [ ] **Step 7.2: 验证文件创建**

```bash
cd "D:/Claude WorkSpace/Web Terminal"
ls -la install.ps1 uninstall.ps1
```

Expected: 两个文件都存在

---

### Task 8: 清理旧批处理文件

**Files:**
- Delete: `install.bat`
- Delete: `uninstall.bat`

- [ ] **Step 8.1: 备份并删除旧版批处理脚本**

```bash
cd "D:/Claude WorkSpace/Web Terminal"
# 备份（安全起见，重命名而非删除）
mv install.bat install.bat.bak
mv uninstall.bat uninstall.bat.bak
```

- [ ] **Step 8.2: 验证清理结果**

```bash
cd "D:/Claude WorkSpace/Web Terminal"
ls -la install.bat uninstall.bat 2>&1 || echo "旧批处理文件已移除"
ls -la install.bat.bak uninstall.bat.bak
```

Expected: install.bat 和 uninstall.bat 不存在，.bak 文件存在

---

### Task 9: 端到端验证

- [ ] **Step 9.1: 启动服务器并验证完整响应**

```bash
cd "D:/Claude WorkSpace/Web Terminal"
# 清理旧进程
taskkill /f /im node.exe 2>/dev/null || true
sleep 1

# 启动服务器
node server.js &
sleep 2

# 验证所有端点
echo "=== Testing HTML ==="
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:1982

echo "=== Testing manifest.json ==="
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:1982/manifest.json

echo "=== Testing sw.js (headers) ==="
curl -s -D - http://localhost:1982/sw.js 2>/dev/null | grep -i "service-worker-allowed"

echo "=== Testing icons ==="
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:1982/icons/icon-192x192.png
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:1982/icons/icon-512x512.png

echo "=== Testing 404 ==="
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:1982/nonexistent

echo "=== Testing 403 (path traversal) ==="
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:1982/..%5Cserver.js"

# 清理
taskkill /f /im node.exe 2>/dev/null || true
```

Expected:
- HTML → 200
- manifest → 200
- sw.js → 包含 `service-worker-allowed: /` 头
- 图标 → 200
- 不存在路径 → 404
- 路径遍历 → 403

- [ ] **Step 9.2: 验证文件夹中 svg/png 等静态文件的 MIME 类型**

```bash
cd "D:/Claude WorkSpace/Web Terminal"
# 如果 icons 目录有 svg 文件则测试
ls icons/*.svg 2>/dev/null && curl -s -D - http://localhost:1982/icons/*.svg 2>/dev/null | grep -i "content-type"
```

Expected: SVG 返回 `image/svg+xml`

- [ ] **Step 9.3: 记录最终文件清单**

```bash
cd "D:/Claude WorkSpace/Web Terminal"
echo "=== 项目文件清单 ==="
ls -la server.js manifest.json sw.js pwa-install.js install.ps1 uninstall.ps1 install.cmd uninstall.cmd
echo ""
echo "=== 备份文件 ==="
ls -la install.bat.bak uninstall.bat.bak 2>/dev/null || echo "无备份文件"
```

Expected: 所有新文件存在，旧 bat 文件已备份
