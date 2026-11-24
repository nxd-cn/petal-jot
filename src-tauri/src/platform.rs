use tauri::WebviewWindow;

/// Accessory 策略下从托盘拉起普通窗时，先激活应用，否则 show/focus 经常无效。
pub fn activate_for_ui() {
    #[cfg(target_os = "macos")]
    {
        let _ = activate_macos_app();
    }
}

#[cfg(target_os = "macos")]
fn activate_macos_app() -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;

    let mtm = MainThreadMarker::new().ok_or_else(|| "activate requires main thread".to_string())?;
    let app = NSApplication::sharedApplication(mtm);
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
    Ok(())
}

/// 禁止「正文拖选带动窗口」，顶部仍可由前端 `startDragging` 主动拖移。
/// - macOS：`NSWindow.setMovable(false)`（关掉 Overlay 系统拖动区，避免选字晃窗）
/// - Windows：子类化拦截系统 `SC_MOVE` / `HTCAPTION`（同上）
///
/// 必须走主线程：点花瓣走 async `editor_open`，非 UI 线程调原生 API 会崩。
pub fn pin_window_movable(win: &WebviewWindow) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let win = win.clone();
        let _ = win.clone().run_on_main_thread(move || {
            pin_window_movable_now(&win);
        });
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = win;
    }
}

#[cfg(target_os = "macos")]
fn pin_window_movable_now(win: &WebviewWindow) {
    use objc2_app_kit::NSWindow;

    let Ok(ptr) = win.ns_window() else {
        return;
    };
    if ptr.is_null() {
        return;
    }
    // SAFETY: Tauri 保证 WebviewWindow 存活期间 ns_window 指向有效 NSWindow。
    let ns_window = unsafe { &*(ptr as *const NSWindow) };
    ns_window.setMovable(false);
    ns_window.setMovableByWindowBackground(false);
}

#[cfg(target_os = "windows")]
fn pin_window_movable_now(win: &WebviewWindow) {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        HTCAPTION, SC_MOVE, WM_NCLBUTTONDOWN, WM_SYSCOMMAND,
    };

    let Ok(hwnd) = win.hwnd() else {
        return;
    };
    if hwnd.0.is_null() {
        return;
    }

    /// 与 macOS setMovable(false) 对齐：拦系统移动，保留缩放。
    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _subclass_id: usize,
        _ref_data: usize,
    ) -> LRESULT {
        match msg {
            WM_SYSCOMMAND => {
                // SC_* 命令码在低位，需掩掉修饰位
                if wparam.0 & 0xFFF0 == SC_MOVE as usize {
                    return LRESULT(0);
                }
            }
            WM_NCLBUTTONDOWN => {
                // 点原生标题栏空白：不启动拖移
                if wparam.0 == HTCAPTION as usize {
                    return LRESULT(0);
                }
            }
            _ => {}
        }
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    // 固定 subclass id；重复调用会更新同一钩子，不会叠多层
    const SUBCLASS_ID: usize = 0x5045_544A; // PETJ
    unsafe {
        let _ = SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0);
    }
}

/// 尽量清空悬浮球窗口/WebView 系统背景与阴影，避免透明失败时露出方底。
/// Windows / macOS 分路径，互不影响。
pub fn prepare_orb_window(orb: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let _ = orb.set_shadow(false);
        let _ = clear_macos_orb_background(orb);
    }

    #[cfg(target_os = "windows")]
    {
        let _ = prepare_windows_orb_window(orb);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = orb.set_shadow(false);
    }
}

#[cfg(target_os = "macos")]
fn clear_macos_orb_background(orb: &WebviewWindow) -> Result<(), String> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSColor;
    use objc2_foundation::{NSNumber, NSString};

    // 1) NSWindow：清空底色并关系统阴影
    let ns_window = orb.ns_window().map_err(|err| err.to_string())? as *mut AnyObject;
    if ns_window.is_null() {
        return Err("ns_window is null".into());
    }

    unsafe {
        let clear = NSColor::clearColor();
        let _: () = msg_send![ns_window, setOpaque: false];
        let _: () = msg_send![ns_window, setBackgroundColor: &*clear];
        let _: () = msg_send![ns_window, setHasShadow: false];
        let _: () = msg_send![ns_window, invalidateShadow];
    }

    // 2) WKWebView：关闭默认绘制背景（否则常显一块方底）
    orb.with_webview(|webview| {
        unsafe {
            let wk = webview.inner() as *mut AnyObject;
            if wk.is_null() {
                return;
            }
            let clear = NSColor::clearColor();
            let no = NSNumber::numberWithBool(false);
            let key = NSString::from_str("drawsBackground");
            let _: () = msg_send![wk, setOpaque: false];
            let _: () = msg_send![wk, setBackgroundColor: &*clear];
            let _: () = msg_send![wk, setValue: &*no, forKey: &*key];

            // 同步清 layer 背景
            let layer: *mut AnyObject = msg_send![wk, layer];
            if !layer.is_null() {
                let cg: *mut AnyObject = msg_send![&*clear, CGColor];
                let _: () = msg_send![layer, setBackgroundColor: cg];
                let _: () = msg_send![layer, setOpaque: false];
            }
        }
    })
    .map_err(|err| err.to_string())?;

    Ok(())
}

/// Windows：清透明底并确认置顶。
/// 注意：不要 set_shadow(true)——Win 上会给无边框窗加 1px 白边/圆角方框，圆球外形会被破坏。
#[cfg(target_os = "windows")]
fn prepare_windows_orb_window(orb: &WebviewWindow) -> Result<(), String> {
    let _ = orb.set_shadow(false);
    // 窗口层 + WebView 层背景设为全透明（Windows 上仅 alpha=0 才会透）
    let _ = orb.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
    let _ = orb.set_always_on_top(true);
    let _ = orb.set_skip_taskbar(true);
    Ok(())
}
