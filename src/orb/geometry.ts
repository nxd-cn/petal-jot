import {
  FAN_RADIUS,
  PETAL_HEIGHT,
  PETAL_WIDTH,
} from "../shared/constants";

export type PetalPoint = {
  index: number;
  angleDeg: number;
  x: number;
  y: number;
};

export type FanLayout = {
  fanStartDeg: number;
  fanArcDeg: number;
  maxPetals: number;
  radius: number;
  /** 调试用：选中的展开朝向 */
  direction: string;
};

export type ScreenRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ScreenContext = {
  centerX: number;
  centerY: number;
  monitor: ScreenRect;
};

const SCREEN_PAD = 10;
const MIN_PETALS = 1;
/** 花瓣之间最大允许重叠比例（先收紧间距，不先拉远半径） */
const MAX_OVERLAP_RATIO = 0.3;

type Candidate = {
  direction: string;
  fanStartDeg: number;
  fanArcDeg: number;
  /** 该方向可用空间（逻辑像素） */
  space: number;
  /** 是否属于贴角象限方案 */
  corner: boolean;
};

/**
 * 计算扇形花瓣中心点（相对窗口左上角）。
 * 0° 为右，90° 为下，-90° 为上（屏幕坐标 y 向下）。
 */
export function computePetalPoints(
  count: number,
  fanStartDeg: number,
  fanArcDeg: number,
  cx: number,
  cy: number,
  radius = FAN_RADIUS,
): PetalPoint[] {
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, index) => {
    const angleDeg = fanStartDeg + (fanArcDeg * (index + 0.5)) / count;
    const rad = (angleDeg * Math.PI) / 180;
    return {
      index,
      angleDeg,
      x: cx + Math.cos(rad) * radius,
      y: cy + Math.sin(rad) * radius,
    };
  });
}

/** 展开态窗口边长（外接正方形）。 */
export function expandedWindowSize(radius = FAN_RADIUS): number {
  return Math.ceil(radius * 2 + Math.max(PETAL_WIDTH, PETAL_HEIGHT) + 24);
}

/** overlap 0=不重叠，0.3=中心距至少为瓣宽 70%。 */
function minPetalAngleDeg(radius: number, overlapRatio: number): number {
  const overlap = Math.min(MAX_OVERLAP_RATIO, Math.max(0, overlapRatio));
  const minCenterDist = PETAL_WIDTH * Math.max(0.2, 1 - overlap);
  const halfChord = minCenterDist / 2;
  const ratio = Math.min(0.95, halfChord / Math.max(radius, 1));
  return (2 * Math.asin(ratio) * 180) / Math.PI;
}

function petalsFitInMonitor(
  count: number,
  fanStartDeg: number,
  fanArcDeg: number,
  centerX: number,
  centerY: number,
  radius: number,
  monitor: ScreenRect,
): boolean {
  if (count <= 0) return true;
  const slackX = PETAL_WIDTH * MAX_OVERLAP_RATIO;
  const slackY = PETAL_HEIGHT * MAX_OVERLAP_RATIO;
  for (let index = 0; index < count; index += 1) {
    const angleDeg = fanStartDeg + (fanArcDeg * (index + 0.5)) / count;
    const rad = (angleDeg * Math.PI) / 180;
    const px = centerX + Math.cos(rad) * radius;
    const py = centerY + Math.sin(rad) * radius;
    if (
      px - PETAL_WIDTH / 2 + slackX < monitor.x + SCREEN_PAD ||
      px + PETAL_WIDTH / 2 - slackX > monitor.x + monitor.width - SCREEN_PAD ||
      py - PETAL_HEIGHT / 2 + slackY < monitor.y + SCREEN_PAD ||
      py + PETAL_HEIGHT / 2 - slackY > monitor.y + monitor.height - SCREEN_PAD
    ) {
      return false;
    }
  }
  return true;
}

/** 空间不够时允许最多 30% 重叠；仍放不下再减数量。 */
export function fitPetalCount(args: {
  desiredCount: number;
  fanStartDeg: number;
  fanArcDeg: number;
  centerX: number;
  centerY: number;
  radius: number;
  monitor: ScreenRect;
}): number {
  const desired = Math.max(MIN_PETALS, Math.floor(args.desiredCount));
  const overlapSteps = [0, 0.1, 0.2, 0.3, MAX_OVERLAP_RATIO];

  for (const overlap of overlapSteps) {
    const byAngle = Math.max(
      MIN_PETALS,
      Math.floor(args.fanArcDeg / minPetalAngleDeg(args.radius, overlap)),
    );
    if (
      byAngle >= desired &&
      petalsFitInMonitor(
        desired,
        args.fanStartDeg,
        args.fanArcDeg,
        args.centerX,
        args.centerY,
        args.radius,
        args.monitor,
      )
    ) {
      return desired;
    }
  }

  const byAngle = Math.max(
    MIN_PETALS,
    Math.floor(args.fanArcDeg / minPetalAngleDeg(args.radius, MAX_OVERLAP_RATIO)),
  );
  let count = Math.min(desired, byAngle);
  while (count > MIN_PETALS) {
    if (
      petalsFitInMonitor(
        count,
        args.fanStartDeg,
        args.fanArcDeg,
        args.centerX,
        args.centerY,
        args.radius,
        args.monitor,
      )
    ) {
      return count;
    }
    count -= 1;
  }
  return MIN_PETALS;
}

