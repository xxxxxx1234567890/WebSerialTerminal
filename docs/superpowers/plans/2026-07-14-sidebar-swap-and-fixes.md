# Sidebar Swap, Enter Key Fix & Font Size Default — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap left/right sidebar positions, fix Enter key not sending during IME composition, and change default terminal font size from 13px to 16px.

**Architecture:** Three independent changes to the single-file `WebSerialTerminal.html`. The sidebar swap reorders DOM children of `.main` and updates CSS positioning + JS toggle/resize/hover logic. The Enter fix adds one `isComposing` guard line. The font change updates two default values (JS settings object + HTML select). No new files, no dependency changes.

**Tech Stack:** HTML, CSS, vanilla JavaScript. No build system.

---

## File Structure

| File | What Changes | Responsibility |
|------|-------------|----------------|
| `WebSerialTerminal.html:1672–2162` | HTML reorder | Swap sidebar DOM order, add `.terminal-area` wrapper |
| `WebSerialTerminal.html:293–312` | CSS `.main`, `.terminal-area`, `.sidebar` | Flex order, border sides |
| `WebSerialTerminal.html:914–934` | CSS `.sidebar-toggle` | Toggle moved from left→right edge |
| `WebSerialTerminal.html:1000–1065` | CSS `.right-sidebar`, toggle, resize handle | Border sides, toggle left-edge, resize right-edge |
| `WebSerialTerminal.html:3475–3500` | JS `handleInputKey` | Add `isComposing` guard |
| `WebSerialTerminal.html:2262–2268` | JS `settings` object | `fontSize: 13` → `16` |
| `WebSerialTerminal.html:2191–2199` | HTML select options | `selected` on 16px |
| `WebSerialTerminal.html:2345–2416` | JS sidebar toggle/hover functions | Arrow directions, toggle positions |
| `WebSerialTerminal.html:3654–3715` | JS `toggleSidebar`, resize functions | `left`→`right`, resize calc reversal |

---

### Task 1: Reorder HTML — swap sidebar positions in `.main`

**Files:**
- Modify: `WebSerialTerminal.html:1672–2162`

- [ ] **Step 1: Move `.right-sidebar` + toggle to the top of `.main`, add `.terminal-area` wrapper, move `.sidebar` + toggle to the bottom**

The current structure is:

```
Line 1673: <div class="main">
Line 1676:   <div class="sidebar" id="sidebar">...</div>        ← LEFT sidebar (connection/stats/macros)
Line 1726:   <div class="sidebar-toggle" ...>◀</div>
Line 1729:   <div class="terminal-wrapper">...</div>           ← terminal output + input area
Line 1854:   <div class="right-sidebar" id="rightSidebar">...  ← RIGHT sidebar (toolbox)
Line 2160:   <div class="right-sidebar-toggle" ...>◀</div>
Line 2161:   <div id="mbCycleStatus" ...>...</div>
Line 2162: </div>  <!-- end .main -->
```

The new structure must be:

```
<div class="main">
  <!-- RIGHT SIDEBAR moved to first position (visually left) -->
  <div class="right-sidebar" id="rightSidebar">...</div>
  <div class="right-sidebar-toggle" id="rightSidebarToggle" onclick="toggleRightSidebar()" title="切换工具箱">▶</div>
  <!-- TERMINAL AREA wrapper -->
  <div class="terminal-area">
    <div class="terminal-wrapper">...</div>
    <div id="mbCycleStatus" style="display:none; font-size:9px; color:var(--amber); padding:4px 0; text-align:center;"><span class="pulse" style="display:inline-block; width:4px; height:4px; border-radius:50%; background:var(--amber); animation:mbPulse 1s infinite;"></span> 循环中: <span id="mbSidebarCycleCount">0</span></div>
  </div>
  <!-- LEFT SIDEBAR moved to last position (visually right) -->
  <div class="sidebar" id="sidebar">...</div>
  <div class="sidebar-toggle" id="sidebarToggle" onclick="toggleSidebar()">▶</div>
</div>
```

**Exact edit:** Find lines 1672–2162 in the file. Perform three block moves:

