import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { NoteSummary } from "../shared/types";
import {
  DEFAULT_NOTE_COLOR,
  FAN_RADIUS,
  PETAL_HEIGHT,
  PETAL_WIDTH,
} from "../shared/constants";
import { displayNoteColor } from "../shared/noteColor";
import { computePetalPoints } from "./geometry";
import {
  PETAL_BLADE_HEIGHT,
  PETAL_BLADE_PATH,
  PETAL_BLADE_VIEWBOX,
  PETAL_BLADE_WIDTH,
} from "./petalPath";
import { layoutPetalTitle } from "./petalText";

type Props = {
  open: boolean;
  notes: NoteSummary[];
  cx: number;
  cy: number;
  fanStartDeg: number;
  fanArcDeg: number;
  radius?: number;
  /** 提醒到期时绕球旋转（普通展开不转） */
  spin?: boolean;
  /** 正在响铃的便签 id：强制显示 ⏰，旋转时放大一倍 */
  alertingIds?: string[];
  untitledLabel?: string;
  onSelect: (id: string) => void;
  /** 全部花瓣退场动画结束后回调（用于再收窗口） */
  onExitComplete?: () => void;
};

const ENTER_EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];
const EXIT_EASE: [number, number, number, number] = [0.4, 0, 0.2, 1];

/**
 * 花瓣展示：扇形瓣片外形不变。
 * 仅提醒到期 / 快捷键展开时绕球旋转（2 秒一圈）；悬停某片时暂停以便点选。
 */
export function PetalFan({
  open,
  notes,
  cx,
  cy,
  fanStartDeg,
  fanArcDeg,
  radius = FAN_RADIUS,
  spin = false,
  alertingIds = [],
  untitledLabel = "未命名便签",
  onSelect,
  onExitComplete,
}: Props) {
  const points = computePetalPoints(
    notes.length,
    fanStartDeg,
    fanArcDeg,
    cx,
    cy,
    radius,
  );
  const count = notes.length;
  const alertingSet = new Set(alertingIds);
  const wasOpenRef = useRef(false);
  /** 退场过程中仍保持旋转，直到花瓣卸完 */
  const [spinActive, setSpinActive] = useState(false);

  useEffect(() => {
    if (open && count > 0) {
      wasOpenRef.current = true;
      setSpinActive(spin);
      return;
    }
    if (wasOpenRef.current && count === 0) {
      wasOpenRef.current = false;
      setSpinActive(false);
      onExitComplete?.();
    }
  }, [open, count, onExitComplete, spin]);

  return (
    <div
      className={`petal-rotor${spinActive ? " is-spinning" : ""}`}
      style={{ left: cx, top: cy }}
      aria-hidden={!open}
    >
      <AnimatePresence
        onExitComplete={() => {
          wasOpenRef.current = false;
          setSpinActive(false);
          onExitComplete?.();
        }}
      >
        {open &&
          notes.map((note, index) => {
            const point = points[index];
            if (!point) return null;
            const fullTitle = note.title.trim() || untitledLabel;
            const text = layoutPetalTitle(
              fullTitle,
              point.angleDeg,
              untitledLabel,
            );
            // 相对球心的偏移，随 rotor 一起转
            const dx = point.x - cx;
            const dy = point.y - cy;
            const left = dx - PETAL_WIDTH / 2;
            const top = dy - PETAL_HEIGHT / 2;
            const color = displayNoteColor(note.color || DEFAULT_NOTE_COLOR);
            const bladeRotate = point.angleDeg - 90;
            const enterDelay = index * 0.04;
            const exitDelay = Math.max(0, count - index - 1) * 0.05;
            return (
              <motion.button
                key={note.id}
                type="button"
                className="petal"
                initial={{
                  opacity: 0,
                  scale: 0.45,
                  left: -PETAL_WIDTH / 2,
                  top: -PETAL_HEIGHT / 2,
                }}
                animate={{
                  opacity: 1,
                  scale: 1,
                  left,
                  top,
                  transition: {
                    duration: 0.4,
                    delay: enterDelay,
                    ease: ENTER_EASE,
                  },
                }}
                exit={{
                  opacity: 0,
                  scale: 0.4,
                  left: -PETAL_WIDTH / 2,
                  top: -PETAL_HEIGHT / 2,
                  transition: {
                    duration: 0.42,
                    delay: exitDelay,
                    ease: EXIT_EASE,
                  },
                }}
                style={{
                  left,
                  top,
                  zIndex: 10 + index,
                }}
                onPointerUp={(event) => {
                  // Windows 透明窗上 click 偶发丢失；用 pointerup 更稳，且避免与收起竞态
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(note.id);
                }}
                aria-label={fullTitle}
              >
                <span
                  className="petal-blade"
                  style={{ transform: `rotate(${bladeRotate}deg)` }}
                  aria-hidden
                >
                  {/* SVG path 比 CSS clip-path 在 Windows WebView2 上更稳，外形与 macOS 一致 */}
                  <svg
                    viewBox={PETAL_BLADE_VIEWBOX}
                    width={PETAL_BLADE_WIDTH}
                    height={PETAL_BLADE_HEIGHT}
                  >
                    <path d={PETAL_BLADE_PATH} fill={color} />
                  </svg>
                </span>
                {(() => {
                  const isAlerting = alertingSet.has(note.id);
                  const showBell = Boolean(note.hasReminder) || isAlerting;
                  const boom = spinActive && isAlerting;
                  return (
                    <span
                      className={`petal-content${showBell ? " has-reminder" : ""}`}
                      style={{
                        width: showBell
                          ? Math.min(text.width + (boom ? 28 : 16), 96)
                          : text.width,
                        transform: `translate(calc(-50% + ${text.shiftX}px), calc(-50% + ${text.shiftY}px))`,
                      }}
                    >
                      {showBell ? (
                        <span
                          className={`petal-reminder-mark${boom ? " is-alerting" : ""}`}
                          aria-hidden
                        >
                          ⏰
                        </span>
                      ) : null}
                      <span className="petal-title">{text.title}</span>
                    </span>
                  );
                })()}
              </motion.button>
            );
          })}
      </AnimatePresence>
    </div>
  );
}
