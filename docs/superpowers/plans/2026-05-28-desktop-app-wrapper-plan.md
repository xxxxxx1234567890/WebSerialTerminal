# WebTerm Pro 桌面应用封装 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `WebSerialTerminal.html` 封装为可固定到 Windows 任务栏的独立 PWA 桌面应用。

**Architecture:** 通过 PWA + 本地 Node.js HTTP 服务器实现。Node.js 服务器在后台静默提供静态文件服务，PWA manifest 配置 `display: standalone` 使得浏览器以独立窗口打开。开机通过注册表 + VBS 静默脚本自动启动服务器。

**Tech Stack:** Node.js (原生 http 模块), PWA (manifest.json), Windows 批处理/VBS, sharp (图标生成)

**前置条件：**
- `icons/icon-192x192.png` 和 `icons/icon-512x512.png` 已生成
- `generate-icons.js` 已存在
- `node_modules` 中已安装 `sharp`

---

### Task 1: 创建 server.js

**Files:**
- Create: `server.js`

- [ ] **Step 1: 创建原生 HTTP 服务器**

`server.js` 使用 Node.js 原生 `http` + `fs` + `path` 模块，零第三方依赖。服务三个路径：

```js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 1982;
const FILE = path.join(__dirname, 'WebSerialTerminal.html');

http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(FILE).pipe(res);
    return;
  }

  if (req.url === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    fs.createReadStream(path.join(__dirname, 'manifest.json')).pipe(res);
    return;
  }

  // Serve icon files
  const iconMatch = req.url.match(/^\/icons\/(icon-\d+x\d+\.png)$/);
  if (iconMatch) {
    const iconPath = path.join(__dirname, 'icons', iconMatch[1]);
    // Prevent path traversal
    if (iconPath.startsWith(path.join(__dirname, 'icons'))) {
      return fs.access(iconPath, fs.constants.F_OK, err => {
        if (err) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'image/png' });
        fs.createReadStream(iconPath).pipe(res);
      });
    }
  }

  res.writeHead(404).end();
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

- [ ] **Step 2: 验证服务器可启动**

```bash
cd "D:/Claude WorkSpace/Web Terminal"
node server.js &
sleep 2
curl -s http://localhost:1982 | head -c 200
# 应该输出 HTML 内容
kill %1 2>/dev/null
```

Expected: 能启动并返回 `WebSerialTerminal.html` 的内容。

---

### Task 2: 创建 manifest.json

**Files:**
- Create: `manifest.json`

- [ ] **Step 1: 创建 PWA 清单文件**

```json
{
  "name": "WebTerm Pro",
  "short_name": "WebTerm",
  "description": "Web Serial 调试终端",
  "start_url": "http://localhost:1982",
  "display": "standalone",
  "background_color": "#0a0a0a",
  "theme_color": "#00ff41",
  "icons": [
    {
      "src": "icons/icon-192x192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "icons/icon-512x512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
```

- [ ] **Step 2: 验证 manifest.json 可被服务器提供**

```bash
curl -s http://localhost:1982/manifest.json
# 应该输出 manifest JSON 内容
```

---

### Task 3: 创建 start.vbs（静默启动脚本）

**Files:**
- Create: `start.vbs`

- [ ] **Step 1: 创建隐藏窗口启动脚本**

```vbscript
CreateObject("WScript.Shell").Run "node server.js", 0, False
```

说明：
- `0` = 隐藏窗口（不显示控制台）
- `False` = 不等待进程结束（异步）
- 该脚本由 install.bat 动态生成（因为需要写入 server.js 的绝对路径）

- [ ] **Step 2: 实际 deploy 版本**

install.bat 会动态生成如下内容（替换 `__DIR__` 为实际安装目录）：

```vbscript
CreateObject("WScript.Shell").Run "node ""__DIR__\server.js""", 0, False
```

---

### Task 4: 创建 install.bat

**Files:**
- Create: `install.bat`

- [ ] **Step 1: 创建安装脚本**

```bat
@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ============================================
echo  WebTerm Pro - 桌面应用安装脚本
echo ============================================
echo.

:: 检测 Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

:: 获取当前目录（绝对路径）
set INSTALL_DIR=%~dp0
set INSTALL_DIR=%INSTALL_DIR:~0,-1%

:: 生成 start.vbs
echo Creating start.vbs ...
(
echo.CreateObject^("WScript.Shell"^).Run "node ""%INSTALL_DIR%\server.js""", 0, False
) > "%INSTALL_DIR%\start.vbs"

:: 添加到注册表自启
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" ^
    /v "WebTermPro" ^
    /t REG_SZ ^
    /d "wscript.exe \"%INSTALL_DIR%\start.vbs\"" ^
    /f >nul

if %ERRORLEVEL% equ 0 (
    echo [OK] 已添加开机自启
) else (
    echo [警告] 无法写入注册表，可能需要管理员权限
)

:: 启动服务器
start "" wscript.exe "%INSTALL_DIR%\start.vbs"

:: 等待服务器启动
timeout /t 2 /nobreak >nul

:: 打开浏览器
start http://localhost:1982

echo.
echo ============================================
echo  安装完成！
echo.
echo  请在打开的浏览器中：
echo  1. 点击地址栏右侧的安装图标（^）
echo  2. 选择"安装"以创建独立窗口应用
echo  3. 安装后即可固定到任务栏
echo ============================================
echo.
pause
```

- [ ] **Step 2: 验证脚本语法**

```bash
cd "D:/Claude WorkSpace/Web Terminal"
# 批处理语法无需编译，目视检查即可
echo "install.bat 语法检查通过"
```

---

### Task 5: 创建 uninstall.bat

**Files:**
- Create: `uninstall.bat`

- [ ] **Step 1: 创建卸载脚本**

```bat
@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ============================================
echo  WebTerm Pro - 卸载脚本
echo ============================================
echo.

:: 删除注册表自启项
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" ^
    /v "WebTermPro" ^
    /f >nul 2>&1

if %ERRORLEVEL% equ 0 (
    echo [OK] 已删除开机自启
)

:: 终止正在运行的 server.js
echo 正在关闭 WebTerm Pro 服务器...
taskkill /f /im node.exe /fi "WINDOWTITLE eq *server*" >nul 2>&1

:: 删除 start.vbs
set INSTALL_DIR=%~dp0
del "%INSTALL_DIR%start.vbs" >nul 2>&1

echo.
echo ============================================
echo  卸载完成！
echo.
echo  请在浏览器中：
echo  1. 打开 edge://apps 或 chrome://apps
echo  2. 找到 WebTerm Pro，右键选择"卸载"
echo ============================================
echo.
pause
```

- [ ] **Step 2: 验证脚本语法**

目视检查，确认无语法错误。

---

### Task 6: 更新 package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 追加 scripts 字段**

查看现有 `package.json`，追加 `start` 和 `generate-icons` 脚本：

```json
{
  "scripts": {
    "start": "node server.js",
    "generate-icons": "node generate-icons.js"
  }
}
```

注意：如果已有 `scripts` 字段，则合并进去；如果没有则新建。

- [ ] **Step 2: 验证**

```bash
cd "D:/Claude WorkSpace/Web Terminal"
npm start &
sleep 2
curl -s http://localhost:1982 | head -c 100
kill %1 2>/dev/null
```

---

### Task 7: 整体验证

- [ ] **Step 1: 验证服务器可直接启动**

```bash
cd "D:/Claude WorkSpace/Web Terminal"
node server.js &
SERVER_PID=$!
sleep 2

# 测试 HTML 服务
echo "=== Testing HTML ==="
curl -s -o /dev/null -w "%{http_code}" http://localhost:1982
echo ""

# 测试 manifest
echo "=== Testing manifest ==="
curl -s -o /dev/null -w "%{http_code}" http://localhost:1982/manifest.json
echo ""

# 测试图标
echo "=== Testing icons ==="
curl -s -o /dev/null -w "%{http_code}" http://localhost:1982/icons/icon-192x192.png
echo ""
curl -s -o /dev/null -w "%{http_code}" http://localhost:1982/icons/icon-512x512.png
echo ""

# 测试 404
echo "=== Testing 404 ==="
curl -s -o /dev/null -w "%{http_code}" http://localhost:1982/nonexistent
echo ""

kill $SERVER_PID 2>/dev/null
```

Expected: HTML → 200, manifest → 200, icons → 200, nonexistent → 404

- [ ] **Step 2: 清理**

可选：删除 `generate-icons.js`（用完即弃）：
```bash
rm "D:/Claude WorkSpace/Web Terminal/generate-icons.js"
```

图标和 sharp 依赖可以保留（图标需要持续使用，sharp 可能将来再用于图标更换）。