1. **Cut** lines 1854–2161 (`.right-sidebar` through `#mbCycleStatus`) — the entire right sidebar block
2. **Cut** lines 1676–1726 (`.sidebar` through `.sidebar-toggle`) — the entire left sidebar block
3. **Paste** right sidebar block first after `<div class="main">`
4. **Wrap** the remaining terminal content (`.terminal-wrapper` now at its original position) plus `#mbCycleStatus` in `<div class="terminal-area">...</div>`
5. **Paste** left sidebar block last before `</div>` (end of `.main`)

Also:
- Change `.sidebar-toggle` text: `◀` → `▶` (arrow points left to close → now on right edge, points left to close)
- Change `.right-sidebar-toggle` text: `◀` → `▶` (arrow points left to open → now on left edge, points right to open)

- [ ] **Step 2: Verify the resulting HTML has balanced tags**

Count `<div` and `</div>` occurrences in `.main` — should increase by exactly 2 (one for `<div class="terminal-area">` open, one for `</div>` close).

---

### Task 2: Update CSS for swapped sidebars

**Files:**
- Modify: `WebSerialTerminal.html` CSS sections

- [ ] **Step 1: Add `.terminal-area` CSS rule after `.main`**

After the `.main` rule block (after line 300), insert:

```css
/* Terminal area wrapper */
.terminal-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  order: 1;
}
```

- [ ] **Step 2: Update `.sidebar` CSS (lines 303–312)**

Replace:
```css
.sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.3s ease;
}
```

With:
```css
.sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.3s ease;
  order: 2;
}
```

- [ ] **Step 3: Update `.right-sidebar` CSS (lines 1000–1013)**

Replace:
```css
.right-sidebar {
  width: 0;
  flex-shrink: 0;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
  overflow: hidden;
  transition: width 0.3s ease;
  display: flex;
  flex-direction: column;
  position: relative;
  z-index: 5;
}
.right-sidebar.open,
.right-sidebar.hover-open { width: var(--right-sidebar-width); overflow-y: auto; }
```

With:
```css
.right-sidebar {
  width: 0;
  flex-shrink: 0;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  overflow: hidden;
  transition: width 0.3s ease;
  display: flex;
  flex-direction: column;
  position: relative;
  z-index: 5;
  order: 0;
}
.right-sidebar.open,
.right-sidebar.hover-open { width: var(--right-sidebar-width); overflow-y: auto; }
```

- [ ] **Step 4: Update `.sidebar-toggle` CSS (lines 914–934)**

Replace:
```css
.sidebar-toggle {
  position: absolute;
  left: 220px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px; height: 40px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-left: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: 10px;
  z-index: 5;
  transition: left 0.3s, color 0.2s;
  border-radius: 0 4px 4px 0;
}

.sidebar-toggle:hover { color: var(--accent); }
```

With:
```css
.sidebar-toggle {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 14px; height: 40px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-right: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: 10px;
  z-index: 5;
  transition: right 0.3s, color 0.2s;
  border-radius: 4px 0 0 4px;
}

.sidebar-toggle:hover { color: var(--accent); }
```

- [ ] **Step 5: Update `.right-sidebar-toggle` CSS (lines 1015–1035)**

Replace:
```css
.right-sidebar-toggle {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 14px; height: 40px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-right: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: 10px;
  z-index: 6;
  border-radius: 4px 0 0 4px;
  transition: right 0.3s, color 0.2s;
}
.right-sidebar-toggle.open { right: var(--right-sidebar-width); }
.right-sidebar-toggle:hover { color: var(--accent); }
```

With:
```css
.right-sidebar-toggle {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 14px; height: 40px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-left: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: 10px;
  z-index: 6;
  border-radius: 0 4px 4px 0;
  transition: left 0.3s, color 0.2s;
}
.right-sidebar-toggle.open { left: var(--right-sidebar-width); }
.right-sidebar-toggle:hover { color: var(--accent); }
```

- [ ] **Step 6: Update `.right-sidebar-resize-handle` CSS (lines 1038–1065)**

