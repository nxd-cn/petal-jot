import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { listRecentNotes } from "../shared/api/notes";
import { getSettings } from "../shared/api/settings";
import {
  applyFanFrame,
  collapseFan,
  expandFan,
  openEditor,
  setOrbPosition,
  showOrbContextMenu,
  type FanLayoutDto,
} from "../shared/api/windows";
import {
  COLLAPSE_DELAY_MS,
  EVENTS,
  FAN_RADIUS,
  HOVER_EXPAND_DELAY_MS,
  ORB_IDLE_SIZE,
  PETAL_HEIGHT,
  PETAL_WIDTH,
} from "../shared/constants";
import { normalizeLocale, t } from "../shared/i18n";
import type { AppSettings, NoteSummary } from "../shared/types";
import { PetalFan } from "./PetalFan";
import { useHoverExpand } from "./useHoverExpand";
import "./OrbApp.css";

const DRAG_THRESHOLD = 4;

const DEFAULT_FAN: FanLayoutDto = {
  fanStartDeg: 0,
  fanArcDeg: 180,
  maxPetals: 8,
  radius: FAN_RADIUS,
  direction: "down",
  centerX: 0,
  centerY: 0,
  marginLeft: 0,
  marginRight: 0,
  marginTop: 0,
  marginBottom: 0,
  orbLocalX: ORB_IDLE_SIZE / 2,
  orbLocalY: ORB_IDLE_SIZE / 2,
  windowWidth: ORB_IDLE_SIZE,
  windowHeight: ORB_IDLE_SIZE,
  windowX: 0,
  windowY: 0,
};

/**
 * 桌面悬浮球：展开时窗口向空侧延伸，球屏幕坐标固定。
 */
