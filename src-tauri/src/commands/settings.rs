use crate::db;
use crate::error::AppResult;
use crate::models::AppSettings;
use crate::state::AppState;
use crate::tray;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_autostart::ManagerExt;

fn normalize_locale(raw: &str) -> String {
    if raw.eq_ignore_ascii_case("en") {
        "en".into()
    } else {
        "zh".into()
    }
}

/// 按设置同步系统「登录时打开」注册状态。
pub fn apply_open_at_login(app: &AppHandle, enabled: bool) {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    match result {
        Ok(()) => {
            eprintln!("[petaljot] autostart apply ok enabled={enabled}");
        }
        Err(err) => {
            eprintln!("[petaljot] autostart apply failed enabled={enabled} err={err}");
        }
    }
}

/// 读取应用设置。
#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> AppResult<AppSettings> {
    state.settings()
}

/// 部分更新设置。
#[tauri::command]
pub fn settings_set(patch: Value, app: AppHandle, state: State<'_, AppState>) -> AppResult<AppSettings> {
    let mut current = state.settings()?;
    let prev_open_at_login = current.open_at_login;
    let mut merged = serde_json::to_value(&current)?;
    if let (Value::Object(dst), Value::Object(src)) = (&mut merged, patch) {
        for (k, v) in src {
            dst.insert(k, v);
        }
    }
    current = serde_json::from_value(merged)?;
    current.petal_count = current.petal_count.clamp(4, 12);
    current.locale = normalize_locale(&current.locale);
    state.with_db(|conn| db::save_settings(conn, &current))?;
    tray::apply_locale(&app, &current.locale);
    if current.open_at_login != prev_open_at_login {
        apply_open_at_login(&app, current.open_at_login);
    }
    Ok(current)
}

/// 广播设置变更。
#[tauri::command]
pub fn emit_settings_updated(app: AppHandle) -> AppResult<()> {
    app.emit("settings://updated", ())?;
    Ok(())
}
