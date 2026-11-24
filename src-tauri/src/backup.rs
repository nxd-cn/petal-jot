//! 便签备份：导出 zip（backup.json + images/）；导入 zip 或旧版纯 JSON。

use crate::db;
use crate::error::{AppError, AppResult};
use crate::images;
use crate::models::{BackupFile, BackupNote, ImportStats};
use crate::platform;
use crate::state::AppState;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const BACKUP_FILTER_NAME: &str = "PetalJot Backup";
const BACKUP_ZIP_EXT: &[&str] = &["zip"];
const BACKUP_JSON_EXT: &[&str] = &["json"];
const DEFAULT_ZIP_NAME: &str = "petaljot-backup.zip";
const ZIP_JSON_ENTRY: &str = "backup.json";
const ZIP_IMAGES_PREFIX: &str = "images/";

/// 弹出另存为：导出 zip（含图片）。
pub fn export_with_dialog(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    let locale = state
        .settings()
        .map(|s| s.locale)
        .unwrap_or_else(|_| "zh".into());
    let is_en = locale == "en";

    prepare_dialog_ui(app);
    eprintln!("[petaljot] backup export: open save dialog (zip)");
    let Some(path) = rfd::FileDialog::new()
        .set_title(if is_en {
            "Export notes"
        } else {
            "导出便签"
        })
        .add_filter(BACKUP_FILTER_NAME, BACKUP_ZIP_EXT)
        .set_file_name(DEFAULT_ZIP_NAME)
        .save_file()
    else {
        eprintln!("[petaljot] backup export: cancelled");
        return Ok(());
    };

    let path = ensure_extension(path, "zip");
    let notes = state.with_db(db::list_notes_for_export)?;
    let count = notes.len();
    let image_count = write_backup_zip(&state.app_data_dir, &path, &notes)?;

    eprintln!(
        "[petaljot] backup export: ok notes={count} images={image_count} path={}",
        path.display()
    );
    show_message(
        if is_en { "Export" } else { "导出" },
        if is_en {
            format!(
                "Exported {count} note(s), {image_count} image(s) to:\n{}",
                path.display()
            )
        } else {
            format!(
                "已导出 {count} 条便签、{image_count} 张图片到：\n{}",
                path.display()
            )
        },
    );
    Ok(())
}

/// 弹出打开：支持 `.zip`（含图）与旧版 `.json`。
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
        .add_filter(BACKUP_FILTER_NAME, BACKUP_ZIP_EXT)
        .add_filter("JSON (legacy)", BACKUP_JSON_EXT)
        .pick_file()
    else {
        eprintln!("[petaljot] backup import: cancelled");
        return Ok(());
    };

    let (stats, image_count) = import_from_path(&state, &path, is_en)?;
    let _ = app.emit("notes://changed", ());

    eprintln!(
        "[petaljot] backup import: ok inserted={} updated={} skipped={} images={image_count} path={}",
        stats.inserted,
        stats.updated,
        stats.skipped,
        path.display()
    );
    show_message(
        if is_en { "Import" } else { "导入" },
        if is_en {
            format!(
                "Import finished.\nAdded: {}\nUpdated: {}\nSkipped: {}\nImages: {image_count}",
                stats.inserted, stats.updated, stats.skipped
            )
        } else {
            format!(
                "导入完成。\n新增：{}\n更新：{}\n跳过：{}\n图片：{image_count}",
                stats.inserted, stats.updated, stats.skipped
            )
        },
    );
    Ok(())
}

fn import_from_path(
    state: &AppState,
    path: &Path,
    is_en: bool,
) -> AppResult<(ImportStats, u32)> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if ext == "zip" {
        return import_zip(state, path, is_en);
    }
    if ext == "json" {
        let raw = fs::read_to_string(path).map_err(|err| {
            eprintln!(
                "[petaljot] backup import: read failed path={} err={err}",
                path.display()
            );
            AppError::Io(err)
        })?;
        let backup = parse_backup_json(&raw, is_en)?;
        let stats = state.with_db(|conn| db::import_notes(conn, &backup.notes))?;
        return Ok((stats, 0));
    }

    Err(AppError::Message(if is_en {
        "Please choose a .zip or .json backup file".into()
    } else {
        "请选择 .zip 或 .json 备份文件".into()
    }))
}

