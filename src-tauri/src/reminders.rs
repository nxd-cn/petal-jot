use crate::commands::windows::set_orb_visible_inner;
use crate::db;
use crate::state::AppState;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const POLL_INTERVAL: Duration = Duration::from_secs(15);

/// 后台轮询到期提醒：显示悬浮球并通知前端展开花瓣。
pub fn spawn_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL_INTERVAL);
        let app_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            tick_reminders(&app_main);
        });
    });
}

fn tick_reminders(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let due = match state.with_db(db::claim_due_reminders) {
        Ok(ids) => ids,
        Err(_) => return,
    };
    if due.is_empty() {
        return;
    }

    let _ = set_orb_visible_inner(app, state.inner(), true);
    if let Some(orb) = app.get_webview_window("orb") {
        let _ = orb.show();
        let _ = orb.set_focus();
    }
    let _ = app.emit("notes://changed", ());
    let _ = app.emit("orb://expand", due);
}
