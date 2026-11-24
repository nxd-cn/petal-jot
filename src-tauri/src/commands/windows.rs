use crate::db;
use crate::error::{AppError, AppResult};
use crate::fan::{resolve_adaptive_fan, FanLayoutDto};
use crate::models::EditorOpenPayload;
use crate::monitor_geom::{logical_work_area, snap_orb_on_window, ORB_IDLE};
use crate::platform;
use crate::state::AppState;
use tauri::LogicalPosition;
use tauri::LogicalSize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

fn orb_window(app: &AppHandle) -> AppResult<WebviewWindow> {
    app.get_webview_window("orb")
        .ok_or_else(|| crate::error::AppError::Message("orb window missing".into()))
}

fn editor_window(app: &AppHandle) -> AppResult<WebviewWindow> {
    app.get_webview_window("editor")
        .ok_or_else(|| crate::error::AppError::Message("editor window missing".into()))
}

fn editor_label_for_note(id: &str) -> String {
    format!("editor-{id}")
}

fn count_editor_windows(app: &AppHandle) -> usize {
    app.webview_windows()
        .keys()
        .filter(|label| *label == "editor" || label.starts_with("editor-"))
        .count()
}

/// macOS：隐藏标题文字并使用 Overlay 标题栏；其他平台保持默认装饰。
#[cfg(target_os = "macos")]
fn with_overlay_titlebar<R: tauri::Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'_, R, M>,
) -> WebviewWindowBuilder<'_, R, M> {
    builder
        .hidden_title(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
}

#[cfg(not(target_os = "macos"))]
fn with_overlay_titlebar<R: tauri::Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'_, R, M>,
) -> WebviewWindowBuilder<'_, R, M> {
    builder
}

/// 创建便签专属编辑窗（花瓣点开不同便签时多开）。
fn create_note_editor_window(app: &AppHandle, note_id: &str) -> AppResult<WebviewWindow> {
    let label = editor_label_for_note(note_id);
    let url = format!("editor.html?id={}", urlencoding_lite(note_id));
    let offset = (count_editor_windows(app) as f64) * 28.0;
    // dragDropEnabled=false：关掉 Tauri 内置拖放，才能用前端 HTML5 拖入图片（尤其 Windows）
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("PetalJot")
        .inner_size(480.0, 640.0)
        .resizable(true)
        .visible(false)
        .always_on_top(true)
        .disable_drag_drop_handler();
    let win = with_overlay_titlebar(builder)
        .build()
        .map_err(|err| AppError::Message(format!("create editor window failed: {err}")))?;
    let _ = win.set_position(LogicalPosition::new(120.0 + offset, 80.0 + offset));
    Ok(win)
}

/// 仅编码 query 安全字符，便签 id 为 uuid 时基本原样返回。
fn urlencoding_lite(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => out.push(ch),
            _ => {
                for b in ch.to_string().as_bytes() {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
        }
    }
    out
}

fn focus_editor_window(win: &WebviewWindow) -> AppResult<()> {
    let _ = win.set_always_on_top(true);
    let _ = win.unminimize();
    win.show()?;
    win.set_focus()?;
    // show/focus 后再钉一次：Overlay 窗创建后偶发仍可拖，正文拖选会整窗左右晃
    crate::platform::pin_window_movable(win);
    Ok(())
}

/// 设置窗关闭时隐藏而非销毁。
pub fn attach_settings_hide_on_close(app: &AppHandle, win: &WebviewWindow) {
    let handle = app.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(w) = handle.get_webview_window("settings") {
                let _ = w.hide();
            }
        }
    });
}

fn settings_window(app: &AppHandle) -> AppResult<WebviewWindow> {
    if let Some(win) = app.get_webview_window("settings") {
        return Ok(win);
    }
    // 关闭按钮默认会销毁窗口；兜底重建，避免「有时出不来」
    let builder = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("PetalJot Settings")
        .inner_size(420.0, 560.0)
        .resizable(false)
        .visible(false)
        .always_on_top(true);
    let win = with_overlay_titlebar(builder)
        .build()
        .map_err(|err| AppError::Message(format!("recreate settings window failed: {err}")))?;
    let _ = win.center();
    attach_settings_hide_on_close(app, &win);
    Ok(win)
}

fn apply_window_frame(orb: &WebviewWindow, x: f64, y: f64, w: f64, h: f64) -> AppResult<()> {
    // 先定位再改尺寸：窗口始终以最终原点增长，避免球相对屏幕跳一下。
    // set_size 在部分平台会改写原点，故结束后再钉一次位置。
    orb.set_position(LogicalPosition::new(x, y))?;
    orb.set_size(LogicalSize::new(w, h))?;
    orb.set_position(LogicalPosition::new(x, y))?;
    crate::platform::prepare_orb_window(orb);
    Ok(())
}