fn import_zip(state: &AppState, path: &Path, is_en: bool) -> AppResult<(ImportStats, u32)> {
    let file = File::open(path).map_err(AppError::Io)?;
    let mut archive = ZipArchive::new(file).map_err(|err| {
        eprintln!("[petaljot] backup import: zip open failed err={err}");
        AppError::Message(if is_en {
            format!("Invalid zip backup: {err}")
        } else {
            format!("无效的 zip 备份：{err}")
        })
    })?;

    let mut backup_json = String::new();
    {
        let mut entry = archive.by_name(ZIP_JSON_ENTRY).map_err(|err| {
            AppError::Message(if is_en {
                format!("Missing {ZIP_JSON_ENTRY} in zip: {err}")
            } else {
                format!("压缩包缺少 {ZIP_JSON_ENTRY}：{err}")
            })
        })?;
        entry
            .read_to_string(&mut backup_json)
            .map_err(AppError::Io)?;
    }

    let backup = parse_backup_json(&backup_json, is_en)?;
    let images_root = images::images_root(&state.app_data_dir)?;
    let mut image_count = 0u32;

    // 再扫一遍 zip，写出 images/*
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|err| {
            AppError::Message(format!("zip entry {i} failed: {err}"))
        })?;
        let name = entry.name().replace('\\', "/");
        if name == ZIP_JSON_ENTRY || entry.is_dir() {
            continue;
        }
        let Some(rel) = name.strip_prefix(ZIP_IMAGES_PREFIX) else {
            continue;
        };
        if rel.is_empty() {
            continue;
        }
        let Ok(rel_path) = images::sanitize_relative_path(rel) else {
            eprintln!("[petaljot] backup import: skip unsafe image path={rel}");
            continue;
        };
        let dest = images_root.join(&rel_path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = File::create(&dest).map_err(AppError::Io)?;
        std::io::copy(&mut entry, &mut out).map_err(AppError::Io)?;
        image_count += 1;
        eprintln!(
            "[petaljot] backup import: restored image relative={}",
            rel_path.display()
        );
    }

    let stats = state.with_db(|conn| db::import_notes(conn, &backup.notes))?;
    Ok((stats, image_count))
}

fn write_backup_zip(
    app_data_dir: &Path,
    zip_path: &Path,
    notes: &[BackupNote],
) -> AppResult<u32> {
    let backup = BackupFile {
        format: BackupFile::FORMAT.to_string(),
        version: BackupFile::VERSION,
        exported_at: now_ms(),
        notes: notes.to_vec(),
    };
    let json = serde_json::to_string_pretty(&backup)?;

    let file = File::create(zip_path).map_err(|err| {
        eprintln!(
            "[petaljot] backup export: create zip failed path={} err={err}",
            zip_path.display()
        );
        AppError::Io(err)
    })?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file(ZIP_JSON_ENTRY, opts)
        .map_err(|err| AppError::Message(format!("zip write json entry: {err}")))?;
    zip.write_all(json.as_bytes()).map_err(AppError::Io)?;

    let mut image_count = 0u32;
    let mut seen = std::collections::HashSet::<String>::new();
    for note in notes {
        for rel in images::collect_image_refs(&note.body) {
            if !seen.insert(rel.clone()) {
                continue;
            }
            let abs = match images::absolute_image_path(app_data_dir, &rel) {
                Ok(p) => p,
                Err(err) => {
                    eprintln!("[petaljot] backup export: skip bad image path={rel} err={err}");
                    continue;
                }
            };
            if !abs.is_file() {
                eprintln!(
                    "[petaljot] backup export: missing image file relative={rel} abs={}",
                    abs.display()
                );
                continue;
            }
            let bytes = fs::read(&abs).map_err(AppError::Io)?;
            let entry_name = format!("{ZIP_IMAGES_PREFIX}{rel}");
            zip.start_file(&entry_name, opts)
                .map_err(|err| AppError::Message(format!("zip write image: {err}")))?;
            zip.write_all(&bytes).map_err(AppError::Io)?;
            image_count += 1;
        }
    }

    zip.finish()
        .map_err(|err| AppError::Message(format!("zip finish: {err}")))?;
    Ok(image_count)
}

fn parse_backup_json(raw: &str, is_en: bool) -> AppResult<BackupFile> {
    let backup: BackupFile = serde_json::from_str(raw).map_err(|err| {
        eprintln!("[petaljot] backup import: parse failed err={err}");
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
    Ok(backup)
}

fn prepare_dialog_ui(app: &AppHandle) {
    let _ = app;
    platform::activate_for_ui();
}

fn ensure_extension(path: PathBuf, ext: &str) -> PathBuf {
    match path.extension().and_then(|e| e.to_str()) {
        Some(e) if e.eq_ignore_ascii_case(ext) => path,
        _ => path.with_extension(ext),
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
