import { invoke } from "@tauri-apps/api/core";
import type { EditorOpenPayload } from "../types";

/** 显示或隐藏悬浮球窗口。 */
export async function setOrbVisible(visible: boolean): Promise<void> {
  return invoke("orb_set_visible", { visible });
}

/** 持久化并应用悬浮球位置（仅收起态左上角）。 */
export async function setOrbPosition(x: number, y: number): Promise<void> {
  return invoke("orb_set_position", { x, y });
}

export type FanLayoutDto = {
  fanStartDeg: number;
  fanArcDeg: number;
  maxPetals: number;
  radius: number;
  direction: string;
  centerX: number;
  centerY: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  orbLocalX: number;
  orbLocalY: number;
  windowWidth: number;
  windowHeight: number;
  windowX: number;
  windowY: number;
};

/** 计算展开布局（不改窗口）。 */
export async function expandFan(desiredCount: number): Promise<FanLayoutDto> {
  return invoke<FanLayoutDto>("orb_expand_fan", { desiredCount });
}

/** 应用展开窗尺寸/位置（前端应已切到 orbLocal）。 */
export async function applyFanFrame(layout: FanLayoutDto): Promise<void> {
  return invoke("orb_apply_fan_frame", { layout });
}

/** 收起：恢复到锚点坐标。 */
export async function collapseFan(): Promise<void> {
  return invoke("orb_collapse_fan");
}

/** 打开或聚焦编辑器窗口。 */
export async function openEditor(payload: EditorOpenPayload): Promise<void> {
  return invoke("editor_open", { payload });
}

/** 打开设置窗口。 */
export async function openSettings(): Promise<void> {
  return invoke("settings_open");
}

/** 打开全屏居中搜索层。 */
export async function openSearch(): Promise<void> {
  return invoke("search_open");
}

/** 悬浮球右键弹出设置菜单。 */
export async function showOrbContextMenu(): Promise<void> {
  return invoke("orb_show_context_menu");
}

/** 在当前窗口弹出与托盘 / 悬浮球右键一致的菜单。 */
export async function showAppContextMenu(): Promise<void> {
  return invoke("app_show_context_menu");
}
