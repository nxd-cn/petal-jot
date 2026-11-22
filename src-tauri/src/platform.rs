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

/// Windows：透明无边框窗需在创建后触发 DWM 合成，并清 WebView 底色，否则圆球常整窗不可见。
#[cfg(target_os = "windows")]
fn prepare_windows_orb_window(orb: &WebviewWindow) -> Result<(), String> {
    // wry/tao 推荐：创建时 shadow=false，创建后再打开一次，触发 DWM 清表面并正确合成透明像素。
    // macOS 不走此路径，保持无系统阴影的圆形悬浮球。
    let _ = orb.set_shadow(true);

    // 窗口层 + WebView 层背景设为全透明（Windows 上仅 alpha=0 才会透）
    let _ = orb.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));

    // 置顶 / 不进任务栏再确认（部分机型启动时序会丢）
    let _ = orb.set_always_on_top(true);
    let _ = orb.set_skip_taskbar(true);

    Ok(())
}