/// 用 settings 中的收起态坐标作为球锚点（屏幕上的球心）。
/// 显示器边界取 work area，避开菜单栏 / 任务栏。
fn anchored_orb_center(app: &AppHandle, state: &AppState) -> AppResult<(f64, f64, f64, f64, f64, f64)> {
    let settings = state.settings()?;
    let orb = orb_window(app)?;
    let scale: f64 = orb.scale_factor()?.into();
    let monitor = orb
        .current_monitor()
        .map_err(|err| AppError::Message(err.to_string()))?
        .ok_or_else(|| AppError::Message("no current monitor".into()))?;
    let (mon_x, mon_y, mon_w, mon_h) = logical_work_area(&monitor, scale);

    // 收起态左上角保存在 settings；若当前已是收起窗，也可用实时位置校准。
    let cur_pos = orb.outer_position()?;
    let cur_size = orb.outer_size()?;
    let cur_w = f64::from(cur_size.width) / scale;
    let cur_h = f64::from(cur_size.height) / scale;
    let (anchor_left, anchor_top) = if (cur_w - ORB_IDLE).abs() < 1.0 && (cur_h - ORB_IDLE).abs() < 1.0
    {
        (f64::from(cur_pos.x) / scale, f64::from(cur_pos.y) / scale)
    } else {
        (settings.orb_x, settings.orb_y)
    };

    let center_x = anchor_left + ORB_IDLE / 2.0;
    let center_y = anchor_top + ORB_IDLE / 2.0;
    Ok((center_x, center_y, mon_x, mon_y, mon_w, mon_h))
}

/// 内部：切换悬浮球显隐并持久化。
pub fn set_orb_visible_inner(
    app: &AppHandle,
    state: &AppState,
    visible: bool,
) -> AppResult<()> {
    let mut settings = state.settings()?;
    settings.orb_visible = visible;
    state.with_db(|conn| db::save_settings(conn, &settings))?;
    let orb = orb_window(app)?;
    if visible {
        orb.show()?;
    } else {
        orb.hide()?;
    }
    app.emit("orb://visibility", visible)?;
    Ok(())
}

/// 内部：打开编辑器。
/// - 编辑已有便签：按 noteId 复用窗口，不同便签多开
/// - 新建：走主 editor 窗
pub fn editor_open_inner(app: &AppHandle, payload: EditorOpenPayload) -> AppResult<()> {
    platform::activate_for_ui();

    if payload.mode == "edit" {
        if let Some(id) = payload.id.as_ref().filter(|v| !v.trim().is_empty()) {
            let label = editor_label_for_note(id);
            let win = if let Some(existing) = app.get_webview_window(&label) {
                existing
            } else {
                // Windows：须在 async command / 独立线程中 build，否则会死锁
                create_note_editor_window(app, id)?
            };
            focus_editor_window(&win)?;
            // URL/label 会自启加载；再广播一次，兼容 Windows 首屏时序
            let _ = win.emit("editor://open", &payload);
            return Ok(());
        }
    }

    let editor = editor_window(app)?;
    focus_editor_window(&editor)?;
    let _ = editor.emit("editor://open", &payload);
    Ok(())
}

/// 内部：打开设置窗（置顶于主界面之上、激活、显示并聚焦）。
pub fn settings_open_inner(app: &AppHandle) -> AppResult<()> {
    platform::activate_for_ui();
    let win = settings_window(app)?;
    let _ = win.set_always_on_top(true);
    let _ = win.unminimize();
    win.show()?;
    win.set_focus()?;
    Ok(())
}

fn search_window(app: &AppHandle) -> AppResult<WebviewWindow> {
    app.get_webview_window("search")
        .ok_or_else(|| AppError::Message("search window missing".into()))
}

/// 打开全屏居中搜索层（覆盖当前显示器）。
pub fn search_open_inner(app: &AppHandle) -> AppResult<()> {
    platform::activate_for_ui();
    let win = search_window(app)?;
    // 优先跟随编辑窗/悬浮球所在屏，否则主屏
    let monitor = editor_window(app)
        .ok()
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| orb_window(app).ok().and_then(|w| w.current_monitor().ok().flatten()))
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let scale: f64 = monitor.scale_factor();
        let pos = monitor.position();
        let size = monitor.size();
        let x = f64::from(pos.x) / scale;
        let y = f64::from(pos.y) / scale;
        let w = f64::from(size.width) / scale;
        let h = f64::from(size.height) / scale;
        let _ = win.set_position(LogicalPosition::new(x, y));
        let _ = win.set_size(LogicalSize::new(w, h));
    }
    let _ = win.set_always_on_top(true);
    let _ = win.unminimize();
    win.show()?;
    win.set_focus()?;
    Ok(())
}

