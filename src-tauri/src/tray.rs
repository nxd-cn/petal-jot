use crate::commands::windows::{editor_open_inner, set_orb_visible_inner, settings_open_inner};
use crate::error::AppResult;
use crate::models::EditorOpenPayload;
use crate::state::{AppState, TrayMenus};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

/// macOS 托盘菜单收起后立刻 show 容易抢焦点失败，短暂延后到主线程执行。
fn open_after_tray_menu(app: &AppHandle, action: impl FnOnce(&AppHandle) + Send + 'static) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        let app_main = app.clone();
        let _ = app.run_on_main_thread(move || action(&app_main));
    });
}

fn locale_labels(locale: &str) -> (&'static str, &'static str, &'static str, &'static str) {
    if locale == "en" {
        ("New Note", "Show/Hide Orb", "Settings", "Quit")
    } else {
        ("新建便签", "显示/隐藏悬浮球", "设置", "退出")
    }
}

fn build_app_menu(
    app: &AppHandle,
    locale: &str,
    include_new: bool,
) -> tauri::Result<(Menu<tauri::Wry>, Option<TrayMenus>)> {
    let (new_l, toggle_l, settings_l, quit_l) = locale_labels(locale);
    let toggle_item = MenuItem::with_id(app, "toggle_orb", toggle_l, true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", settings_l, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", quit_l, true, None::<&str>)?;

    if include_new {
        let new_item = MenuItem::with_id(app, "new", new_l, true, None::<&str>)?;
        let menu = Menu::with_items(
            app,
            &[&new_item, &toggle_item, &settings_item, &quit_item],
        )?;
        let menus = TrayMenus {
            new_item,
            toggle_item,
            settings_item,
            quit_item,
        };
        Ok((menu, Some(menus)))
    } else {
        // 悬浮球右键 / 侧栏设置：不需要「新建便签」
        let menu = Menu::with_items(app, &[&toggle_item, &settings_item, &quit_item])?;
        Ok((menu, None))
    }
}

/// 按语言更新托盘菜单文案。
pub fn apply_locale(app: &AppHandle, locale: &str) {
    let state = app.state::<AppState>();
    let Ok(guard) = state.tray_menus.lock() else {
        return;
    };
    let Some(menus) = guard.as_ref() else {
        return;
    };
    let (new_l, toggle_l, settings_l, quit_l) = locale_labels(locale);
    let _ = menus.new_item.set_text(new_l);
    let _ = menus.toggle_item.set_text(toggle_l);
    let _ = menus.settings_item.set_text(settings_l);
    let _ = menus.quit_item.set_text(quit_l);
}

/// 处理托盘 / 圆球右键菜单点击。
pub fn dispatch_menu_event(app: &AppHandle, id: &str) {
    match id {
        "new" => {
            open_after_tray_menu(app, |app| {
                let _ = editor_open_inner(
                    app,
                    EditorOpenPayload {
                        mode: "create".into(),
                        id: None,
                    },
                );
            });
        }
        "toggle_orb" => {
            let state = app.state::<AppState>();
            let visible = state.settings().map(|s| s.orb_visible).unwrap_or(true);
            let _ = set_orb_visible_inner(app, state.inner(), !visible);
        }
        "settings" => {
            open_after_tray_menu(app, |app| {
                let _ = settings_open_inner(app);
            });
        }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

/// 在指定窗口弹出设置菜单（显示/隐藏球、设置、退出；不含新建）。
pub fn popup_context_menu_on(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
) -> AppResult<()> {
    let locale = app
        .state::<AppState>()
        .settings()
        .map(|s| s.locale)
        .unwrap_or_else(|_| "zh".into());
    let (menu, _items) = build_app_menu(app, &locale, false)
        .map_err(|err| crate::error::AppError::Message(err.to_string()))?;
    window
        .popup_menu(&menu)
        .map_err(|err| crate::error::AppError::Message(err.to_string()))?;
    Ok(())
}

/// 在悬浮球窗口弹出与托盘一致的设置菜单。
pub fn popup_orb_context_menu(app: &AppHandle) -> AppResult<()> {
    let orb = app
        .get_webview_window("orb")
        .ok_or_else(|| crate::error::AppError::Message("orb window missing".into()))?;
    popup_context_menu_on(app, &orb)
}

/// 创建系统托盘与菜单。
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let locale = app
        .state::<AppState>()
        .settings()
        .map(|s| s.locale)
        .unwrap_or_else(|_| "zh".into());
    let (menu, menus) = build_app_menu(app, &locale, true)?;

    if let Ok(mut guard) = app.state::<AppState>().tray_menus.lock() {
        *guard = menus;
    }

    let icon = app
        .default_window_icon()
        .cloned()
        .expect("missing default window icon");

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip(if locale == "en" {
            "PetalJot"
        } else {
            "花记"
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(orb) = app.get_webview_window("orb") {
                    let _ = orb.show();
                    let _ = orb.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
