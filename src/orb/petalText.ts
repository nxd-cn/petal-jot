import { firstLineTitle } from "../shared/noteText";

/** 与 `.petal-blade` 一致（96×118，尖朝上 / 朝花心） */
const BLADE_CX = 48;
const BLADE_CY = 59;

/** 文字沿半径外移，落在瓣面较宽区域 */
export const PETAL_TEXT_OUTSET = 22;
const TEXT_PAD = 8;
const FONT_SIZE = 12;
const LINE_HEIGHT = 14.4;
const MAX_LINES = 2;
const FONT = `700 ${FONT_SIZE}px "Avenir Next", "PingFang SC", "Segoe UI", sans-serif`;

/**
 * 扇形瓣轮廓采样点（blade 本地坐标，与 clip-path 一致）。
 */
const BLADE_POLY: ReadonlyArray<readonly [number, number]> = [
  [48, 4],
  [56, 17],
  [67, 34],
  [77, 54],
  [86, 75],
  [90, 96],
  [87, 105],
  [76, 112],
  [58, 116],
  [48, 116],
  [38, 116],
  [20, 112],
  [9, 105],
  [6, 96],
  [10, 75],
  [19, 54],
  [29, 34],
  [40, 17],
];

type Pt = { x: number; y: number };

let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  if (!measureCtx) {
    const canvas = document.createElement("canvas");
    measureCtx = canvas.getContext("2d");
  }
  if (measureCtx) measureCtx.font = FONT;
  return measureCtx;
}

/** 估算字符串像素宽。 */
export function measureTextWidth(text: string): number {
  const ctx = getMeasureCtx();
  if (ctx) return ctx.measureText(text).width;
  let w = 0;
  for (const ch of text) {
    w += /[\u0000-\u00ff]/.test(ch) ? FONT_SIZE * 0.56 : FONT_SIZE;
  }
  return w;
}

function rotateLocal(lx: number, ly: number, angleRad: number): Pt {
  const dx = lx - BLADE_CX;
  const dy = ly - BLADE_CY;
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

function rotatedPetalPoly(bladeRotateDeg: number): Pt[] {
  const rad = (bladeRotateDeg * Math.PI) / 180;
  return BLADE_POLY.map(([x, y]) => rotateLocal(x, y, rad));
}

/** 水平线与多边形求交，返回最长可用宽度。 */
function horizontalSpan(poly: Pt[], y: number): number {
  const xs: number[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    if (y < minY || y > maxY || a.y === b.y) continue;
    const t = (y - a.y) / (b.y - a.y);
    xs.push(a.x + t * (b.x - a.x));
  }
  if (xs.length < 2) return 0;
  xs.sort((p, q) => p - q);
  let best = 0;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    best = Math.max(best, xs[i + 1]! - xs[i]!);
  }
  return best;
}

/** 按花瓣朝向，取文字落点附近最窄水平宽度。 */
export function petalTextMaxWidth(angleDeg: number, lines = MAX_LINES): number {
  const bladeRotate = angleDeg - 90;
  const poly = rotatedPetalPoly(bladeRotate);
  const rad = (angleDeg * Math.PI) / 180;
  const cy = Math.sin(rad) * PETAL_TEXT_OUTSET;
  const half = (LINE_HEIGHT * Math.max(1, lines)) / 2;
  const samples = [cy - half * 0.7, cy, cy + half * 0.7];
  let minSpan = Infinity;
  for (const y of samples) {
    const span = horizontalSpan(poly, y);
    if (span > 0) minSpan = Math.min(minSpan, span);
  }
  if (!Number.isFinite(minSpan) || minSpan <= 0) {
    minSpan = 64;
  }
  return Math.max(36, Math.floor(minSpan - TEXT_PAD * 2));
}

function fitOneLine(text: string, maxWidth: number): string {
  if (measureTextWidth(text) <= maxWidth) return text;
  const ellipsis = "…";
  const ellipsisW = measureTextWidth(ellipsis);
  let lo = 0;
  let hi = text.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (measureTextWidth(text.slice(0, mid)) + ellipsisW <= maxWidth) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best > 0 ? `${text.slice(0, best)}${ellipsis}` : ellipsis;
}

function wrapToWidth(text: string, maxWidth: number, maxLines: number): string[] {
  if (maxLines <= 1) return [fitOneLine(text, maxWidth)];
  const lines: string[] = [];
  let rest = text;
  while (rest && lines.length < maxLines) {
    const last = lines.length === maxLines - 1;
    if (last) {
      lines.push(fitOneLine(rest, maxWidth));
      break;
    }
    let lo = 1;
    let hi = rest.length;
    let best = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (measureTextWidth(rest.slice(0, mid)) <= maxWidth) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    let cut = best;
    if (best < rest.length) {
      const window = rest.slice(0, best);
      const breakAt = Math.max(
        window.lastIndexOf(" "),
        window.lastIndexOf("，"),
        window.lastIndexOf("。"),
        window.lastIndexOf("、"),
        window.lastIndexOf(","),
        window.lastIndexOf("."),
      );
      if (breakAt >= Math.ceil(best * 0.45)) cut = breakAt + 1;
    }
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  return lines.filter(Boolean);
}

export type PetalTextLayout = {
  title: string;
  width: number;
  shiftX: number;
  shiftY: number;
  lineCount: number;
};

/** 按花瓣朝向计算偏移、可用宽度与截断/折行标题。 */
export function layoutPetalTitle(
  rawTitle: string,
  angleDeg: number,
  untitledLabel = "未命名便签",
): PetalTextLayout {
  const full = firstLineTitle(rawTitle) || untitledLabel;
  const width = petalTextMaxWidth(angleDeg, MAX_LINES);
  const rad = (angleDeg * Math.PI) / 180;
  const shiftX = Math.cos(rad) * PETAL_TEXT_OUTSET;
  const shiftY = Math.sin(rad) * PETAL_TEXT_OUTSET;

  if (measureTextWidth(full) <= width) {
    return { title: full, width, shiftX, shiftY, lineCount: 1 };
  }
  const lines = wrapToWidth(full, width, MAX_LINES);
  return {
    title: lines.join("\n"),
    width,
    shiftX,
    shiftY,
    lineCount: lines.length,
  };
}
