mod backup;
mod commands;
mod db;
mod error;
mod fan;
mod hotkeys;
mod images;
mod models;
mod monitor_geom;
mod platform;
mod reminders;
mod state;
mod tray;

use commands::*;
use commands::windows::attach_settings_hide_on_close;
use monitor_geom::{clamp_and_snap_orb, logical_work_area};
use state::AppState;
use tauri::{LogicalPosition, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&'static str>>,
        ))
        .setup(|app| {
            let state = AppState::init(app.handle())?;
            let settings = state.settings()?;
            let orb_visible = settings.orb_visible;
            let open_at_login = settings.open_at_login;
            let mut orb_x = settings.orb_x;
            let mut orb_y = settings.orb_y;
            app.manage(state);
            // 启动时按设置同步系统自启动注册（macOS LaunchAgent / Windows Run）
            commands::settings::apply_open_at_login(app.handle(), open_at_login);

            // 仅悬浮球时不在 Dock/任务栏占位；便签窗打开时仍可正常使用
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            if let Some(orb) = app.get_webview_window("orb") {
                platform::prepare_orb_window(&orb);
                let _ = orb.set_skip_taskbar(true);
                // 夹回 work area 并贴边吸附，避免启动半截在屏外或离边悬空
                if let (Ok(scale), Ok(Some(monitor))) =
                    (orb.scale_factor(), orb.current_monitor())
                {
                    let scale: f64 = scale.into();
                    let (mon_x, mon_y, mon_w, mon_h) = logical_work_area(&monitor, scale);
                    let snapped = clamp_and_snap_orb(orb_x, orb_y, mon_x, mon_y, mon_w, mon_h);
                    orb_x = snapped.0;
                    orb_y = snapped.1;
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

            // Windows：便签/设置窗改前端自绘标题栏（macOS 走 Overlay，其他平台默认装饰）
            #[cfg(windows)]
            for label in ["editor", "settings"] {
                if let Some(win) = app.get_webview_window(label) {
                    platform::prepare_custom_chrome(&win);
                }
            }

            tray::setup_tray(app.handle())?;
            if let Err(err) = hotkeys::setup_hotkeys(app.handle()) {
                eprintln!("[petaljot] setup_hotkeys failed: {err}");
            }
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
            app_show_context_menu,
            notes_export,
            notes_import,
            images_save,
            images_root,
            images_absolute_path,
            images_delete
        ])
        .on_menu_event(|app, event| {
            tray::dispatch_menu_event(&app, event.id().as_ref());
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
