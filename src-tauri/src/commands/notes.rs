use crate::db;
use crate::error::AppResult;
use crate::images;
use crate::models::{Note, NoteSummary, UpsertNoteInput};
use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};

/// 花瓣列表：按排序取前 limit 条；`pinIds` 中的便签会置顶纳入（到期闹钟用）。
#[tauri::command]
pub fn notes_list_recent(
    limit: u32,
    pin_ids: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> AppResult<Vec<NoteSummary>> {
    let limit = limit.clamp(1, 12);
    let pins = pin_ids.unwrap_or_default();
    if pins.is_empty() {
        return state.with_db(|conn| db::list_recent(conn, limit));
    }
    state.with_db(|conn| db::list_recent_pinning(conn, limit, &pins))
}

/// 列出便签（主界面侧栏，固定 sort_order）。
#[tauri::command]
pub fn notes_list(limit: u32, state: State<'_, AppState>) -> AppResult<Vec<NoteSummary>> {
    let limit = limit.clamp(1, 500);
    let notes = state.with_db(|conn| db::list_ordered(conn, limit))?;
    Ok(notes)
}

/// 搜索便签标题与正文。
#[tauri::command]
pub fn notes_search(query: String, limit: u32, state: State<'_, AppState>) -> AppResult<Vec<NoteSummary>> {
    let limit = limit.clamp(1, 100);
    state.with_db(|conn| db::search_notes(conn, &query, limit))
}

/// 拖拽排序后写入固定顺序。
#[tauri::command]
pub fn notes_reorder(ids: Vec<String>, state: State<'_, AppState>) -> AppResult<()> {
    state.with_db_mut(|conn| db::reorder_notes(conn, &ids))?;
    Ok(())
}

/// 读取单条便签。
#[tauri::command]
pub fn notes_get(id: String, state: State<'_, AppState>) -> AppResult<Note> {
    state.with_db(|conn| db::get_note(conn, &id))
}

/// 新建或更新便签。
#[tauri::command]
pub fn notes_upsert(input: UpsertNoteInput, state: State<'_, AppState>) -> AppResult<Note> {
    let note = state.with_db(|conn| db::upsert_note(conn, input))?;
    Ok(note)
}

/// 软删除便签，并清除该笔记落盘图片目录。
#[tauri::command]
pub fn notes_soft_delete(id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.with_db_mut(|conn| db::soft_delete(conn, &id))?;
    if let Err(err) = images::delete_note_images(&state.app_data_dir, &id) {
        eprintln!("[petaljot] notes_soft_delete images cleanup failed id={id} err={err}");
    }
    Ok(())
}

/// 清理所有空白未命名便签，并清除对应图片目录。
#[tauri::command]
pub fn notes_purge_empty(state: State<'_, AppState>) -> AppResult<u32> {
    let empty_ids = state.with_db(db::list_empty_note_ids)?;
    let count = state.with_db(db::purge_empty_notes)?;
    for id in empty_ids {
        if let Err(err) = images::delete_note_images(&state.app_data_dir, &id) {
            eprintln!("[petaljot] notes_purge_empty images cleanup failed id={id} err={err}");
        }
    }
    Ok(count)
}

/// 获取或创建唯一空白草稿（避免堆未命名）；顺带清掉其它空白条的图片目录。
#[tauri::command]
pub fn notes_find_or_create_draft(state: State<'_, AppState>) -> AppResult<Note> {
    let empty_ids = state.with_db(db::list_empty_note_ids)?;
    let note = state.with_db(db::find_or_create_draft)?;
    for id in empty_ids {
        if id == note.id {
            continue;
        }
        if let Err(err) = images::delete_note_images(&state.app_data_dir, &id) {
            eprintln!(
                "[petaljot] notes_find_or_create_draft images cleanup failed id={id} err={err}"
            );
        }
    }
    Ok(note)
}

/// 广播便签变更事件，刷新花瓣。
#[tauri::command]
pub fn emit_notes_changed(app: AppHandle) -> AppResult<()> {
    app.emit("notes://changed", ())?;
    Ok(())
}
