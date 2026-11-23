//! 显示器可用区域（work area）几何：避开 macOS 菜单栏 / Windows 任务栏。

use tauri::{Monitor, WebviewWindow};

/// 悬浮球收起态边长（逻辑像素）。
pub const ORB_IDLE: f64 = 56.0;
/// 松手贴边吸附阈值（设计：距 workArea 边 < 12px）。
pub const EDGE_SNAP_PX: f64 = 12.0;

/// 当前屏 work area → 逻辑坐标 `(x, y, w, h)`。
pub fn logical_work_area(monitor: &Monitor, scale: f64) -> (f64, f64, f64, f64) {
    let area = monitor.work_area();
    let scale = scale.max(0.01);
    (
        f64::from(area.position.x) / scale,
        f64::from(area.position.y) / scale,
        f64::from(area.size.width) / scale,
        f64::from(area.size.height) / scale,
    )
}

/// 把收起态左上角夹进 work area，并在阈值内吸附到边。
pub fn clamp_and_snap_orb(x: f64, y: f64, mon_x: f64, mon_y: f64, mon_w: f64, mon_h: f64) -> (f64, f64) {
    let max_x = (mon_x + mon_w - ORB_IDLE).max(mon_x);
    let max_y = (mon_y + mon_h - ORB_IDLE).max(mon_y);
    let mut nx = x.clamp(mon_x, max_x);
    let mut ny = y.clamp(mon_y, max_y);

    if (nx - mon_x).abs() <= EDGE_SNAP_PX {
        nx = mon_x;
    } else if (max_x - nx).abs() <= EDGE_SNAP_PX {
        nx = max_x;
    }
    if (ny - mon_y).abs() <= EDGE_SNAP_PX {
        ny = mon_y;
    } else if (max_y - ny).abs() <= EDGE_SNAP_PX {
        ny = max_y;
    }
    (nx, ny)
}

/// 用窗口当前屏的 work area 做夹取 + 贴边吸附。
pub fn snap_orb_on_window(orb: &WebviewWindow, x: f64, y: f64) -> (f64, f64) {
    let Ok(scale) = orb.scale_factor() else {
        return (x, y);
    };
    let scale: f64 = scale.into();
    let Ok(Some(monitor)) = orb.current_monitor() else {
        return (x, y);
    };
    let (mon_x, mon_y, mon_w, mon_h) = logical_work_area(&monitor, scale);
    clamp_and_snap_orb(x, y, mon_x, mon_y, mon_w, mon_h)
}
