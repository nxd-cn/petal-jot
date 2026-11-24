//! 前端可调用的导出 / 导入命令（设置页按钮；与菜单共用同一实现）。

use crate::backup;
use crate::error::AppResult;
use tauri::AppHandle;

/// 导出便签：弹出系统另存为对话框（macOS / Windows）。
#[tauri::command]
pub fn notes_export(app: AppHandle) -> AppResult<()> {
    eprintln!("[petaljot] command notes_export");
    backup::export_with_dialog(&app)
}

/// 导入便签：弹出系统打开对话框并合并写入（macOS / Windows）。
#[tauri::command]
pub fn notes_import(app: AppHandle) -> AppResult<()> {
    eprintln!("[petaljot] command notes_import");
    backup::import_with_dialog(&app)
}
