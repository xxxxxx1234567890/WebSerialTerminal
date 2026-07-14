# Design: Sidebar Swap, Enter Key Fix & Font Size Default

**Date**: 2026-07-14
**Project**: WebTerm Pro
**Scope**: Three independent changes to `WebSerialTerminal.html`

---

## Change 1: Swap Left/Right Sidebar Positions

### Current State

```
[Left Sidebar: Connection/Stats/Macros] [Terminal Area] [Right Sidebar: Toolbox]
```

- `.sidebar` (left, 220px, `border-right`) — connection status, data stats, quick macros
- `.right-sidebar` (right, variable width, `border-left`) — checksum calculator, float converter, ASCII table, TFTP, Modbus RTU tools
- Both have toggle buttons (`.sidebar-toggle` on left edge, `.right-sidebar-toggle` on right edge)
- Right sidebar has: hover-to-open behavior, resize handle on its left edge, lock-on-click toggle

### Target State

```
[Left Sidebar: Toolbox] [Terminal Area] [Right Sidebar: Connection/Stats/Macros]
```

### Implementation

#### HTML Changes

Wrap terminal content in a new `<div class="terminal-area">` so `.main` has exactly three flex children with predictable `order`:

```html
<div class="main">
  <div class="right-sidebar" id="rightSidebar">...</div>   <!-- order: 0 → left -->
  <div class="right-sidebar-toggle" ...>...</div>
  <div class="terminal-area">                               <!-- order: 1 → center -->
    <!-- toolbar, terminal output, input area, modbus freeze hint -->
  </div>
  <div class="sidebar" id="sidebar">...</div>               <!-- order: 2 → right -->
  <div class="sidebar-toggle" id="sidebarToggle">...</div>
</div>
```

The `.right-sidebar` HTML element moves to become the first child of `.main` (visually left).  
The `.sidebar` HTML element moves to become the last child of `.main` (visually right).  
The new `.terminal-area` wraps everything between them.

#### CSS Changes

| Rule | Change |
|------|--------|
| `.terminal-area` | `flex: 1; display: flex; flex-direction: column; overflow: hidden;` |
| `.sidebar` | `order: 2`; `border-right` → `border-left` |
| `.right-sidebar` | `order: 0`; `border-left` → `border-right` |
| `.sidebar-toggle` | Position from `left: 220px` → `right: 0` (dynamic based on open state); arrow: `◀` → `▶` / `▶` → `◀` |
| `.right-sidebar-toggle` | Position from `right: 0` → `left: 0` (dynamic); arrow direction reversed |
| `.right-sidebar-resize-handle` | `left: 0` → `right: 0` (now on the right edge of its parent, which is visually the right sidebar) |

#### JavaScript Changes

| Function | Change |
|----------|--------|
| `toggleSidebar()` | Toggle position now calculates `right` instead of `left` |
| `updateSidebarToggle()` | Update toggle `right` style and arrow direction |
| `toggleRightSidebar()` | Toggle position now calculates `left` instead of `right` |
| `updateRightSidebarToggle()` | New function: update toolbox toggle position on left edge |
| `initRightSidebarHover()` | Hover zone moves to left edge of terminal area |
| `startResize()` / `onResize()` | Resize calculation reverses: `width = ev.clientX - mainRect.left` instead of `mainRect.right - ev.clientX` |

---

## Change 2: Enter Key Not Sending Commands

### Root Cause

`handleInputKey` does not check `KeyboardEvent.isComposing`. When a Chinese (or other) IME is active, pressing Enter to confirm a composition candidate fires `keydown` with `isComposing: true`. The handler processes this as a send command, potentially sending incomplete input or conflicting with the IME.

### Fix

Add an IME guard at the top of `handleInputKey`:

```js
function handleInputKey(e) {
  if (e.isComposing) return;  // Skip IME composition events
  const field = document.getElementById('inputField');
  // ... rest unchanged
}
```

This is a one-line addition. The `isComposing` property is supported in all browsers that support Web Serial API (Chrome 89+, Edge 89+).

---

## Change 3: Default Terminal Font Size → 16px

### Current Default

`settings.fontSize` initializes to `13` (line 2264). The `<select id="fontSize">` has `13px` pre-selected (line 2196).

### Change

| Location | Line | Old | New |
|----------|------|-----|-----|
| Settings object default | ~2264 | `fontSize: 13` | `fontSize: 16` |
| Select option default | ~2196 | `<option value="13" selected>13px</option>` | `<option value="13">13px</option>` |
| Select option | ~2198 | `<option value="16">16px</option>` | `<option value="16" selected>16px</option>` |

Existing user preferences in `localStorage` are NOT affected — the default only applies to new users or after clearing storage.

---

## Testing

### Change 1 — Sidebar Swap
- [ ] Toolbox appears on the left, connection/stats/macros on the right
- [ ] Both sidebars toggle open/close correctly with arrow buttons in correct positions
- [ ] Right sidebar (macros) hover-to-open works from the right edge
- [ ] Toolbox sidebar hover-to-open works from the left edge
- [ ] Resize handle on the right sidebar (macros) works, drags to resize
- [ ] Toolbox tools (checksum, float, ASCII, TFTP, Modbus) all function correctly
- [ ] Terminal area fills remaining space between sidebars
- [ ] Settings modal, notifications unaffected

### Change 2 — Enter Key Fix
- [ ] Pressing Enter sends command when not using IME
- [ ] Pressing Enter during IME composition does NOT send
- [ ] After IME composition completes, pressing Enter sends normally
- [ ] ArrowUp/ArrowDown history navigation still works
- [ ] Ctrl+L clear, Ctrl+D disconnect still work

### Change 3 — Font Size Default
- [ ] Fresh load (no localStorage) shows terminal in 16px
- [ ] Settings modal shows 16px selected
- [ ] Changing font size in settings persists across reload
