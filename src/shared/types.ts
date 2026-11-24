/** 完整便签实体，对应 SQLite notes 表。 */
export type Note = {
  id: string;
  title: string;
  body: string;
  color: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

/** 花瓣 / 侧栏展示用摘要。 */
export type NoteSummary = {
  id: string;
  title: string;
  excerpt: string;
  color: string;
  updatedAt: number;
  pinned: boolean;
  sortOrder?: number;
  /** 正文含未到期闹钟时，花瓣上显示标记（过期不显示） */
  hasReminder?: boolean;
};

/** 应用设置，跨端持久化。 */
export type AppSettings = {
  petalCount: number;
  orbVisible: boolean;
  orbX: number;
  orbY: number;
  hotkeyNew: string;
  hotkeyOrb: string;
  /** zh | en */
  locale: string;
  /** 开机 / 登录后自动启动；缺省视为开启 */
  openAtLogin?: boolean;
};

export type EditorOpenPayload = {
  mode: "create" | "edit";
  id?: string;
};

export type UpsertNoteInput = {
  id?: string | null;
  title: string;
  body: string;
  color?: string | null;
  pinned?: boolean;
};
