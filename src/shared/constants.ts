export const ORB_IDLE_SIZE = 56;
export const PETAL_WIDTH = 104;
export const PETAL_HEIGHT = 112;
/** 花瓣中心到球心默认距离（实际半径由 Rust：零重叠紧挨 / 环绕或扇形） */
export const FAN_RADIUS = ORB_IDLE_SIZE / 2 + 14 + PETAL_HEIGHT / 2;

export const DEFAULT_PETAL_COUNT = 8;
export const MIN_PETAL_COUNT = 4;
export const MAX_PETAL_COUNT = 12;

/** 悬停展开 / 收起延迟（不再开放配置） */
export const HOVER_EXPAND_DELAY_MS = 2000;
export const COLLAPSE_DELAY_MS = 450;

/** 便签默认草稿灰背景（与心情色板一致） */
export const DEFAULT_NOTE_COLOR = "#dfdfdb";

/**
 * 心情色板：参考 Jot 随记的念头配色。
 * value = 便签纸面；accent = 色点强调色（饱和度更高，便于区分）。
 */
export const NOTE_COLOR_PRESETS = [
  { id: "draft", label: "草稿", value: "#dfdfdb", accent: "#a3a4a9" },
  { id: "inspire", label: "灵感", value: "#f0e4bd", accent: "#d4b554" },
  { id: "work", label: "工作", value: "#e9d5c4", accent: "#c18a66" },
  { id: "daily", label: "日常", value: "#e8cdcf", accent: "#bc7186" },
  { id: "read", label: "阅读", value: "#ded6e1", accent: "#a28bbb" },
  { id: "musing", label: "随想", value: "#d2dfdd", accent: "#7ea5af" },
  { id: "life", label: "生活", value: "#d9e0cb", accent: "#91a77a" },
  { id: "peach", label: "暖意", value: "#f0d5cb", accent: "#d48a7a" },
] as const;

export const EVENTS = {
  notesChanged: "notes://changed",
  orbVisibility: "orb://visibility",
  editorOpen: "editor://open",
  settingsUpdated: "settings://updated",
  /** 提醒到期：圆球应展开花瓣（payload: note id[]） */
  orbExpand: "orb://expand",
} as const;
