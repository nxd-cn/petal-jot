//! 图片 IPC：落盘与解析绝对路径（供 convertFileSrc）。

use crate::error::AppResult;
use crate::images;
use crate::state::AppState;
use tauri::State;

/// 保存粘贴图片字节，返回相对路径 `noteId/uuid.ext`。
#[tauri::command]
pub fn images_save(
    note_id: String,
    bytes: Vec<u8>,
    ext: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    eprintln!(
        "[petaljot] command images_save note_id={note_id} bytes={} ext={ext}",
        bytes.len()
    );
    images::save_image_bytes(&state.app_data_dir, &note_id, &bytes, &ext)
}

/// 返回 images 根目录绝对路径。
#[tauri::command]
pub fn images_root(state: State<'_, AppState>) -> AppResult<String> {
    let root = images::images_root(&state.app_data_dir)?;
    Ok(root.to_string_lossy().into_owned())
}

/// 相对路径 → 绝对文件路径（用于前端 convertFileSrc）。
#[tauri::command]
pub fn images_absolute_path(
    relative_path: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let abs = images::absolute_image_path(&state.app_data_dir, &relative_path)?;
    Ok(abs.to_string_lossy().into_owned())
}

/// 删除正文中移除的图片文件（相对路径 `noteId/uuid.ext`）。
#[tauri::command]
pub fn images_delete(relative_path: String, state: State<'_, AppState>) -> AppResult<()> {
    eprintln!("[petaljot] command images_delete relative={relative_path}");
    images::delete_image_file(&state.app_data_dir, &relative_path)
}