function buildCandidates(left: number, right: number, top: number, bottom: number): Candidate[] {
  return [
    { direction: "down", fanStartDeg: 0, fanArcDeg: 180, space: bottom, corner: false },
    { direction: "up", fanStartDeg: -180, fanArcDeg: 180, space: top, corner: false },
    { direction: "right", fanStartDeg: -90, fanArcDeg: 180, space: right, corner: false },
    { direction: "left", fanStartDeg: 90, fanArcDeg: 180, space: left, corner: false },
    {
      direction: "se",
      fanStartDeg: 0,
      fanArcDeg: 90,
      space: Math.min(right, bottom),
      corner: true,
    },
    {
      direction: "sw",
      fanStartDeg: 90,
      fanArcDeg: 90,
      space: Math.min(left, bottom),
      corner: true,
    },
    {
      direction: "ne",
      fanStartDeg: -90,
      fanArcDeg: 90,
      space: Math.min(right, top),
      corner: true,
    },
    {
      direction: "nw",
      fanStartDeg: -180,
      fanArcDeg: 90,
      space: Math.min(left, top),
      corner: true,
    },
  ];
}

/**
 * 按「空闲空间最大」选择展开方向：
 * - 顶部空间最小 → 选 down
 * - 左上角贴边 → 选 se（右下）
 * 再按能否放入屏幕裁剪花瓣数量。
 */
export function resolveAdaptiveFan(args: {
  centerX: number;
  centerY: number;
  monitor: ScreenRect;
  desiredCount: number;
}): FanLayout {
  const radius = FAN_RADIUS;
  const { centerX, centerY, monitor } = args;

  const left = Math.max(0, centerX - monitor.x);
  const right = Math.max(0, monitor.x + monitor.width - centerX);
  const top = Math.max(0, centerY - monitor.y);
  const bottom = Math.max(0, monitor.y + monitor.height - centerY);

  // 边缘判定阈值：至少要能放下花瓣半径，或屏幕短边 25%
  const reach = Math.max(
    radius + Math.max(PETAL_WIDTH, PETAL_HEIGHT) / 2 + 20,
    Math.min(monitor.width, monitor.height) * 0.25,
  );

  const nearLeft = left < reach;
  const nearRight = right < reach;
  const nearTop = top < reach;
  const nearBottom = bottom < reach;

  const candidates = buildCandidates(left, right, top, bottom);

  // 贴角优先：强制对应象限
  let forced: Candidate | undefined;
  if (nearTop && nearLeft) forced = candidates.find((c) => c.direction === "se");
  else if (nearTop && nearRight) forced = candidates.find((c) => c.direction === "sw");
  else if (nearBottom && nearLeft) forced = candidates.find((c) => c.direction === "ne");
  else if (nearBottom && nearRight) forced = candidates.find((c) => c.direction === "nw");
  else if (nearTop) forced = candidates.find((c) => c.direction === "down");
  else if (nearBottom) forced = candidates.find((c) => c.direction === "up");
  else if (nearLeft) forced = candidates.find((c) => c.direction === "right");
  else if (nearRight) forced = candidates.find((c) => c.direction === "left");

  // 非贴边时：选可用空间最大的半扇；贴边时用 forced，但仍用 space 校验
  const pool = forced
    ? [forced]
    : candidates.filter((c) => !c.corner).sort((a, b) => b.space - a.space);

  let bestLayout: FanLayout | null = null;

  for (const candidate of pool) {
    // 半扇放不下时，尝试收紧扇角
    const arcs =
      candidate.fanArcDeg >= 180
        ? [180, 135, 120, 90]
        : candidate.fanArcDeg >= 120
          ? [candidate.fanArcDeg, 90]
          : [candidate.fanArcDeg];

    for (const arc of arcs) {
      // 收紧扇角时保持扇区中线不变
      const mid = candidate.fanStartDeg + candidate.fanArcDeg / 2;
      const fanStartDeg = mid - arc / 2;
      const maxPetals = fitPetalCount({
        desiredCount: args.desiredCount,
        fanStartDeg,
        fanArcDeg: arc,
        centerX,
        centerY,
        radius,
        monitor,
      });
      const layout: FanLayout = {
        fanStartDeg,
        fanArcDeg: arc,
        maxPetals,
        radius,
        direction: candidate.direction,
      };
      if (!bestLayout || layout.maxPetals > bestLayout.maxPetals) {
        bestLayout = layout;
      }
      if (maxPetals >= args.desiredCount) {
        return layout;
      }
    }
  }

  // 兜底：在所有候选里挑能放下最多花瓣的
  if (!bestLayout || bestLayout.maxPetals < Math.min(3, args.desiredCount)) {
    for (const candidate of candidates.sort((a, b) => b.space - a.space)) {
      const mid = candidate.fanStartDeg + candidate.fanArcDeg / 2;
      for (const arc of [candidate.fanArcDeg, 90]) {
        const fanStartDeg = mid - arc / 2;
        const maxPetals = fitPetalCount({
          desiredCount: args.desiredCount,
          fanStartDeg,
          fanArcDeg: arc,
          centerX,
          centerY,
          radius,
          monitor,
        });
        const layout: FanLayout = {
          fanStartDeg,
          fanArcDeg: arc,
          maxPetals,
          radius,
          direction: candidate.direction,
        };
        if (!bestLayout || layout.maxPetals > bestLayout.maxPetals) {
          bestLayout = layout;
        }
      }
    }
  }

  return (
    bestLayout ?? {
      fanStartDeg: 0,
      fanArcDeg: 180,
      maxPetals: MIN_PETALS,
      radius,
      direction: "down",
    }
  );
}
