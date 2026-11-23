# AGENTS.md

PetalJot（花记）是 **macOS + Windows** 双端桌面应用（Tauri 2 + React）。  
**每次改动都必须兼顾两端**：不要只在本机（通常是 macOS）验证后就当作完成。

## 硬性要求

1. 任何 UI、交互、窗口、快捷键、托盘、透明/拖拽、焦点相关改动，默认视为跨平台任务。
2. 合并前用下面清单自检；无法在本机测 Windows 时，也要说明风险点与建议验证步骤。
3. 平台差异用 `#[cfg(...)]` / `html.os-windows` 等**局部**分流，保持另一端行为不变；禁止为修一端而破坏另一端。
4. 新增平台分支时写清原因（注释一行即可），方便后人对照。

## 前端（React / CSS）

| 场景 | 优先做法 | 原因 |
|------|----------|------|
| 点击 / 命中 | `pointerdown` / `pointerup` | Windows WebView2 上纯 `click`/`mousedown` 偶发丢失 |
| 透明窗外形 | SVG path；慎用 `filter` / `clip-path` | WebView2 透明窗易露方底、毛边 |
| 样式分流 | `html.os-windows`（见 `src/orb/main.tsx`） | 不影响 macOS 默认样式 |
| 可编辑区 | 交互面设 `app-region: no-drag`；空白区也要能聚焦 | 避免拖拽区吞点击；WebView2 focus 更挑 |
| 焦点 | `focus` 后确认 `activeElement`；失败则 `rAF` 再试 | WebView2 同步 focus 偶发无效 |
| 启动 / IPC | 先画默认 UI，再短重试 `invoke` | Windows 启动时 IPC 可能未就绪 |

参考实现：`src/orb/*`、`src/editor/NoteBodyEditor.tsx`、`src/editor/EditorApp.css`。

## 后端（Rust / Tauri）

| 场景 | 优先做法 | 原因 |
|------|----------|------|
| 建窗 | `WebviewWindowBuilder::build` 放在 **async** command | Windows 同步 build 会死锁 |
| 快捷键回调 | 延后到主线程再 `show` / 建窗 | Windows 钩子不在 UI 线程 |
| 修饰键 | Win 上 `Command`/`Cmd` 映射为 `Control` | 避免误绑 Win 键 |
| 透明球 | `platform.rs` 分平台清背景；Win 需 alpha=0 | 两端透明语义不同 |
| 置顶 / 焦点 | Win 上定位后可能需再确认 `set_always_on_top` / `set_focus` | 属性偶发丢失 |
| 标题栏 | macOS Overlay；其他平台默认装饰 | 见 `commands/windows.rs` |

## 改动自检（每次）

- [ ] 行为在 **macOS** 与 **Windows** 目标一致，或已有意分平台且互不影响
- [ ] 涉及点击/拖拽/焦点：用了 pointer 事件，可编辑区非 drag region
- [ ] 涉及透明窗/花瓣：未引入 Win 上易方底的 `filter`/`clip-path`（除非已有 `os-windows` 兜底）
- [ ] 涉及开窗/快捷键：async 建窗、线程与修饰键已考虑
- [ ] 无法实机验证的一端：在回复里写明「未测平台 + 建议手测项」

## 开发环境

- Node：`^20.19.0 || >=22.12.0`（Vite 7；可用 `.nvmrc`）
- 启动：`npm run tauri dev`；构建：`npm run tauri build`
