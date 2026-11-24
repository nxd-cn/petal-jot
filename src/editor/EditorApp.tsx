import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  findOrCreateDraft,
  getNote,
  listNotes,
  purgeEmptyNotes,
  reorderNotes,
  softDeleteNote,
  upsertNote,
} from "../shared/api/notes";
import { getSettings } from "../shared/api/settings";
import { openSearch, showAppContextMenu } from "../shared/api/windows";
import { DEFAULT_NOTE_COLOR, EVENTS, NOTE_COLOR_PRESETS } from "../shared/constants";
import { DEFAULT_LOCALE, normalizeLocale, t, type Locale } from "../shared/i18n";
import { displayNoteColor, noteAccentColor } from "../shared/noteColor";
import { displayTitle, firstLineTitle } from "../shared/noteText";
import { isBlankBodyLines } from "../shared/todoText";
import type { EditorOpenPayload, NoteSummary } from "../shared/types";
import { NoteBodyEditor, type NoteBodyEditorHandle } from "./NoteBodyEditor";
import "./EditorApp.css";

type Pending = {
  body: string;
  color: string;
};

const SIDEBAR_WIDTH = 220;
const EDITOR_COMPACT = { width: 480, height: 640 };
const EDITOR_WIDE = { width: 760, height: 640 };
/** 超过该位移才进入拖拽，避免误触、点击仍可打开。 */
const DRAG_THRESHOLD_PX = 4;
const LIST_AUTO_SCROLL_EDGE = 36;
const LIST_AUTO_SCROLL_SPEED = 14;

function isBlankBody(body: string): boolean {
  return isBlankBodyLines(body);
}

function isVisibleNote(note: NoteSummary, activeId: string | null): boolean {
  return (
    note.id === activeId ||
    note.title.trim().length > 0 ||
    note.excerpt.trim().length > 0
  );
}

type DropTarget =
  | { kind: "before"; id: string }
  | { kind: "after"; id: string };

/** 按目标把 fromId 挪到 before/after，返回新数组；无变化时返回原引用。 */
function moveNoteToTarget(
  list: NoteSummary[],
  fromId: string,
  target: DropTarget,
): NoteSummary[] {
  if (target.id === fromId) return list;
  const from = list.findIndex((note) => note.id === fromId);
  if (from < 0) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  if (!moved) return list;
  const to = next.findIndex((note) => note.id === target.id);
  if (to < 0) return list;
  const insertAt = target.kind === "before" ? to : to + 1;
  next.splice(insertAt, 0, moved);
  const unchanged = next.every((note, index) => note.id === list[index]?.id);
  return unchanged ? list : next;
}

/** 按指针 Y 与各行中线比较，决定插到某行前或最后一行后。 */
function dropTargetFromClientY(clientY: number): DropTarget | null {
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".note-list [data-note-id]"));
  if (rows.length === 0) return null;
  for (const row of rows) {
    const id = row.dataset.noteId;
    if (!id) continue;
    const rect = row.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      return { kind: "before", id };
    }
  }
  const lastId = rows[rows.length - 1]?.dataset.noteId;
  return lastId ? { kind: "after", id: lastId } : null;
}

async function applyChromeColor(hex: string) {
  const color = displayNoteColor(hex);
  try {
    await Promise.all([
      getCurrentWindow().setBackgroundColor(color),
      getCurrentWebview().setBackgroundColor(color),
    ]);
  } catch {
    // ignore
  }
}

/**
 * 便签编辑器：顶部色板 + 可展开左侧列表 / 右侧正文。
 */
