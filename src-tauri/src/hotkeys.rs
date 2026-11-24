use crate::commands::windows::{editor_open_inner, search_open_inner, set_orb_visible_inner};
use crate::models::EditorOpenPayload;
use crate::state::AppState;
use std::time::Duration;
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

    // 逐个注册：单个冲突不应拖垮其余快捷键
    register_one(app, new_shortcut, "new-note", |app| {
        let _ = editor_open_inner(
            app,
            EditorOpenPayload {
                mode: "create".into(),
                id: None,
            },
        );
    });

    register_one(app, orb_shortcut, "toggle-orb", |app| {
        if let Some(orb) = app.get_webview_window("orb") {
            let _ = orb.show();
            let _ = orb.set_always_on_top(true);
            let _ = orb.set_focus();
        }
    });

    register_one(app, fan_spin_shortcut, "fan-spin", |app| {
        if let Some(state) = app.try_state::<AppState>() {
            let _ = set_orb_visible_inner(app, state.inner(), true);
        }
        if let Some(orb) = app.get_webview_window("orb") {
            let _ = orb.show();
            let _ = orb.set_always_on_top(true);
            let _ = orb.set_focus();
        }
        let _ = app.emit("orb://expand", Vec::<String>::new());
    });

    setup_double_ctrl_search(app)?;
    Ok(())
}

/// 注册单个快捷键；失败只打日志，不中断其它键。
fn register_one<F>(app: &AppHandle, shortcut: Shortcut, name: &'static str, action: F)
where
    F: Fn(&AppHandle) + Send + Sync + 'static,
{
    let action = std::sync::Arc::new(action);
    let result = app
        .global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            // Windows：快捷键回调不在 UI 线程，直接 show/建窗会失效；延后到主线程
            let app = app.clone();
            let action = std::sync::Arc::clone(&action);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(30));
                let app_main = app.clone();
                let _ = app.run_on_main_thread(move || action(&app_main));
            });
        });

    if let Err(err) = result {
        eprintln!("[petaljot] register hotkey `{name}` failed: {err}");
    }
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

/// 解析设置里的快捷键字符串。
/// Windows 上若残留 macOS 的 Command/Cmd，自动映射为 Control，避免注册成 Win 键。
fn parse_shortcut(raw: &str) -> Option<Shortcut> {
    let normalized = normalize_hotkey_string(raw);
    let lower = normalized.to_lowercase();
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

fn normalize_hotkey_string(raw: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        raw.to_string()
    }
    #[cfg(not(target_os = "macos"))]
    {
        // 避免 CommandOrControl 被同时解析成 SUPER+CONTROL
        raw.replace("CommandOrControl", "Control")
            .replace("CmdOrCtrl", "Control")
            .replace("Command", "Control")
            .replace("Cmd", "Control")
            .replace("Super", "Control")
    }
}

/// 双击 Control（Ctrl+Ctrl）唤起搜索。
#[cfg(target_os = "macos")]
fn setup_double_ctrl_search(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

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
                s.last_tap = None;
                s.ctrl_down = ctrl;
                return;
            }

            let was = s.ctrl_down;
            s.ctrl_down = ctrl;
            if !(ctrl && !was) {
                return;
            }
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
    std::mem::forget(monitors);

    Ok(())
}