/// 显示或隐藏悬浮球。
#[tauri::command]
pub fn orb_set_visible(
    visible: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<()> {
    set_orb_visible_inner(&app, &state, visible)
}

/// 持久化悬浮球位置（仅收起态 56x56 左上角）。
/// 按当前屏 work area 夹取，距边 < 12px 时吸附，避免「离边一截」或半截出屏。
#[tauri::command]
pub fn orb_set_position(
    x: f64,
    y: f64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let orb = orb_window(&app)?;
    let (sx, sy) = snap_orb_on_window(&orb, x, y);
    let mut settings = state.settings()?;
    settings.orb_x = sx;
    settings.orb_y = sy;
    state.with_db(|conn| db::save_settings(conn, &settings))?;

    // 已是收起窗则立刻挪到位；展开态由随后 collapse 按 settings 落地
    let scale: f64 = orb.scale_factor().map(Into::into).unwrap_or(1.0);
    if let Ok(size) = orb.outer_size() {
        let w = f64::from(size.width) / scale;
        let h = f64::from(size.height) / scale;
        if (w - ORB_IDLE).abs() < 1.0 && (h - ORB_IDLE).abs() < 1.0 {
            let _ = orb.set_position(LogicalPosition::new(sx, sy));
        }
    }
    Ok(())
}

/// 仅计算展开布局并写入锚点，不改窗口尺寸。
/// 前端需先按返回值把球画到 orbLocal，再调用 orb_apply_fan_frame，避免位置跳动。
#[tauri::command]
pub fn orb_expand_fan(
    desired_count: u32,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<FanLayoutDto> {
    let desired = desired_count.clamp(1, 12);
    let (center_x, center_y, mon_x, mon_y, mon_w, mon_h) = anchored_orb_center(&app, &state)?;

    let mut settings = state.settings()?;
    settings.orb_x = center_x - ORB_IDLE / 2.0;
    settings.orb_y = center_y - ORB_IDLE / 2.0;
    state.with_db(|conn| db::save_settings(conn, &settings))?;

    let layout = resolve_adaptive_fan(center_x, center_y, mon_x, mon_y, mon_w, mon_h, desired);
    Ok(layout)
}

/// 按布局真正调整展开窗（应在前端已切换到 orbLocal 坐标后调用）。
#[tauri::command]
pub fn orb_apply_fan_frame(layout: FanLayoutDto, app: AppHandle) -> AppResult<()> {
    let orb = orb_window(&app)?;
    apply_window_frame(
        &orb,
        layout.window_x,
        layout.window_y,
        layout.window_width,
        layout.window_height,
    )?;
    Ok(())
}

/// 收起花瓣：严格恢复到 settings 锚点，禁止用展开窗反推位置。
#[tauri::command]
pub fn orb_collapse_fan(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let settings = state.settings()?;
    let orb = orb_window(&app)?;
    apply_window_frame(&orb, settings.orb_x, settings.orb_y, ORB_IDLE, ORB_IDLE)?;
    Ok(())
}

/// 打开或聚焦编辑器，并派发打开载荷。
/// 必须 async：Windows 上在同步 command 里 WebviewWindowBuilder::build 会死锁。
#[tauri::command]
pub async fn editor_open(payload: EditorOpenPayload, app: AppHandle) -> AppResult<()> {
    editor_open_inner(&app, payload)
}

/// 打开设置窗（可能重建窗口，Windows 同样需要 async）。
#[tauri::command]
pub async fn settings_open(app: AppHandle) -> AppResult<()> {
    settings_open_inner(&app)
}

/// 打开全屏居中搜索层。
#[tauri::command]
pub fn search_open(app: AppHandle) -> AppResult<()> {
    search_open_inner(&app)
}

/// 悬浮球右键：弹出设置相关菜单（显隐球 / 设置 / 退出）。
#[tauri::command]
pub fn orb_show_context_menu(app: AppHandle) -> AppResult<()> {
    crate::tray::popup_orb_context_menu(&app)
}

/// 在当前窗口弹出与悬浮球右键一致的菜单（显隐球 / 设置 / 退出）。
#[tauri::command]
pub fn app_show_context_menu(window: WebviewWindow, app: AppHandle) -> AppResult<()> {
    crate::tray::popup_context_menu_on(&app, &window)
}