export function EditorApp() {
  const [body, setBody] = useState("");
  const [color, setColor] = useState(DEFAULT_NOTE_COLOR);
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  const [status, setStatus] = useState(() => t(DEFAULT_LOCALE, "statusReady"));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const pendingRef = useRef<Pending>({
    body: "",
    color: DEFAULT_NOTE_COLOR,
  });
  const noteIdRef = useRef<string | null>(null);
  const notesRef = useRef<NoteSummary[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const draggingIdRef = useRef<string | null>(null);
  const dragMovedRef = useRef(false);
  const dragActiveRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const reorderBusyRef = useRef(false);
  const bodyEditorRef = useRef<NoteBodyEditorHandle | null>(null);
  const [boldActive, setBoldActive] = useState(false);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  useEffect(() => {
    const syncBold = () => {
      setBoldActive(bodyEditorRef.current?.isBoldActive() ?? false);
    };
    document.addEventListener("selectionchange", syncBold);
    return () => document.removeEventListener("selectionchange", syncBold);
  }, []);

  const refreshList = useCallback(async () => {
    try {
      const list = await listNotes(200);
      setNotes(list);
    } catch {
      // ignore
    }
  }, []);

  const discardIfBlank = useCallback(async (id: string | null) => {
    if (!id) return false;
    if (!isBlankBody(pendingRef.current.body)) return false;
    try {
      await softDeleteNote(id);
      if (noteIdRef.current === id) {
        noteIdRef.current = null;
        setActiveId(null);
      }
      await invoke("emit_notes_changed");
      return true;
    } catch {
      return false;
    }
  }, []);

  const flushSave = useCallback(async () => {
    const id = noteIdRef.current;
    if (!id) return;
    const payload = pendingRef.current;
    // 空白草稿不反复 upsert，避免堆「未命名」
    if (isBlankBody(payload.body)) {
      setStatus(t(locale, "statusDraft"));
      return;
    }
    setStatus(t(locale, "statusSaving"));
    try {
      await upsertNote({
        id,
        title: firstLineTitle(payload.body),
        body: payload.body,
        color: payload.color,
      });
      setStatus(t(locale, "statusSaved"));
      await invoke("emit_notes_changed");
      await refreshList();
    } catch {
      setStatus(t(locale, "statusSaveFailed"));
    }
  }, [locale, refreshList]);

  const scheduleSave = useCallback(
    (next: Pending) => {
      pendingRef.current = next;
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void flushSave();
      }, 500);
    },
    [flushSave],
  );

  const setNoteColor = useCallback(
    (nextColor: string) => {
      const pastel = displayNoteColor(nextColor);
      setColor(pastel);
      void applyChromeColor(pastel);
      scheduleSave({ body: pendingRef.current.body, color: pastel });
    },
    [scheduleSave],
  );

  const applyNoteState = useCallback((id: string, nextBody: string, nextColor: string) => {
    noteIdRef.current = id;
    setActiveId(id);
    setBody(nextBody);
    setColor(nextColor);
    pendingRef.current = { body: nextBody, color: nextColor };
    void applyChromeColor(nextColor);
  }, []);

  const loadNote = useCallback(
    async (payload: EditorOpenPayload) => {
      try {
        if (saveTimer.current != null) {
          window.clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
        const prevId = noteIdRef.current;
        if (prevId && isBlankBody(pendingRef.current.body)) {
          await discardIfBlank(prevId);
        } else {
          await flushSave();
        }

        if (payload.mode === "edit" && payload.id) {
          const existing = await getNote(payload.id);
          const nextColor = displayNoteColor(existing.color || DEFAULT_NOTE_COLOR);
          applyNoteState(existing.id, existing.body, nextColor);
          setStatus(t(locale, "statusSaved"));
          await refreshList();
          return;
        }

        const draft = await findOrCreateDraft();
        const nextColor = displayNoteColor(draft.color || DEFAULT_NOTE_COLOR);
        applyNoteState(draft.id, draft.body, nextColor);
        setStatus(t(locale, "statusDraft"));
        await invoke("emit_notes_changed");
        await refreshList();
      } catch {
        setStatus(t(locale, "statusOpenFailed"));
      }
    },
    [applyNoteState, discardIfBlank, flushSave, locale, refreshList],
  );

  const selectNote = useCallback(
    async (id: string) => {
      if (id === noteIdRef.current) return;
      if (saveTimer.current != null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const prevId = noteIdRef.current;
      if (prevId && isBlankBody(pendingRef.current.body)) {
        await discardIfBlank(prevId);
      } else {
        await flushSave();
      }
      try {
        const existing = await getNote(id);
        const nextColor = displayNoteColor(existing.color || DEFAULT_NOTE_COLOR);
        applyNoteState(existing.id, existing.body, nextColor);
        setStatus(t(locale, "statusSaved"));
        await refreshList();
      } catch {
        setStatus(t(locale, "statusOpenFailed"));
      }
    },
    [applyNoteState, discardIfBlank, flushSave, locale, refreshList],
  );

  const createNote = useCallback(async () => {
    await loadNote({ mode: "create" });
  }, [loadNote]);

  const visibleNotes = notes.filter((note) => isVisibleNote(note, activeId));

  /** 松手后把当前列表顺序写入 sort_order。 */
  const persistOrder = useCallback(async () => {
    if (reorderBusyRef.current) return;
    const ids = notesRef.current.map((note) => note.id);
    if (ids.length === 0) return;
    reorderBusyRef.current = true;
    try {
      await reorderNotes(ids);
      setStatus(t(locale, "statusOrderSaved"));
      await invoke("emit_notes_changed");
    } catch {
      setStatus(t(locale, "statusOrderFailed"));
      await refreshList();
    } finally {
      reorderBusyRef.current = false;
    }
  }, [locale, refreshList]);

  const autoScrollList = useCallback((clientY: number) => {
    const list = listRef.current;
    if (!list) return;
    const rect = list.getBoundingClientRect();
    if (clientY < rect.top + LIST_AUTO_SCROLL_EDGE) {
      list.scrollTop -= LIST_AUTO_SCROLL_SPEED;
    } else if (clientY > rect.bottom - LIST_AUTO_SCROLL_EDGE) {
      list.scrollTop += LIST_AUTO_SCROLL_SPEED;
    }
  }, []);

  /**
   * 整行 pointer 拖拽排序：小幅移动当点击打开，越过阈值后换位，松手落库。
   */
  const onRowPointerDown = useCallback((id: string, event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(".note-list-delete")) return;
    event.preventDefault();
    dragMovedRef.current = false;
    dragActiveRef.current = false;
    dragStartRef.current = { x: event.clientX, y: event.clientY };
    draggingIdRef.current = id;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
  }, []);

  const onRowPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const fromId = draggingIdRef.current;
      const start = dragStartRef.current;
      if (!fromId || !start) return;

      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (!dragActiveRef.current) {
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
        dragActiveRef.current = true;
        setDraggingId(fromId);
      }

      autoScrollList(event.clientY);
      const target = dropTargetFromClientY(event.clientY);
      if (!target || target.id === fromId) return;
      const next = moveNoteToTarget(notesRef.current, fromId, target);
      if (next === notesRef.current) return;
      dragMovedRef.current = true;
      notesRef.current = next;
      setNotes(next);
    },
    [autoScrollList],
  );

  const onRowPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const fromId = draggingIdRef.current;
      if (!fromId) return;
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch {
        // ignore
      }

      const moved = dragMovedRef.current;
      const wasDragging = dragActiveRef.current;
      draggingIdRef.current = null;
      dragStartRef.current = null;
      dragActiveRef.current = false;
      dragMovedRef.current = false;
      setDraggingId(null);

      if (moved) {
        void persistOrder();
        return;
      }
      // 未真正换位：当作点击打开
      if (!wasDragging) {
        void selectNote(fromId);
      }
    },
    [persistOrder, selectNote],
  );

  const onRowPointerCancel = useCallback(() => {
    draggingIdRef.current = null;
    dragStartRef.current = null;
    dragActiveRef.current = false;
    dragMovedRef.current = false;
    setDraggingId(null);
  }, []);

  const requestDeleteNote = useCallback((id: string, event?: React.MouseEvent) => {
    event?.preventDefault();
    event?.stopPropagation();
    setPendingDeleteId(id);
  }, []);

  const cancelDeleteNote = useCallback(() => {
    setPendingDeleteId(null);
  }, []);

  /** 二次确认后软删除，并切到下一条或新建草稿。 */
  const confirmDeleteNote = useCallback(async () => {
    const id = pendingDeleteId;
    if (!id) return;
    setPendingDeleteId(null);
    try {
      if (saveTimer.current != null && noteIdRef.current === id) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      await softDeleteNote(id);
      const remaining = notesRef.current.filter((note) => note.id !== id);
      notesRef.current = remaining;
      setNotes(remaining);
      await invoke("emit_notes_changed");

      if (noteIdRef.current === id) {
        const next = remaining.find(
          (note) => note.title.trim().length > 0 || note.excerpt.trim().length > 0,
        );
        if (next) {
          await selectNote(next.id);
        } else {
          noteIdRef.current = null;
          setActiveId(null);
          await loadNote({ mode: "create" });
        }
      } else {
        await refreshList();
      }
      setStatus(t(locale, "statusDeleted"));
    } catch {
      setStatus(t(locale, "statusDeleteFailed"));
      await refreshList();
    }
  }, [loadNote, locale, pendingDeleteId, refreshList, selectNote]);

  const toggleSidebar = useCallback(async () => {
    const next = !sidebarOpen;
    setSidebarOpen(next);
    try {
      const size = next ? EDITOR_WIDE : EDITOR_COMPACT;
      await getCurrentWindow().setSize(new LogicalSize(size.width, size.height));
    } catch {
      // ignore
    }
    if (next) {
      void refreshList();
    }
  }, [refreshList, sidebarOpen]);

  /** 固定 / 取消固定：窗口置顶显示。 */
  const togglePinned = useCallback(async () => {
    const next = !pinned;
    try {
      await getCurrentWindow().setAlwaysOnTop(next);
      setPinned(next);
    } catch {
      // ignore
    }
  }, [pinned]);

  useEffect(() => {
    const win = getCurrentWindow();
    const label = win.label;
    const isNoteWindow = label.startsWith("editor-");
    const bootNoteId =
      new URLSearchParams(window.location.search).get("id")?.trim() ||
      (isNoteWindow ? label.slice("editor-".length) : "");

    void applyChromeColor(DEFAULT_NOTE_COLOR);
    // 默认固定置顶
    void win
      .setAlwaysOnTop(true)
      .then(() => setPinned(true))
      .catch(() => {
        // ignore
      });
    void getSettings()
      .then((next) => {
        const nextLocale = normalizeLocale(next.locale);
        setLocale(nextLocale);
      })
      .catch(() => {
        // ignore
      });
    // 启动时清掉历史空白「未命名」，再等 editor://open，避免挂载又新建一条
    void (async () => {
      try {
        const purged = await purgeEmptyNotes();
        if (purged > 0) {
          await invoke("emit_notes_changed");
        }
      } catch {
        // ignore
      }
      // 花瓣多开窗：URL/label 带 noteId 时直接加载，不依赖广播事件
      if (bootNoteId) {
        await loadNote({ mode: "edit", id: bootNoteId });
      }
    })();
    const unlistenOpen = listen<EditorOpenPayload>(EVENTS.editorOpen, (event) => {
      // 专属窗只接受自己的便签，避免被其它窗事件串台
      if (isNoteWindow) {
        const incoming = event.payload.id?.trim();
        if (!incoming || incoming !== bootNoteId) return;
      }
      void win
        .setAlwaysOnTop(true)
        .then(() => setPinned(true))
        .catch(() => {
          // ignore
        });
      void loadNote(event.payload);
    });
    const unlistenNotes = listen(EVENTS.notesChanged, () => {
      // 拖拽中避免被广播刷新打断本地顺序
      if (draggingIdRef.current || reorderBusyRef.current) return;
      void refreshList();
      // 提醒到期后列表顺序可能变，顺带刷新当前便签
      const id = noteIdRef.current;
      if (!id) return;
      // 先取消未完成的保存，避免用旧正文覆盖库里仍保留的到期闹钟
      if (saveTimer.current != null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      void getNote(id)
        .then((note) => {
          if (noteIdRef.current !== id) return;
          setBody(note.body);
          pendingRef.current = { ...pendingRef.current, body: note.body };
        })
        .catch(() => {
          // ignore
        });
    });
    const unlistenSettings = listen(EVENTS.settingsUpdated, () => {
      void getSettings()
        .then((next) => setLocale(normalizeLocale(next.locale)))
        .catch(() => {
          // ignore
        });
    });
    const unlistenClose = win.onCloseRequested(async (event) => {
      event.preventDefault();
      if (saveTimer.current != null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const id = noteIdRef.current;
      if (id && isBlankBody(pendingRef.current.body)) {
        await discardIfBlank(id);
      } else {
        await flushSave();
      }
      setSidebarOpen(false);
      if (isNoteWindow) {
        // 便签专属窗关闭即销毁，下次点花瓣再开新窗
        await win.destroy();
      } else {
        await win.hide();
      }
    });
    return () => {
      void unlistenOpen.then((fn) => fn());
      void unlistenNotes.then((fn) => fn());
      void unlistenSettings.then((fn) => fn());
      void unlistenClose.then((fn) => fn());
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    };
  }, [discardIfBlank, flushSave, loadNote, refreshList]);

  const chromeColor = displayNoteColor(color);
  const accentColor = noteAccentColor(color);

  return (
    <div
      className={`editor${sidebarOpen ? " editor--sidebar" : ""}`}
      style={
        {
          background: chromeColor,
          "--editor-surface": chromeColor,
          "--todo-accent": accentColor,
        } as CSSProperties
      }
      onContextMenu={(event) => event.preventDefault()}
    >
      <header className="titlebar">
        <button
          type="button"
          className={`sidebar-toggle${sidebarOpen ? " active" : ""}`}
          aria-label={sidebarOpen ? t(locale, "collapseList") : t(locale, "expandList")}
          aria-pressed={sidebarOpen}
          title={sidebarOpen ? t(locale, "collapseList") : t(locale, "expandList")}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => {
            void toggleSidebar();
          }}
        >
          <span className="sidebar-toggle-icon" aria-hidden />
        </button>
        <div
          className="color-swatches"
          role="listbox"
          aria-label={t(locale, "noteColor")}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {NOTE_COLOR_PRESETS.map((preset) => {
            const active = color.toLowerCase() === preset.value.toLowerCase();
            return (
              <button
                key={preset.id}
                type="button"
                className={`color-swatch${active ? " active" : ""}`}
                style={{ background: preset.accent }}
                title={preset.label}
                aria-label={preset.label}
                aria-selected={active}
                onClick={() => setNoteColor(preset.value)}
              />
            );
          })}
        </div>
        <div className="titlebar-actions" onMouseDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="new-note-toggle"
            aria-label={t(locale, "newNote")}
            title={t(locale, "newNote")}
            onClick={() => {
              void createNote();
            }}
          >
            <svg
              className="new-note-toggle-icon"
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            type="button"
            className={`bold-toggle${boldActive ? " active" : ""}`}
            aria-label={t(locale, "bold")}
            title={t(locale, "bold")}
            aria-pressed={boldActive}
            onMouseDown={(event) => {
              // 避免抢走正文焦点，否则选区丢失无法加粗
              event.preventDefault();
            }}
            onClick={() => {
              const ok = bodyEditorRef.current?.toggleBold() ?? false;
              if (ok) {
                setBoldActive(bodyEditorRef.current?.isBoldActive() ?? false);
              }
            }}
          >
            <span className="bold-toggle-label" aria-hidden>
              B
            </span>
          </button>
          <button
            type="button"
            className="search-toggle"
            aria-label={t(locale, "searchNotes")}
            title={t(locale, "searchNotes")}
            onClick={() => {
              void openSearch().catch(() => {
                // ignore
              });
            }}
          >
            <svg
              className="search-toggle-icon"
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="11" cy="11" r="6.5" />
              <path d="M16.5 16.5 21 21" />
            </svg>
          </button>
          <button
            type="button"
            className={`pin-toggle${pinned ? " active" : ""}`}
            aria-label={pinned ? t(locale, "unpinWindow") : t(locale, "pinWindow")}
            aria-pressed={pinned}
            title={pinned ? t(locale, "unpinWindow") : t(locale, "pinWindow")}
            onClick={() => {
              void togglePinned();
            }}
          >
            <svg
              className="pin-toggle-icon"
              viewBox="0 0 24 24"
              width="15"
              height="15"
              aria-hidden
            >
              <path
                fill="currentColor"
                d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2V22h1.6v-6H18v-2l-2-2z"
              />
            </svg>
          </button>
        </div>
      </header>

      <div className="editor-main">
        {sidebarOpen ? (
          <aside className="note-sidebar" style={{ width: SIDEBAR_WIDTH }}>
            <div className="note-sidebar-head">
              <span>{t(locale, "appName")}</span>
            </div>
            <div
              ref={listRef}
              className={`note-list${draggingId ? " is-dragging" : ""}`}
              role="listbox"
              aria-label={t(locale, "notes")}
            >
              {visibleNotes.length === 0 ? (
                <div className="note-list-empty">{t(locale, "noNotes")}</div>
              ) : (
                visibleNotes.map((note) => {
                  const active = note.id === activeId;
                  const title = displayTitle(note.title || t(locale, "untitled"), 16);
                  const colorDot = displayNoteColor(note.color || DEFAULT_NOTE_COLOR);
                  return (
                    <div
                      key={note.id}
                      data-note-id={note.id}
                      className={`note-list-item${active ? " active" : ""}${
                        draggingId === note.id ? " dragging" : ""
                      }`}
                      role="option"
                      aria-selected={active}
                      title={t(locale, "dragHint")}
                      onPointerDown={(event) => onRowPointerDown(note.id, event)}
                      onPointerMove={onRowPointerMove}
                      onPointerUp={onRowPointerUp}
                      onPointerCancel={onRowPointerCancel}
                    >
                      <span className="note-list-handle" aria-hidden>
                        ⋮⋮
                      </span>
                      <div className="note-list-main">
                        <span
                          className="note-list-dot"
                          style={{ background: colorDot }}
                          aria-hidden
                        />
                        <span className="note-list-text">
                          <span className="note-list-title">{title}</span>
                          {note.excerpt ? (
                            <span className="note-list-excerpt">{note.excerpt}</span>
                          ) : null}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="note-list-delete"
                        aria-label={`${t(locale, "delete")} ${title}`}
                        title={t(locale, "delete")}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => requestDeleteNote(note.id, event)}
                      >
                        ×
                      </button>
                    </div>
                  );
                })
              )}
            </div>
            <div className="note-sidebar-foot">
              <button
                type="button"
                className="sidebar-settings"
                aria-label={t(locale, "appMenu")}
                title={t(locale, "appMenu")}
                onClick={() => {
                  void showAppContextMenu().catch(() => {
                    // ignore
                  });
                }}
              >
                <svg
                  className="sidebar-settings-icon"
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
                </svg>
              </button>
            </div>
          </aside>
        ) : null}

        <section className="note-pane">
          <NoteBodyEditor
            ref={bodyEditorRef}
            noteId={activeId}
            value={body}
            placeholder={t(locale, "placeholder")}
            todoAriaLabel={t(locale, "todoItem")}
            reminderAriaLabel={t(locale, "reminder")}
            locale={locale}
            onChange={(nextBody) => {
              setBody(nextBody);
              scheduleSave({ body: nextBody, color });
            }}
          />
          <footer className="editor-footer">
            <div className="status-bar">{status}</div>
            <div
              className="editor-fab"
              role="toolbar"
              aria-label={`${t(locale, "reminder")} / ${t(locale, "addTodo")}`}
            >
              <button
                type="button"
                className="reminder-toggle"
                aria-label={t(locale, "reminder")}
                title={t(locale, "reminderSet")}
                onMouseDown={(event) => {
                  // 避免抢走正文焦点，否则会认错行、误另起一行
                  event.preventDefault();
                }}
                onClick={() => {
                  bodyEditorRef.current?.addReminder();
                }}
              >
                <svg
                  className="reminder-toggle-icon"
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <circle cx="12" cy="13" r="7" />
                  <path d="M12 10v3.5l2 1M9 3.5 7 6M15 3.5l2 2.5" />
                </svg>
              </button>
              <button
                type="button"
                className="todo-toggle"
                aria-label={t(locale, "addTodo")}
                title={t(locale, "addTodo")}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  bodyEditorRef.current?.addTodo();
                }}
              >
                <svg
                  className="todo-toggle-icon"
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <rect x="4" y="4" width="16" height="16" rx="3" />
                  <path d="M8 12.5 10.5 15 16 9.5" />
                </svg>
              </button>
            </div>
          </footer>
        </section>
      </div>

      {pendingDeleteId ? (
        <div
          className="confirm-overlay"
          role="presentation"
          onClick={cancelDeleteNote}
          onKeyDown={(event) => {
            if (event.key === "Escape") cancelDeleteNote();
          }}
        >
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-confirm-title"
            aria-describedby="delete-confirm-desc"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="delete-confirm-title">{t(locale, "deleteTitle")}</h2>
            <p id="delete-confirm-desc">{t(locale, "deleteConfirm")}</p>
            <div className="confirm-actions">
              <button type="button" className="confirm-cancel" onClick={cancelDeleteNote}>
                {t(locale, "cancel")}
              </button>
              <button
                type="button"
                className="confirm-ok"
                onClick={() => {
                  void confirmDeleteNote();
                }}
              >
                {t(locale, "delete")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
