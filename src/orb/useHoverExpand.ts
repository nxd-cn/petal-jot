import { useCallback, useEffect, useRef, useState } from "react";

type Options = {
  hoverDelayMs: number;
  collapseDelayMs: number;
  enabled?: boolean;
  /** 展开前准备（如贴边计算），完成后再真正展开 */
  beforeExpand?: () => void | Promise<void>;
};

/**
 * 悬停满 delay / 主动展开后显示花瓣，离开 SafeZone 经防抖后收起。
 */
export function useHoverExpand({
  hoverDelayMs,
  collapseDelayMs,
  enabled = true,
  beforeExpand,
}: Options) {
  const [expanded, setExpanded] = useState(false);
  const hoverTimer = useRef<number | null>(null);
  const collapseTimer = useRef<number | null>(null);
  const beforeExpandRef = useRef(beforeExpand);
  const expandingRef = useRef(false);

  useEffect(() => {
    beforeExpandRef.current = beforeExpand;
  }, [beforeExpand]);

  const clearHover = useCallback(() => {
    if (hoverTimer.current != null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  const clearCollapse = useCallback(() => {
    if (collapseTimer.current != null) {
      window.clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
  }, []);

  const runExpand = useCallback(async () => {
    if (!enabled || expandingRef.current) return;
    expandingRef.current = true;
    try {
      clearHover();
      clearCollapse();
      await beforeExpandRef.current?.();
      setExpanded(true);
    } finally {
      expandingRef.current = false;
    }
  }, [clearCollapse, clearHover, enabled]);

  const expandNow = useCallback(() => {
    void runExpand();
  }, [runExpand]);

  const onSafeEnter = useCallback(() => {
    if (!enabled) return;
    clearCollapse();
    if (expanded || expandingRef.current) return;
    clearHover();
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      void runExpand();
    }, hoverDelayMs);
  }, [clearCollapse, clearHover, enabled, expanded, hoverDelayMs, runExpand]);

  const onSafeLeave = useCallback(() => {
    clearHover();
    if (!expanded) return;
    clearCollapse();
    collapseTimer.current = window.setTimeout(() => {
      setExpanded(false);
      collapseTimer.current = null;
    }, collapseDelayMs);
  }, [clearCollapse, clearHover, collapseDelayMs, expanded]);

  const collapseNow = useCallback(() => {
    clearHover();
    clearCollapse();
    setExpanded(false);
  }, [clearCollapse, clearHover]);

  useEffect(
    () => () => {
      clearHover();
      clearCollapse();
    },
    [clearCollapse, clearHover],
  );

  useEffect(() => {
    if (!enabled) {
      clearHover();
      clearCollapse();
      setExpanded(false);
    }
  }, [clearCollapse, clearHover, enabled]);

  return { expanded, expandNow, onSafeEnter, onSafeLeave, collapseNow };
}
