use crate::commands::windows::{editor_open_inner, search_open_inner, set_orb_visible_inner};
use crate::models::EditorOpenPayload;
use crate::state::AppState;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// 注册全局快捷键。
pub fn setup_hotkeys(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let settings = app.state::<AppState>().settings()?;
    let new_shortcut =
        parse_shortcut(&settings.hotkey_new).unwrap_or_else(default_new_shortcut);
    let orb_shortcut =
        parse_shortcut(&settings.hotkey_orb).unwrap_or_else(default_orb_shortcut);
    let fan_spin_shortcut = fan_spin_shortcut();

    app.global_shortcut().on_shortcut(new_shortcut, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            let _ = editor_open_inner(
                app,
                EditorOpenPayload {
                    mode: "create".into(),
                    id: None,
                },
            );
        }
    })?;

    app.global_shortcut().on_shortcut(orb_shortcut, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            if let Some(orb) = app.get_webview_window("orb") {
                let _ = orb.show();
                let _ = orb.set_focus();
            }
        }
    })?;

    // Ctrl+Shift+X：展开花瓣并旋转（与提醒到期相同）
    app.global_shortcut()
        .on_shortcut(fan_spin_shortcut, |app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            if let Some(state) = app.try_state::<AppState>() {
                let _ = set_orb_visible_inner(app, state.inner(), true);
            }
            if let Some(orb) = app.get_webview_window("orb") {
                let _ = orb.show();
                let _ = orb.set_focus();
            }
            let _ = app.emit("orb://expand", Vec::<String>::new());
        })?;

    setup_double_ctrl_search(app)?;

    Ok(())
}

/// Ctrl+Shift+X：展开花瓣并旋转。
fn fan_spin_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyX)
}

fn default_new_shortcut() -> Shortcut {
    if cfg!(target_os = "macos") {
        Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyN)
    } else {
        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyN)
    }
}

fn default_orb_shortcut() -> Shortcut {
    if cfg!(target_os = "macos") {
        Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Space)
    } else {
        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space)
    }
}

fn parse_shortcut(raw: &str) -> Option<Shortcut> {
    let lower = raw.to_lowercase();
    let code = if lower.contains("+n") || lower.ends_with('n') {
        Code::KeyN
    } else if lower.contains("space") {
        Code::Space
    } else {
        return None;
    };
    let mut modifiers = Modifiers::empty();
    if lower.contains("command") || lower.contains("super") || lower.contains("cmd") {
        modifiers |= Modifiers::SUPER;
    }
    if lower.contains("control") || lower.contains("ctrl") {
        modifiers |= Modifiers::CONTROL;
    }
    if lower.contains("shift") {
        modifiers |= Modifiers::SHIFT;
    }
    if lower.contains("alt") || lower.contains("option") {
        modifiers |= Modifiers::ALT;
    }
    Some(Shortcut::new(Some(modifiers), code))
}

/// 双击 Control（Ctrl+Ctrl）唤起搜索。
#[cfg(target_os = "macos")]
fn setup_double_ctrl_search(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    const TAP_WINDOW: Duration = Duration::from_millis(450);
    /// macOS virtual key codes: left / right Control
    const VK_CONTROL: u16 = 59;
    const VK_RIGHT_CONTROL: u16 = 62;

    struct TapState {
        last_tap: Option<Instant>,
        ctrl_down: bool,
    }

    let state = Arc::new(Mutex::new(TapState {
        last_tap: None,
        ctrl_down: false,
    }));

    let handle_flags = {
        let app = app.clone();
        let state = Arc::clone(&state);
        move |event: &NSEvent| {
            let key_code = event.keyCode();
            let flags =
                event.modifierFlags() & NSEventModifierFlags::DeviceIndependentFlagsMask;
            let ctrl = flags.contains(NSEventModifierFlags::Control);
            let others = flags.intersects(
                NSEventModifierFlags::Shift
                    | NSEventModifierFlags::Option
                    | NSEventModifierFlags::Command,
            );

            let mut s = match state.lock() {
                Ok(g) => g,
                Err(_) => return,
            };

            if key_code != VK_CONTROL && key_code != VK_RIGHT_CONTROL {
                // 其它修饰键变化：打断双击序列，但仍同步 Control 状态
                s.last_tap = None;
                s.ctrl_down = ctrl;
                return;
            }

            let was = s.ctrl_down;
            s.ctrl_down = ctrl;
            if !(ctrl && !was) {
                return;
            }
            // Control 按下
            if others {
                s.last_tap = None;
                return;
            }
            if let Some(prev) = s.last_tap {
                if prev.elapsed() <= TAP_WINDOW {
                    s.last_tap = None;
                    drop(s);
                    let _ = search_open_inner(&app);
                    return;
                }
            }
            s.last_tap = Some(Instant::now());
        }
    };

    let handle_key_down = {
        let state = Arc::clone(&state);
        move |_event: &NSEvent| {
            if let Ok(mut s) = state.lock() {
                s.last_tap = None;
            }
        }
    };

    let flags_global = {
        let handle_flags = handle_flags.clone();
        RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| {
            handle_flags(unsafe { event.as_ref() });
        })
    };
    let flags_local = {
        let handle_flags = handle_flags.clone();
        RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
            handle_flags(unsafe { event.as_ref() });
            event.as_ptr()
        })
    };
    let key_global = {
        let handle_key_down = handle_key_down.clone();
        RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| {
            handle_key_down(unsafe { event.as_ref() });
        })
    };
    let key_local = {
        let handle_key_down = handle_key_down.clone();
        RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
            handle_key_down(unsafe { event.as_ref() });
            event.as_ptr()
        })
    };

    // 保留 monitor 句柄，避免被释放后失效
    let mut monitors: Vec<Retained<AnyObject>> = Vec::new();
    if let Some(m) =
        NSEvent::addGlobalMonitorForEventsMatchingMask_handler(NSEventMask::FlagsChanged, &flags_global)
    {
        monitors.push(m);
    }
    if let Some(m) =
        NSEvent::addGlobalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &key_global)
    {
        monitors.push(m);
    }
    unsafe {
        if let Some(m) =
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::FlagsChanged, &flags_local)
        {
            monitors.push(m);
        }
        if let Some(m) =
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &key_local)
        {
            monitors.push(m);
        }
    }
    // 进程生命周期内常驻
    std::mem::forget(monitors);

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn setup_double_ctrl_search(_app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // 其它平台暂未实现「双击 Ctrl」系统级监听
    Ok(())
}
