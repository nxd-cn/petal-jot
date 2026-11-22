import { DEFAULT_NOTE_COLOR, NOTE_COLOR_PRESETS } from "./constants";

/** 已知旧版 / 过饱和颜色 → 当前心情纸面色 */
const LEGACY_COLOR_MAP: Record<string, string> = {
  // 旧版饱和色
  "#14b8a6": "#d2dfdd",
  "#0d9488": "#d2dfdd",
  "#0f766e": "#d2dfdd",
  "#134e4a": "#d2dfdd",
  "#ccfbf1": "#d2dfdd",
  "#0ea5e9": "#d2dfdd",
  "#0284c7": "#d2dfdd",
  "#e0f2fe": "#d2dfdd",
  "#6366f1": "#ded6e1",
  "#4f46e5": "#ded6e1",
  "#e0e7ff": "#ded6e1",
  "#8b5cf6": "#ded6e1",
  "#7c3aed": "#ded6e1",
  "#f3e8ff": "#ded6e1",
  "#f43f5e": "#e8cdcf",
  "#e11d48": "#e8cdcf",
  "#ffe4e6": "#e8cdcf",
  "#f97316": "#e9d5c4",
  "#ea580c": "#e9d5c4",
  "#ffedd5": "#e9d5c4",
  "#f59e0b": "#f0e4bd",
  "#d97706": "#f0e4bd",
  "#fef3c7": "#f0e4bd",
  "#84cc16": "#d9e0cb",
  "#65a30d": "#d9e0cb",
  "#ecfccb": "#d9e0cb",
  "#64748b": "#dfdfdb",
  "#475569": "#dfdfdb",
  "#f1f5f9": "#dfdfdb",
  // 上一版洗白色板
  "#f4f4f5": "#dfdfdb",
  "#eaf6f3": "#d2dfdd",
  "#eaf3f9": "#d2dfdd",
  "#eef0f7": "#ded6e1",
  "#f3eef7": "#ded6e1",
  "#f7eef0": "#e8cdcf",
  "#f7f0e9": "#e9d5c4",
  "#f7f3e8": "#f0e4bd",
  "#f0f5ea": "#d9e0cb",
};

/** 强调色 → 纸面（若用户点选了 accent 或旧数据存了 accent） */
const ACCENT_TO_PAPER: Record<string, string> = Object.fromEntries(
  NOTE_COLOR_PRESETS.map((p) => [p.accent.toLowerCase(), p.value]),
);

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const raw = hex.trim().toLowerCase();
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(raw)) return null;
  const full =
    raw.length === 4
      ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
      : raw;
  const n = Number.parseInt(full.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** 相对亮度（0–1），用于判断是否过深。 */
function luminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * 展示用便签背景色：旧色 / 强调色映射为心情纸面；过深则冲淡到可读浅色。
 */
export function displayNoteColor(color?: string | null): string {
  const value = (color || DEFAULT_NOTE_COLOR).trim().toLowerCase();
  if (LEGACY_COLOR_MAP[value]) return LEGACY_COLOR_MAP[value];
  if (ACCENT_TO_PAPER[value]) return ACCENT_TO_PAPER[value];

  const preset = NOTE_COLOR_PRESETS.find((p) => p.value.toLowerCase() === value);
  if (preset) return preset.value;

  const rgb = parseHex(value);
  if (!rgb) return DEFAULT_NOTE_COLOR;

  if (luminance(rgb.r, rgb.g, rgb.b) >= 0.72) {
    return value;
  }

  // 参考 Jot：约 35% 原色 + 65% 暖白，保留色相区分度
  const mix = 0.35;
  const warm = { r: 255, g: 254, b: 246 };
  return toHex(
    rgb.r * mix + warm.r * (1 - mix),
    rgb.g * mix + warm.g * (1 - mix),
    rgb.b * mix + warm.b * (1 - mix),
  );
}

/** 纸面色对应的强调色（色板圆点色）；未知色则回落草稿灰。 */
export function noteAccentColor(color?: string | null): string {
  const paper = displayNoteColor(color).toLowerCase();
  const preset = NOTE_COLOR_PRESETS.find((p) => p.value.toLowerCase() === paper);
  if (preset) return preset.accent;

  const raw = (color || DEFAULT_NOTE_COLOR).trim().toLowerCase();
  const byAccent = NOTE_COLOR_PRESETS.find((p) => p.accent.toLowerCase() === raw);
  if (byAccent) return byAccent.accent;

  return NOTE_COLOR_PRESETS[0]?.accent ?? "#a3a4a9";
}
