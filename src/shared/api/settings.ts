import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../types";

/** 读取完整应用设置。 */
export async function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("settings_get");
}

/** 部分更新设置并返回合并后的结果。 */
export async function setSettings(
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  return invoke<AppSettings>("settings_set", { patch });
}
