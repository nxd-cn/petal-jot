use crate::db;
use crate::error::AppResult;
use crate::models::AppSettings;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Wry};

/// 历史 bundle id 对应的数据目录；改名后 Tauri 会换新目录，启动时从此处迁回。
const LEGACY_APP_IDS: &[&str] = &["com.nixiaodong.rnt", "com.nixiaodong.petalnote"];

pub struct TrayMenus {
    pub new_item: MenuItem<Wry>,
    pub toggle_item: MenuItem<Wry>,
    pub settings_item: MenuItem<Wry>,
    pub export_item: MenuItem<Wry>,
    pub import_item: MenuItem<Wry>,
    pub quit_item: MenuItem<Wry>,
}

pub struct AppState {
    pub db: Mutex<Connection>,
    pub tray_menus: Mutex<Option<TrayMenus>>,
    pub app_data_dir: PathBuf,
}

impl AppState {
    pub fn init(app: &AppHandle) -> AppResult<Self> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|err| crate::error::AppError::Message(err.to_string()))?;
        std::fs::create_dir_all(&app_data_dir)?;
        migrate_legacy_app_data(&app_data_dir);
        let db_path = app_data_dir.join("notes.db");
        let db = db::init_db(&db_path)?;
        Ok(Self {
            db: Mutex::new(db),
            tray_menus: Mutex::new(None),
            app_data_dir,
        })
    }

    pub fn with_db<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let guard = self
            .db
            .lock()
            .map_err(|_| crate::error::AppError::Message("db lock poisoned".into()))?;
        f(&guard)
    }

    /// 写路径使用可变连接，保证事务与 UPDATE 真正提交。
    pub fn with_db_mut<T>(&self, f: impl FnOnce(&mut Connection) -> AppResult<T>) -> AppResult<T> {
        let mut guard = self
            .db
            .lock()
            .map_err(|_| crate::error::AppError::Message("db lock poisoned".into()))?;
        f(&mut guard)
    }

    pub fn settings(&self) -> AppResult<AppSettings> {
        self.with_db(db::load_settings)
    }
}

fn note_count(db_path: &Path) -> Option<i64> {
    if !db_path.is_file() {
        return None;
    }
    let conn = Connection::open(db_path).ok()?;
    conn.query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .ok()
}

/// 若当前目录便签明显少于旧 bundle 目录，把旧 notes.db / images 迁过来。
fn migrate_legacy_app_data(current_dir: &Path) {
    let Some(parent) = current_dir.parent() else {
        return;
    };
    let current_db = current_dir.join("notes.db");
    let current_count = note_count(&current_db).unwrap_or(0);

    let mut best: Option<(PathBuf, i64)> = None;
    for id in LEGACY_APP_IDS {
        let candidate = parent.join(id).join("notes.db");
        let Some(count) = note_count(&candidate) else {
            continue;
        };
        if count <= current_count {
            continue;
        }
        if best.as_ref().is_none_or(|(_, n)| count > *n) {
            best = Some((candidate, count));
        }
    }
    let Some((src_db, _)) = best else {
        return;
    };
    let Some(src_dir) = src_db.parent() else {
        return;
    };

    if current_db.exists() {
        let backup = current_dir.join("notes.db.bak-before-migrate");
        let _ = std::fs::copy(&current_db, backup);
    }
    if std::fs::copy(&src_db, &current_db).is_err() {
        return;
    }

    let src_images = src_dir.join("images");
    if src_images.is_dir() {
        let dst_images = current_dir.join("images");
        let _ = std::fs::create_dir_all(&dst_images);
        if let Ok(entries) = std::fs::read_dir(&src_images) {
            for entry in entries.flatten() {
                let from = entry.path();
                if from.is_file() {
                    let to = dst_images.join(entry.file_name());
                    let _ = std::fs::copy(&from, to);
                }
            }
        }
    }
}
