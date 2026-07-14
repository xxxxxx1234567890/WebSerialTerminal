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
