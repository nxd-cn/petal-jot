//! 便签 JSON 备份：本机导出 / 另一台机器导入（macOS + Windows）。

use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::{BackupFile, ImportStats};
use crate::platform;
use crate::state::AppState;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

const BACKUP_FILTER_NAME: &str = "PetalJot Backup";
const BACKUP_EXT: &[&str] = &["json"];
const DEFAULT_FILE_NAME: &str = "petaljot-backup.json";

/// 弹出另存为对话框，将未删除便签写成 JSON 备份文件。
pub fn export_with_dialog(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    let locale = state
        .settings()
        .map(|s| s.locale)
        .unwrap_or_else(|_| "zh".into());
    let is_en = locale == "en";

    prepare_dialog_ui(app);
    eprintln!("[petaljot] backup export: open save dialog");
    let Some(path) = rfd::FileDialog::new()
        .set_title(if is_en {
            "Export notes"
        } else {
            "导出便签"
        })
        .add_filter(BACKUP_FILTER_NAME, BACKUP_EXT)
        .set_file_name(DEFAULT_FILE_NAME)
        .save_file()
    else {
        eprintln!("[petaljot] backup export: cancelled");
        return Ok(());
    };

    let path = ensure_json_extension(path);
    let notes = state.with_db(db::list_notes_for_export)?;
    let count = notes.len();
    let backup = BackupFile {
        format: BackupFile::FORMAT.to_string(),
        version: BackupFile::VERSION,
        exported_at: now_ms(),
        notes,
    };
    let raw = serde_json::to_string_pretty(&backup)?;
    fs::write(&path, raw).map_err(|err| {
        eprintln!(
            "[petaljot] backup export: write failed path={} err={err}",
            path.display()
        );
        AppError::Io(err)
    })?;

    eprintln!(
        "[petaljot] backup export: ok count={count} path={}",
        path.display()
    );
    show_message(
        if is_en { "Export" } else { "导出" },
        if is_en {
            format!("Exported {count} note(s) to:\n{}", path.display())
        } else {
            format!("已导出 {count} 条便签到：\n{}", path.display())
        },
    );
    Ok(())
}

/// 弹出打开对话框，合并导入备份中的便签（同 id 以较新 updatedAt 为准）。
pub fn import_with_dialog(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    let locale = state
        .settings()
        .map(|s| s.locale)
        .unwrap_or_else(|_| "zh".into());
    let is_en = locale == "en";

    prepare_dialog_ui(app);
    eprintln!("[petaljot] backup import: open file dialog");
    let Some(path) = rfd::FileDialog::new()
        .set_title(if is_en {
            "Import notes"
        } else {
            "导入便签"
        })
        .add_filter(BACKUP_FILTER_NAME, BACKUP_EXT)
        .pick_file()
    else {
        eprintln!("[petaljot] backup import: cancelled");
        return Ok(());
    };

    let raw = fs::read_to_string(&path).map_err(|err| {
        eprintln!(
            "[petaljot] backup import: read failed path={} err={err}",
            path.display()
        );
        AppError::Io(err)
    })?;
    let backup: BackupFile = serde_json::from_str(&raw).map_err(|err| {
        eprintln!(
            "[petaljot] backup import: parse failed path={} err={err}",
            path.display()
        );
        AppError::Message(if is_en {
            format!("Invalid backup file: {err}")
        } else {
            format!("备份文件无效：{err}")
        })
    })?;

    if backup.format != BackupFile::FORMAT {
        return Err(AppError::Message(if is_en {
            format!("Unsupported backup format: {}", backup.format)
        } else {
            format!("不支持的备份格式：{}", backup.format)
        }));
    }
    if backup.version > BackupFile::VERSION {
        return Err(AppError::Message(if is_en {
            format!(
                "Backup version {} is newer than this app supports ({})",
                backup.version,
                BackupFile::VERSION
            )
        } else {
            format!(
                "备份版本 {} 高于当前应用支持的版本（{}）",
                backup.version,
                BackupFile::VERSION
            )
        }));
    }

    let note_count = backup.notes.len();
    eprintln!("[petaljot] backup import: applying notes={note_count}");
    let stats: ImportStats = state.with_db(|conn| db::import_notes(conn, &backup.notes))?;
    let _ = app.emit("notes://changed", ());

    eprintln!(
        "[petaljot] backup import: ok inserted={} updated={} skipped={} path={}",
        stats.inserted,
        stats.updated,
        stats.skipped,
        path.display()
    );
    show_message(
        if is_en { "Import" } else { "导入" },
        if is_en {
            format!(
                "Import finished.\nAdded: {}\nUpdated: {}\nSkipped: {}",
                stats.inserted, stats.updated, stats.skipped
            )
        } else {
            format!(
                "导入完成。\n新增：{}\n更新：{}\n跳过：{}",
                stats.inserted, stats.updated, stats.skipped
            )
        },
    );
    Ok(())
}

/// macOS Accessory 下对话框前先激活；Windows 无需额外动作。
fn prepare_dialog_ui(app: &AppHandle) {
    let _ = app;
    platform::activate_for_ui();
}

fn ensure_json_extension(path: PathBuf) -> PathBuf {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("json") => path,
        _ => path.with_extension("json"),
    }
}

fn show_message(title: &str, description: String) {
    rfd::MessageDialog::new()
        .set_title(title)
        .set_description(description)
        .set_level(rfd::MessageLevel::Info)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
