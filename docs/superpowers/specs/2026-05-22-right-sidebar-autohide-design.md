# WebTerm Pro — 右侧工具箱自动隐藏设计文档

## 概述

将右侧工具箱从按钮切换修改为悬停自动显示/隐藏，移除工具栏中的"工具箱"按钮，保留边缘按钮作为交互入口。

## 交互设计

### 三种状态

```
隐藏 (默认) ── mouseenter ──→ 显示
显示 ── mouseleave(300ms) ──→ 隐藏
显示 ── 点击边缘按钮 ──→ 锁定打开
锁定打开 ── 点击边缘按钮 ──→ 隐藏 (恢复悬停模式)
```

- **隐藏**: 默认状态，右侧栏宽度 0，仅边缘切换按钮可见
- **显示**: 鼠标进入触发区域，侧栏滑出 (240px)
- **锁定打开**: 点击边缘按钮后锁定，悬停不再关闭；再次点击回到隐藏态

### 触发区域

- 右侧边缘 15px 宽的透明热区 (hover zone)
- 边缘切换按钮本身
- 展开后的整个侧栏面板

### 防闪烁

- 鼠标离开侧栏 300ms 后才执行隐藏，避免鼠标短时划过边缘触发

## CSS 变更

### 新增

- `.right-sidebar`: 保持现有 `width: 0` + `transition: width 0.3s ease`
- `.right-sidebar.hover-open` (新增): 同现有 `.open` 的行为，但由悬停控制
- `.right-sidebar.open`: 保留，表示手动锁定打开

### 修改

- `.right-sidebar-toggle`: 保留，作为悬停和点击的双重入口

### 删除

- 工具栏中 `#btnRightSidebar` 所在的 `.toolbar-group`（"工具箱"按钮）

## JS 变更

### 新增变量

- `rightSidebarLocked` (boolean): 是否处于锁定打开状态
- `rightSidebarHoverTimer` (number): 隐藏延迟 timer ID

### 新增函数/逻辑

- 右侧边缘区域 `mouseenter` → 如果未锁定，打开侧栏 (添加 hover-open class)
- 右侧侧栏 `mouseleave` → 设置 300ms 延迟后关闭侧栏
- 右侧侧栏 `mouseenter` → 取消延迟 timer
- `toggleRightSidebar()` 修改: 点击边缘按钮时切换 `rightSidebarLocked` 状态
  - 未锁定 → 锁定打开 (open class, 移除 hover-open)
  - 锁定 → 关闭 (移除 open class)

### 修改函数

- `toggleRightSidebar()`: 增加锁定状态切换逻辑
- 删除 `btnRightSidebar` 相关的 toolbar HTML 和事件

### 删除

- `btnRightSidebar` 按钮及其所在的 toolbar-group

## HTML 变更

- 删除 `<div class="toolbar-group">` 中包含 `#btnRightSidebar` 的部分
- 保留 `right-sidebar-toggle` 边缘按钮

## 文件变更清单

| 文件 | 变更类型 |
|------|---------|
| `WebSerialTerminal.html` | CSS 新增 `.right-sidebar.hover-open` |
| | CSS 删除 `.right-sidebar-toggle` 中 `right: 0` 相关的 `.open` 状态定位逻辑 |
| | HTML 删除工具栏中 `#btnRightSidebar` |
| | JS 新增 `rightSidebarLocked`/`rightSidebarHoverTimer` 变量 |
| | JS 新增 hover 事件监听 |
| | JS 修改 `toggleRightSidebar()` 逻辑 |
| | JS 修改 `updateUI()` / 初始化逻辑 |
