# Right Sidebar Auto-Hide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert right-sidebar toolbox from button-toggle to hover-based auto-show/hide with lock capability, remove toolbar button.

**Architecture:** Single-file HTML app. All CSS/HTML/JS changes in `WebSerialTerminal.html`. Add hover zone overlay on terminal-wrapper, three-state interaction (hidden/hover/locked).

**Tech Stack:** Vanilla HTML/CSS/JS, Web Serial API

---

### Task 1: CSS — Add hover-open class and hover zone styles

**Files:**
- Modify: `WebSerialTerminal.html` (CSS section, around line 998-1010)

**Changes needed:**
1. Add `.right-sidebar.hover-open` class alongside the existing `.open` (same properties)
2. Update `.right-sidebar-toggle` positioning to also respond to `.hover-open`

- [ ] **Update CSS for hover-open**

Find `.right-sidebar.open { width: 240px; overflow-y: auto; }` and add `.right-sidebar.hover-open`:

```css
.right-sidebar.open,
.right-sidebar.hover-open { width: 240px; overflow-y: auto; }
```

Find `.right-sidebar.open .right-sidebar-toggle { right: 240px; }` and update:

```css
.right-sidebar.open .right-sidebar-toggle,
.right-sidebar.hover-open .right-sidebar-toggle { right: 240px; }
```

---

### Task 2: HTML — Remove toolbar "工具箱" button

**Files:**
- Modify: `WebSerialTerminal.html` (HTML section, around line 1476-1481)

- [ ] **Remove the btnRightSidebar toolbar-group**

Delete:
```html
  <div class="toolbar-group">
    <button class="btn" id="btnRightSidebar" onclick="toggleRightSidebar()" title="切换工具箱">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
      工具箱
    </button>
  </div>
```

---

### Task 3: JS — Replace toggle logic with hover + lock state machine

**Files:**
- Modify: `WebSerialTerminal.html` (JS section, around line 1858-1861, 1941-1946)

**Changes needed:**
1. Replace `rightSidebarOpen` with `rightSidebarLocked` variable
2. Add `rightSidebarHoverTimer` variable
3. Replace `toggleRightSidebar()` with lock-aware version
4. Add hover event listener initialization

- [ ] **Replace state variable**

```javascript
// Right sidebar
let rightSidebarLocked = false;
let rightSidebarHoverTimer = null;
```

Delete the old `rightSidebarOpen = false;` line.

- [ ] **Replace toggleRightSidebar() function**

```javascript
function toggleRightSidebar() {
  const el = document.getElementById('rightSidebar');
  if (rightSidebarLocked) {
    // Locked → unlock and close
    rightSidebarLocked = false;
    el.classList.remove('open');
  } else {
    // Not locked → lock open
    rightSidebarLocked = true;
    el.classList.remove('hover-open');
    el.classList.add('open');
  }
  updateRightSidebarToggle();
}
```

- [ ] **Add hover initialization and update toggle function**

In `DOMContentLoaded`, add initialization:

```javascript
initRightSidebarHover();
```

Add these helper functions:

```javascript
function initRightSidebarHover() {
  const rightSidebar = document.getElementById('rightSidebar');
  const terminalWrapper = document.querySelector('.terminal-wrapper');
  
  // Create hover trigger zone at right edge of terminal
  const hoverZone = document.createElement('div');
  hoverZone.style.cssText = 'position:absolute;right:0;top:0;bottom:0;width:15px;z-index:4;cursor:default;';
  terminalWrapper.appendChild(hoverZone);
  
  // Hover zone entry → show sidebar
  hoverZone.addEventListener('mouseenter', () => {
    if (rightSidebarLocked) return;
    clearTimeout(rightSidebarHoverTimer);
    rightSidebar.classList.add('hover-open');
    updateRightSidebarToggle();
  });
  
  // Sidebar entry → cancel hide timer
  rightSidebar.addEventListener('mouseenter', () => {
    clearTimeout(rightSidebarHoverTimer);
  });
  
  // Sidebar leave → delay hide
  rightSidebar.addEventListener('mouseleave', (e) => {
    if (rightSidebarLocked) return;
    rightSidebarHoverTimer = setTimeout(() => {
      rightSidebar.classList.remove('hover-open');
      updateRightSidebarToggle();
    }, 300);
  });
  
  // Toggle button also triggers hover show
  const toggle = document.getElementById('rightSidebarToggle');
  toggle.addEventListener('mouseenter', () => {
    if (rightSidebarLocked) return;
    clearTimeout(rightSidebarHoverTimer);
    rightSidebar.classList.add('hover-open');
    updateRightSidebarToggle();
  });
}

function updateRightSidebarToggle() {
  const el = document.getElementById('rightSidebar');
  const toggle = document.getElementById('rightSidebarToggle');
  const isVisible = el.classList.contains('open') || el.classList.contains('hover-open');
  toggle.textContent = isVisible ? '▶' : '◀';
}
```

- [ ] **Also update toggle text in existing toggleRightSidebar**

The existing `toggleRightSidebar` function used to set the toggle text directly — now `updateRightSidebarToggle()` handles that.

- [ ] **Verify no other references to `rightSidebarOpen`**

Search the file to ensure there are no remaining references to the old `rightSidebarOpen` variable.