Replace:
```css
.right-sidebar-resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 6px;
  z-index: 7;
  cursor: col-resize;
  background: transparent;
}
```

With:
```css
.right-sidebar-resize-handle {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 6px;
  z-index: 7;
  cursor: col-resize;
  background: transparent;
}
```

And update `::before`:
```css
.right-sidebar-resize-handle::before {
  content: '';
  position: absolute;
  right: 2px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--border);
  transition: background 0.15s, box-shadow 0.15s;
}
```

(`left: 2px` → `right: 2px`)

---

### Task 3: Update JavaScript — toggle, hover, and resize functions

**Files:**
- Modify: `WebSerialTerminal.html` JS functions

- [ ] **Step 1: Update `updateSidebarToggle()` (lines 3660–3664)**

Replace:
```js
function updateSidebarToggle() {
  const toggle = document.getElementById('sidebarToggle');
  toggle.style.left = sidebarOpen ? '220px' : '0';
  toggle.textContent = sidebarOpen ? '◀' : '▶';
}
```

With:
```js
function updateSidebarToggle() {
  const toggle = document.getElementById('sidebarToggle');
  toggle.style.right = sidebarOpen ? '220px' : '0';
  toggle.textContent = sidebarOpen ? '▶' : '◀';
}
```

- [ ] **Step 2: Update `updateRightSidebarToggle()` (lines 2411–2416)**

Replace:
```js
function updateRightSidebarToggle() {
  const el = document.getElementById('rightSidebar');
  const toggle = document.getElementById('rightSidebarToggle');
  const isVisible = el.classList.contains('open') || el.classList.contains('hover-open');
  toggle.textContent = isVisible ? '▶' : '◀';
}
```

With:
```js
function updateRightSidebarToggle() {
  const el = document.getElementById('rightSidebar');
  const toggle = document.getElementById('rightSidebarToggle');
  const isVisible = el.classList.contains('open') || el.classList.contains('hover-open');
  toggle.textContent = isVisible ? '◀' : '▶';
}
```

(Arrow directions reversed: toolbox is now on left, so open → `◀` points left to close, closed → `▶` points right to open)

- [ ] **Step 3: Update `initRightSidebarHover()` hover zone position (lines 2361–2409)**

The hover zone is appended to `terminalWrapper`. After the swap, the toolbox (`.right-sidebar`) is on the **left**, so the hover zone must be on the **left** edge of the terminal area. Replace the hoverZone style:

Replace line 2367:
```js
hoverZone.style.cssText = 'position:absolute;right:0;top:0;bottom:0;width:15px;z-index:4;cursor:default;';
```

With:
```js
hoverZone.style.cssText = 'position:absolute;left:0;top:0;bottom:0;width:15px;z-index:4;cursor:default;';
```

Also update the `querySelector` target. The hover zone is appended to `document.querySelector('.terminal-wrapper')`. Since `.terminal-wrapper` is now inside `.terminal-area`, and `.terminal-area` is `position: relative` (via `.main`), the hover zone should be appended to `.terminal-area` instead:

Replace line 2363:
```js
const terminalWrapper = document.querySelector('.terminal-wrapper');
```

With:
```js
const terminalArea = document.querySelector('.terminal-area');
```

And line 2368:
```js
terminalWrapper.appendChild(hoverZone);
```

With:
```js
terminalArea.appendChild(hoverZone);
```

- [ ] **Step 4: Update `onResize()` calculation (lines 3690–3694)**

The toolbox (`.right-sidebar`) is now on the left. Its resize handle is on the right edge (`right: 0`). When dragging, width = distance from left edge of `.main` to cursor.

Replace lines 3690–3693:
```js
function onResize(ev) {
  const width = main.getBoundingClientRect().right - ev.clientX;
  const clamped = Math.round(Math.max(minWidth, Math.min(maxWidth, width)));
  document.documentElement.style.setProperty('--right-sidebar-width', clamped + 'px');
}
```