export function OrbApp() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [fanLayout, setFanLayout] = useState<FanLayoutDto>(DEFAULT_FAN);
  /** 窗口仍保持展开尺寸（退场动画播完再收窗） */
  const [shellExpanded, setShellExpanded] = useState(false);
  /** 花瓣是否处于展开展示（收起时先关这个以播退场） */
  const [petalsOpen, setPetalsOpen] = useState(false);
  /** 提醒到期触发的展开：花瓣绕球旋转 */
  const [reminderSpin, setReminderSpin] = useState(false);
  /** 正在响铃的便签（旋转时强制显示放大 ⏰） */
  const [alertingNoteIds, setAlertingNoteIds] = useState<string[]>([]);
  const dragRef = useRef<{
    active: boolean;
    dragged: boolean;
    startedNativeDrag: boolean;
    startX: number;
    startY: number;
  } | null>(null);
  const expandedRef = useRef(false);
  const settingsRef = useRef<AppSettings | null>(null);
  const fanLayoutRef = useRef(fanLayout);
  const shellExpandedRef = useRef(shellExpanded);
  const reminderExpandRef = useRef(false);
  /** 到期/快捷键展开时要置顶展示的便签 id */
  const pendingPinIdsRef = useRef<string[]>([]);

  useEffect(() => {
    fanLayoutRef.current = fanLayout;
  }, [fanLayout]);

  useEffect(() => {
    shellExpandedRef.current = shellExpanded;
  }, [shellExpanded]);

  const prepareExpand = useCallback(async () => {
    const petalCount = settingsRef.current?.petalCount ?? 8;
    const pinIds = pendingPinIdsRef.current;
    pendingPinIdsRef.current = [];
    let desiredCount = petalCount;
    try {
      const recent = await listRecentNotes(petalCount, pinIds);
      flushSync(() => {
        setNotes(recent);
      });
      // 到期置顶可能让列表略多于设置瓣数
      desiredCount = Math.max(petalCount, recent.length);
    } catch {
      // ignore，仍按设置瓣数展开
    }
    try {
      const layout = await expandFan(desiredCount);
      // 先把球画到展开局部坐标，再改原生窗口，避免跳到大窗左上角
      flushSync(() => {
        setFanLayout(layout);
        setShellExpanded(true);
      });
      await applyFanFrame(layout);
    } catch {
      flushSync(() => {
        setFanLayout(DEFAULT_FAN);
        setShellExpanded(false);
      });
    }
  }, []);

  const { expanded, expandNow, onSafeEnter, onSafeLeave, collapseNow } =
    useHoverExpand({
      hoverDelayMs: HOVER_EXPAND_DELAY_MS,
      collapseDelayMs: COLLAPSE_DELAY_MS,
      // 不等待 settings：Windows 上 IPC 偶发偏慢时，否则整窗透明看不到圆球
      enabled: true,
      beforeExpand: prepareExpand,
    });

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const refreshNotes = useCallback(async (limit: number) => {
    try {
      const recent = await listRecentNotes(limit);
      setNotes(recent);
    } catch {
      // ignore
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      const next = await getSettings();
      setSettings(next);
      await refreshNotes(next.petalCount);
      return true;
    } catch {
      return false;
    }
  }, [refreshNotes]);

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      // Windows WebView2 启动时 invoke 可能尚未就绪；短重试，避免圆球永远空白
      for (let i = 0; i < 8; i += 1) {
        if (cancelled) return;
        if (await refreshSettings()) return;
        await new Promise((r) => setTimeout(r, 150 * (i + 1)));
      }
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, [refreshSettings]);

  useEffect(() => {
    const unsubs = [
      listen(EVENTS.notesChanged, () => {
        void refreshNotes(settings?.petalCount ?? 8);
      }),
      listen(EVENTS.settingsUpdated, () => {
        void refreshSettings();
      }),
      listen<string[]>(EVENTS.orbExpand, (event) => {
        const dueIds = (event.payload ?? []).filter(Boolean);
        pendingPinIdsRef.current = dueIds;
        reminderExpandRef.current = true;
        setAlertingNoteIds(dueIds);
        setReminderSpin(true);
        expandNow();
      }),
    ];
    return () => {
      void Promise.all(unsubs).then((fns) => fns.forEach((fn) => fn()));
    };
  }, [expandNow, refreshNotes, refreshSettings, settings?.petalCount]);

  // 展开后打开花瓣；收起时先退场，窗体等 onExitComplete 再缩回。
  useEffect(() => {
    if (expanded) {
      const fromReminder = reminderExpandRef.current;
      // 普通悬停/点击展开：不转；仅提醒链路保留旋转
      if (!fromReminder) {
        setReminderSpin(false);
        setAlertingNoteIds([]);
      }
      reminderExpandRef.current = false;
      setPetalsOpen(true);
      // 提醒展开时 prepareExpand 已按 pin 拉过列表，勿再无 pin 刷新盖掉到期便签
      if (!fromReminder) {
        void refreshNotes(settingsRef.current?.petalCount ?? 8);
      }
      return;
    }
    setPetalsOpen(false);
    setReminderSpin(false);
    setAlertingNoteIds([]);
  }, [expanded, refreshNotes]);

  const finishCollapseShell = useCallback(() => {
    if (expandedRef.current) return;
    void collapseFan()
      .then(() => {
        flushSync(() => {
          setShellExpanded(false);
          setFanLayout((prev) => ({
            ...DEFAULT_FAN,
            direction: prev.direction,
          }));
        });
      })
      .catch(() => {
        flushSync(() => {
          setShellExpanded(false);
        });
      });
  }, []);

  const persistOrbPosition = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      const pos = await win.outerPosition();
      const scale = await win.scaleFactor();
      const wx = pos.x / scale;
      const wy = pos.y / scale;
      // 展开态拖拽时窗口很大，要换算成球的收起态左上角再保存
      if (shellExpandedRef.current) {
        const layout = fanLayoutRef.current;
        const anchorX = wx + layout.orbLocalX - ORB_IDLE_SIZE / 2;
        const anchorY = wy + layout.orbLocalY - ORB_IDLE_SIZE / 2;
        await setOrbPosition(anchorX, anchorY);
        return;
      }
      await setOrbPosition(wx, wy);
    } catch {
      // ignore
    }
  }, []);

  const orbCx = shellExpanded ? fanLayout.orbLocalX : ORB_IDLE_SIZE / 2;
  const orbCy = shellExpanded ? fanLayout.orbLocalY : ORB_IDLE_SIZE / 2;
  const fanHitRadius =
    (fanLayout.radius || FAN_RADIUS) + Math.max(PETAL_WIDTH, PETAL_HEIGHT) / 2;

  const visibleNotes = useMemo(() => {
    const maxPetals = fanLayout.maxPetals || notes.length;
    return notes.slice(0, Math.max(maxPetals, 0));
  }, [fanLayout.maxPetals, notes]);

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    dragRef.current = {
      active: true,
      dragged: false,
      startedNativeDrag: false,
      startX: event.screenX,
      startY: event.screenY,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag?.active || drag.startedNativeDrag) return;
    const dx = event.screenX - drag.startX;
    const dy = event.screenY - drag.startY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

    drag.dragged = true;
    drag.startedNativeDrag = true;
    collapseNow();
    void getCurrentWindow()
      .startDragging()
      .catch(() => {
        // ignore
      });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag?.active) return;
    if (event.button !== 0) return;

    if (drag.dragged) {
      void persistOrbPosition();
      return;
    }

    event.preventDefault();
    if (expandedRef.current) {
      void openEditor({ mode: "create" }).then(() => collapseNow());
      return;
    }
    expandNow();
  };

  const onSelectNote = async (id: string) => {
    await openEditor({ mode: "edit", id });
    collapseNow();
  };

  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    collapseNow();
    void showOrbContextMenu();
  };

  // settings 未就绪时也先画出圆球（默认文案），避免 Windows 上整窗透明“看不见”
  const locale = normalizeLocale(settings?.locale ?? "zh");

  return (
    <div className="orb-root" onContextMenu={onContextMenu}>
      <div
        className="safe-zone"
        onPointerEnter={onSafeEnter}
        onPointerLeave={onSafeLeave}
      >
        {petalsOpen ? (
          <div
            className="fan-hit"
            aria-hidden
            style={{
              left: orbCx - fanHitRadius,
              top: orbCy - fanHitRadius,
              width: fanHitRadius * 2,
              height: fanHitRadius * 2,
            }}
          />
        ) : null}
        <PetalFan
          open={petalsOpen}
          notes={visibleNotes}
          cx={orbCx}
          cy={orbCy}
          fanStartDeg={fanLayout.fanStartDeg}
          fanArcDeg={fanLayout.fanArcDeg}
          radius={fanLayout.radius}
          spin={reminderSpin}
          alertingIds={alertingNoteIds}
          untitledLabel={t(locale, "untitled")}
          onExitComplete={finishCollapseShell}
          onSelect={(id) => {
            void onSelectNote(id);
          }}
        />
        <button
          type="button"
          className={`orb-button${shellExpanded ? " expanded" : ""}`}
          style={{
            left: orbCx - ORB_IDLE_SIZE / 2,
            top: orbCy - ORB_IDLE_SIZE / 2,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            const drag = dragRef.current;
            dragRef.current = null;
            if (drag?.dragged) {
              void persistOrbPosition();
            }
          }}
          aria-label={expanded ? t(locale, "newNote") : t(locale, "notes")}
        >
          {shellExpanded ? <span className="orb-plus" /> : <span className="orb-core" />}
        </button>
      </div>
    </div>
  );
}
