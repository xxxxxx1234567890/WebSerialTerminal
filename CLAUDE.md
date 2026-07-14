# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WebTerm Pro — a single-file web serial debug terminal (`WebSerialTerminal.html`). Uses the Web Serial API to communicate with serial port devices. All code (HTML, CSS, JS) is in one file. No build system, no dependencies, no package manager.

## How to Run

Open `WebSerialTerminal.html` in **Chrome 89+** or **Edge 89+** via `https://` or `localhost`. Web Serial API requires a secure context.

## Architecture

The entire application is a single ~2200-line HTML file:

- **CSS** (~990 lines): Dark cyberpunk theme with CSS custom properties, CRT scanline effects, ANSI color theme system (green/amber/cyan/white), responsive layout with collapsible sidebar
- **HTML** (~260 lines): Header, toolbar, sidebar (connection status, stats, macros), terminal output area, input area, status bar, settings modal
- **JavaScript** (~960 lines): All logic in one `<script>` block

### Key JS Modules (within the script)

| Area | Functions | Purpose |
|------|-----------|---------|
| Serial Connection | `connectPort()`, `disconnectPort()`, `readLoop()` | Web Serial API lifecycle |
| Send | `sendData()`, `sendInput()`, `sendFile()`, `handleFileSelect()` | Data transmission (ASCII/HEX) |
| Display | `appendLine()`, `clearTerminal()` | Terminal output rendering |
| ANSI/Highlight | `parseAnsiToFragment()`, `ansi256()`, `applyKeywordHighlight()` | Color parsing & syntax highlighting |
| UI | `updateUI()`, `updateCounters()`, `togglePause()`, `toggleSidebar()` | UI state management |
| Macros | `addMacro()`, `renderMacros()` | Quick-command system |
| Persistence | `saveState()`, `loadState()` | localStorage-based settings/macros/history |
| Settings | `openSettings()`, `closeSettings()`, `applySettings()` | Theme/font/buffer config |
| Utils | `formatBytes()`, `escapeHtml()`, `escapeJs()`, `sleep()` | Helpers |

### State Variables (global)

`port`, `reader`, `writer`, `isConnected`, `isPaused`, `rxBytes`, `txBytes`, `rxLines`, `errors`, `connectedAt`, `lineCount`, `inputHistory`, `historyIndex`, `macros`, `rxBuffer`, `sidebarOpen`, `readLoopRunning`, `settings`

### Key Patterns

- **Color themes**: Applied via dynamic `<style>` tag override (`#__themeOverride`) that rewrites CSS variable-driven rules
- **ANSI parsing**: `parseAnsiToFragment()` creates DocumentFragment with colored `<span>` elements for ANSI SGR sequences and keyword-based highlighting
- **Hex display**: Side-by-side hex bytes + ASCII representation with per-byte coloring
- **Disconnect safety**: Uses flag-first pattern (`isConnected = false`), then cancels reader, releases locks, closes port
- **Persistence**: `localStorage` with `wtp_` prefix for macros, settings, history, baud rate