With:
```js
function onResize(ev) {
  const width = ev.clientX - main.getBoundingClientRect().left;
  const clamped = Math.round(Math.max(minWidth, Math.min(maxWidth, width)));
  document.documentElement.style.setProperty('--right-sidebar-width', clamped + 'px');
}
```

---

### Task 4: Fix Enter key — add IME composition guard

**Files:**
- Modify: `WebSerialTerminal.html:3475`

- [ ] **Step 1: Add `isComposing` guard to `handleInputKey`**

At line 3475, the function starts:
```js
function handleInputKey(e) {
  const field = document.getElementById('inputField');

  if (e.key === 'Enter') {
```

Insert the guard as the first line of the function body:

```js
function handleInputKey(e) {
  if (e.isComposing) return;
  const field = document.getElementById('inputField');

  if (e.key === 'Enter') {
```

The rest of the function (lines 3478–3500) remains unchanged.

- [ ] **Step 2: Verify no other keyboard handlers are affected**

The global `keydown` listener at line 4491 only handles `Ctrl+L` and `Ctrl+D` — it does not need the `isComposing` guard because `Ctrl` key combinations are never consumed by IME.

---

### Task 5: Change default font size to 16px

**Files:**
- Modify: `WebSerialTerminal.html:2264` (JS settings default)
- Modify: `WebSerialTerminal.html:2193–2199` (HTML select options)

- [ ] **Step 1: Update JS settings default (line 2264)**

Replace:
```js
fontSize: 13,
```

With:
```js
fontSize: 16,
```

- [ ] **Step 2: Update HTML select default (lines 2193–2199)**

Replace:
```html
<select class="form-control" id="fontSize" onchange="applySettings()">
  <option value="11">11px</option>
  <option value="12">12px</option>
  <option value="13" selected>13px</option>
  <option value="14">14px</option>
  <option value="16">16px</option>
</select>
```

With:
```html
<select class="form-control" id="fontSize" onchange="applySettings()">
  <option value="11">11px</option>
  <option value="12">12px</option>
  <option value="13">13px</option>
  <option value="14">14px</option>
  <option value="16" selected>16px</option>
</select>
```

---

### Task 6: Verification

- [ ] **Step 1: Open `WebSerialTerminal.html` in Chrome**

Launch a local server (e.g., `npx http-server` or use the existing `server.js` via `node server.js`) and open in Chrome:
```bash
node server.js
```
Then open `https://localhost:8443` (or whichever port is configured).

- [ ] **Step 2: Verify sidebar swap**
  - Toolbox (checksum, float, ASCII, TFTP, Modbus) appears on the LEFT
  - Connection status, stats, and macros appear on the RIGHT
  - Left toggle button (`▶`) opens the toolbox from the left edge
  - Right toggle button (`▶`) opens the macros sidebar from the right edge
  - Resize handle (between toolbox and terminal) drags correctly
  - Hovering the left edge of the terminal opens the toolbox
  - All toolbox tools function (checksum calculation, float conversion, etc.)

- [ ] **Step 3: Verify Enter key fix**
  - Type a command and press Enter — it should send (if connected)
  - If using Chinese IME, press Enter during composition — should NOT send
  - After IME composition completes, Enter sends normally
  - ArrowUp/ArrowDown navigate history
  - Ctrl+L clears terminal
  - Ctrl+D disconnects

- [ ] **Step 4: Verify font size default**
  - Clear localStorage: `localStorage.clear()` in DevTools, then reload
  - Terminal font should be 16px
  - Open Settings modal — 16px should be selected
  - Change to 13px, save, reload — 13px should persist (existing user preference respected)

---

### Task 7: Commit

- [ ] **Step 1: Commit all changes**

```bash
git add WebSerialTerminal.html docs/superpowers/specs/2026-07-14-sidebar-swap-and-fixes-design.md docs/superpowers/plans/2026-07-14-sidebar-swap-and-fixes.md
git commit -m "feat: swap sidebars, fix Enter key IME guard, default font 16px

- Swap left sidebar (connection/stats/macros) with right sidebar (toolbox)
- Add isComposing guard to handleInputKey for IME-safe Enter handling
- Change default terminal font size from 13px to 16px"
```
