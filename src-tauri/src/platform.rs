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
pub fn prepare_orb_window(orb: &WebviewWindow) {
    let _ = orb.set_shadow(false);

    #[cfg(target_os = "macos")]
    {
        let _ = clear_macos_orb_background(orb);
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
