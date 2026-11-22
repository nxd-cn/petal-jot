import { invoke } from "@tauri-apps/api/core";
import type { Note, NoteSummary, UpsertNoteInput } from "../types";

/** 花瓣摘要；`pinIds` 会置顶纳入（到期闹钟便签，不限原排序位置）。 */
export async function listRecentNotes(
  limit: number,
  pinIds?: string[],
): Promise<NoteSummary[]> {
  return invoke<NoteSummary[]>("notes_list_recent", {
    limit,
    pinIds: pinIds?.length ? pinIds : null,
  });
}

/** 拉取主界面侧栏便签列表。 */
export async function listNotes(limit = 200): Promise<NoteSummary[]> {
  return invoke<NoteSummary[]>("notes_list", { limit });
}

/** 按关键词搜索便签标题与正文。 */
export async function searchNotes(query: string, limit = 50): Promise<NoteSummary[]> {
  return invoke<NoteSummary[]>("notes_search", { query, limit });
}

/** 按 id 读取完整便签。 */
export async function getNote(id: string): Promise<Note> {
  return invoke<Note>("notes_get", { id });
}

/** 新建或更新便签，返回落库后的实体。 */
export async function upsertNote(input: UpsertNoteInput): Promise<Note> {
  return invoke<Note>("notes_upsert", { input });
}

/** 软删除便签。 */
export async function softDeleteNote(id: string): Promise<void> {
  return invoke("notes_soft_delete", { id });
}

/** 清理空白未命名便签。 */
export async function purgeEmptyNotes(): Promise<number> {
  return invoke<number>("notes_purge_empty");
}

/** 复用或创建唯一空白草稿。 */
export async function findOrCreateDraft(): Promise<Note> {
  return invoke<Note>("notes_find_or_create_draft");
}

/** 按 id 顺序保存侧栏固定排序。 */
export async function reorderNotes(ids: string[]): Promise<void> {
  return invoke("notes_reorder", { ids });
}
