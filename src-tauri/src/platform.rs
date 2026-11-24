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
/// - Windows：无边框窗没有原生拖动区，拖窗只走前端 `startDragging`；
///   若像旧版那样拦 `HTCAPTION`/`SC_MOVE`，会把 tao `startDragging`（同样投递
///   `WM_NCLBUTTONDOWN(HTCAPTION)`）一起吞掉，顶部条就拖不动了，故不再装钩子。
///
/// 必须走主线程：点花瓣走 async `editor_open`，非 UI 线程调原生 API 会崩。
pub fn pin_window_movable(win: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let win = win.clone();
        let _ = win.clone().run_on_main_thread(move || {
            pin_window_movable_now(&win);
        });
    }

    #[cfg(not(target_os = "macos"))]
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

/// 预建窗口（tauri.conf.json 里的 editor / settings）也要走平台标题栏策略：
/// - Windows：去掉原生装饰，由前端顶栏自绘导航与最小化/最大化/关闭
/// - macOS：由配置的 Overlay 标题栏处理，无需动作
pub fn prepare_custom_chrome(win: &WebviewWindow) {
    #[cfg(windows)]
    {
        // 去装饰后客户区会“长高”原标题栏那几像素，先记下设计内尺寸再回填
        let inner = win.inner_size().ok();
        let _ = win.set_decorations(false);
        if let Some(inner) = inner {
            let _ = win.set_size(tauri::Size::Physical(inner));
        }
    }

    #[cfg(not(windows))]
    {
        let _ = win;
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
