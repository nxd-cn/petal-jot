# 花记（PetalJot）

基于 Tauri 2 + React 的跨平台（macOS / Windows）桌面花瓣便签。

## 功能（M1）

- 桌面悬浮球：拖拽、显隐、位置记忆
- 悬停 2 秒扇形展开最近便签（默认 8 瓣，可配置）
- 中心加号新建；点击花瓣打开编辑
- 文本编辑、图片插入、自动保存
- 系统托盘与全局快捷键新建

技术方案见 [docs/design.md](docs/design.md)。

## 开发

```bash
npm install
npm run tauri dev
```

## 构建

```bash
npm run tauri build
```
