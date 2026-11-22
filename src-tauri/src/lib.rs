mod commands;
mod db;
mod error;
mod fan;
mod hotkeys;
mod models;
mod platform;
mod reminders;
mod state;
mod tray;

use commands::*;
use commands::windows::attach_settings_hide_on_close;
use state::AppState;
use tauri::{LogicalPosition, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let state = AppState::init(app.handle())?;
            let settings = state.settings()?;
            let orb_visible = settings.orb_visible;
            let mut orb_x = settings.orb_x;
            let mut orb_y = settings.orb_y;
            app.manage(state);

            // 仅悬浮球时不在 Dock/任务栏占位；便签窗打开时仍可正常使用
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            if let Some(orb) = app.get_webview_window("orb") {
                platform::prepare_orb_window(&orb);
                let _ = orb.set_skip_taskbar(true);
                // 若曾半隐藏靠边，把球夹回显示器内，避免启动仍半截在屏外
                const ORB_IDLE: f64 = 56.0;
                if let (Ok(scale), Ok(Some(monitor))) =
                    (orb.scale_factor(), orb.current_monitor())
                {
                    let scale: f64 = scale.into();
                    let mon_pos = monitor.position();
                    let mon_size = monitor.size();
                    let mon_x = mon_pos.x as f64 / scale;
                    let mon_y = mon_pos.y as f64 / scale;
                    let mon_w = f64::from(mon_size.width) / scale;
                    let mon_h = f64::from(mon_size.height) / scale;
                    orb_x = orb_x.clamp(mon_x, (mon_x + mon_w - ORB_IDLE).max(mon_x));
                    orb_y = orb_y.clamp(mon_y, (mon_y + mon_h - ORB_IDLE).max(mon_y));
                }
                if (orb_x - settings.orb_x).abs() > 0.5 || (orb_y - settings.orb_y).abs() > 0.5 {
                    if let Some(state) = app.try_state::<AppState>() {
                        if let Ok(mut s) = state.settings() {
                            s.orb_x = orb_x;
                            s.orb_y = orb_y;
                            let _ = state.with_db(|conn| db::save_settings(conn, &s));
                        }
                    }
                }
                orb.set_position(LogicalPosition::new(orb_x, orb_y))?;
                // Windows 上置顶属性偶发在定位后丢失，再确认一次（macOS 无影响）
                let _ = orb.set_always_on_top(true);
                if orb_visible {
                    orb.show()?;
                } else {
                    orb.hide()?;
                }
            }

            tray::setup_tray(app.handle())?;
            let _ = hotkeys::setup_hotkeys(app.handle());
            reminders::spawn_watcher(app.handle().clone());

            // 设置窗点关闭改为隐藏，避免被销毁后托盘「设置」打不开
            if let Some(win) = app.get_webview_window("settings") {
                attach_settings_hide_on_close(app.handle(), &win);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            notes_list_recent,
            notes_list,
            notes_search,
            notes_reorder,
            notes_get,
            notes_upsert,
            notes_soft_delete,
            notes_purge_empty,
            notes_find_or_create_draft,
            emit_notes_changed,
            settings_get,
            settings_set,
            emit_settings_updated,
            orb_set_visible,
            orb_set_position,
            orb_expand_fan,
            orb_apply_fan_frame,
            orb_collapse_fan,
            editor_open,
            settings_open,
            search_open,
            orb_show_context_menu,
            app_show_context_menu
        ])
        .on_menu_event(|app, event| {
            tray::dispatch_menu_event(&app, event.id().as_ref());
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