/// Windows：低级键盘钩子监听双击 Ctrl，唤起搜索。
#[cfg(windows)]
fn setup_double_ctrl_search(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    win_double_ctrl::start(app.clone());
    Ok(())
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn setup_double_ctrl_search(_app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

/// Windows 双击 Ctrl 实现（WH_KEYBOARD_LL + 消息泵线程）。
#[cfg(windows)]
mod win_double_ctrl {
    use super::search_open_inner;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use tauri::AppHandle;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VIRTUAL_KEY, VK_CONTROL, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN,
        VK_MENU, VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, PeekMessageW, SetWindowsHookExW,
        TranslateMessage, UnhookWindowsHookEx, KBDLLHOOKSTRUCT, MSG, PM_NOREMOVE, WH_KEYBOARD_LL,
        WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    const TAP_WINDOW: Duration = Duration::from_millis(450);

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static CTRL_DOWN: AtomicBool = AtomicBool::new(false);
    static LAST_TAP: Mutex<Option<Instant>> = Mutex::new(None);

    pub fn start(app: AppHandle) {
        let _ = APP.set(app);
        std::thread::Builder::new()
            .name("petaljot-double-ctrl".into())
            .spawn(|| {
                if let Err(err) = run_hook_loop() {
                    eprintln!("[petaljot] double-ctrl hook failed: {err}");
                }
            })
            .expect("spawn double-ctrl hook thread");
    }

    fn run_hook_loop() -> windows::core::Result<()> {
        unsafe {
            // hMod 必须给当前模块：全局低级钩子（dwThreadId=0）传 NULL 时
            // 安装会成功但回调永远不被调用，双击 Ctrl 就完全没反应。
            let hmod = GetModuleHandleW(None)?;
            // 安装线程必须先有消息队列，否则低级钩子同样只装不回调
            let mut msg = MSG::default();
            let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
            // hook 仅留在本线程，避免 HHOOK 非 Sync 导致静态 Mutex 编译失败
            let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), Some(hmod.into()), 0)?;

            loop {
                let ret = GetMessageW(&mut msg, None, 0, 0);
                // 0 = WM_QUIT, -1 = error
                if ret.0 == 0 || ret.0 == -1 {
                    break;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let _ = UnhookWindowsHookEx(hook);
        }
        Ok(())
    }

    fn is_down(vk: VIRTUAL_KEY) -> bool {
        // windows 0.62 起 VIRTUAL_KEY 是 u16 新类型，GetAsyncKeyState 仍要 i32
        unsafe { GetAsyncKeyState(vk.0 as i32) < 0 }
    }

    fn open_search() {
        let Some(app) = APP.get() else {
            return;
        };
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            let app_main = app.clone();
            let _ = app.run_on_main_thread(move || {
                let _ = search_open_inner(&app_main);
            });
        });
    }

    unsafe extern "system" fn keyboard_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code >= 0 {
            let msg = wparam.0 as u32;
            let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let vk = kb.vkCode;

            let is_ctrl_key =
                vk == u32::from(VK_CONTROL.0)
                    || vk == u32::from(VK_LCONTROL.0)
                    || vk == u32::from(VK_RCONTROL.0);

            if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                if is_ctrl_key {
                    let was = CTRL_DOWN.swap(true, Ordering::SeqCst);
                    if !was {
                        let others = is_down(VK_SHIFT)
                            || is_down(VK_LSHIFT)
                            || is_down(VK_RSHIFT)
                            || is_down(VK_MENU)
                            || is_down(VK_LMENU)
                            || is_down(VK_RMENU)
                            || is_down(VK_LWIN)
                            || is_down(VK_RWIN);

                        if others {
                            if let Ok(mut last) = LAST_TAP.lock() {
                                *last = None;
                            }
                        } else if let Ok(mut last) = LAST_TAP.lock() {
                            if let Some(prev) = *last {
                                if prev.elapsed() <= TAP_WINDOW {
                                    *last = None;
                                    drop(last);
                                    open_search();
                                } else {
                                    *last = Some(Instant::now());
                                }
                            } else {
                                *last = Some(Instant::now());
                            }
                        }
                    }
                } else {
                    // 其它键打断双击序列
                    CTRL_DOWN.store(is_down(VK_CONTROL), Ordering::SeqCst);
                    if let Ok(mut last) = LAST_TAP.lock() {
                        *last = None;
                    }
                }
            } else if msg == WM_KEYUP || msg == WM_SYSKEYUP {
                if is_ctrl_key {
                    // 低级钩子在系统更新按键状态前回调，此处 GetAsyncKeyState 仍是按下，
                    // 故直接置 false（否则第二次按下时 CTRL_DOWN 仍为 true，双击永远不触发）
                    CTRL_DOWN.store(false, Ordering::SeqCst);
                }
            }
        }

        // WH_KEYBOARD_LL 传 None 即可，避免在钩子里再抢 HOOK 锁
        CallNextHookEx(None, code, wparam, lparam)
    }
}
