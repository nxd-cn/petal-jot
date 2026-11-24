use serde::{Deserialize, Serialize};

use crate::monitor_geom::ORB_IDLE;

/// 布局用占位（与前端 constants 一致；瓣间距按此估算）。
const PETAL_WIDTH: f64 = 104.0;
const PETAL_HEIGHT: f64 = 112.0;
/// 真实瓣片 SVG（前端 petalPath：96×118）。
const BLADE_W: f64 = 96.0;
const BLADE_H: f64 = 118.0;
/// 瓣片沿自身轴线的最大伸出（尖端到花瓣中心），靠边判定用。
const BLADE_SEMI_AXIS: f64 = 56.0;
/// 水滴轮廓凸包采样点（轴向 s 向外、横向 c；由 petalPath 贝塞尔采样 + 镜像而来，
/// 尖端在 −s、最宽 ±42 在 s≈+36、底部圆帽到 +56）。
/// 靠边校验按它算支撑半径，比旋转外接矩形小 ~20px/侧。
const BLADE_HULL: [(f64, f64); 13] = [
    (-56.0, 0.0),
    (-39.4, 10.5),
    (-17.5, 24.0),
    (8.1, 36.0),
    (36.0, 42.0),
    (49.5, 30.0),
    (56.0, 0.0),
    (49.5, -30.0),
    (36.0, -42.0),
    (8.1, -36.0),
    (-17.5, -24.0),
    (-39.4, -10.5),
    (0.0, 0.0),
];
/// 球到花瓣中心的最小净空（避免盖住圆球）。
const CLEARANCE_MIN: f64 = ORB_IDLE / 2.0 + 14.0 + PETAL_HEIGHT / 2.0;
/// work area 内边距：仅留极小余量。
const SCREEN_PAD: f64 = 2.0;
/// 展开窗外扩：含 macOS drop-shadow 模糊，避免最外一圈被裁。
const FRAME_PAD: f64 = 12.0;
const MIN_PETALS: u32 = 1;
/// 花瓣中心距允许的最大重叠（先收紧间距，再考虑拉远半径）。
const MAX_OVERLAP_RATIO: f64 = 0.30;
/// 为保持贴球距离，紧凑半径下允许更挤一点，避免靠边时半径被拉大。
const COMPACT_OVERLAP_MAX: f64 = 0.48;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FanLayoutDto {
    pub fan_start_deg: f64,
    pub fan_arc_deg: f64,
    pub max_petals: u32,
    pub radius: f64,
    pub direction: String,
    pub center_x: f64,
    pub center_y: f64,
    pub margin_left: f64,
    pub margin_right: f64,
    pub margin_top: f64,
    pub margin_bottom: f64,
    /// 球心在展开窗内的局部坐标（保持屏幕位置不变）
    pub orb_local_x: f64,
    pub orb_local_y: f64,
    pub window_width: f64,
    pub window_height: f64,
    pub window_x: f64,
    pub window_y: f64,
}

#[derive(Clone, Copy)]
struct Candidate {
    direction: &'static str,
    fan_start_deg: f64,
    fan_arc_deg: f64,
    space: f64,
    corner: bool,
}

/// `overlap_ratio`：0=边缘相接不重叠。
fn min_petal_angle_deg(radius: f64, overlap_ratio: f64) -> f64 {
    let overlap = overlap_ratio.clamp(0.0, COMPACT_OVERLAP_MAX);
    let min_center_dist = PETAL_WIDTH * (1.0 - overlap).max(0.2);
    let half_chord = min_center_dist / 2.0;
    let ratio = (half_chord / radius.max(1.0)).min(0.95);
    2.0 * ratio.asin().to_degrees()
}

/// 花瓣角 `angle_deg` 的轴对齐半宽高：按真实水滴轮廓（凸包支撑）计算，
/// 而非旋转外接矩形——外接盒四角是空的，斜向花瓣比实际形状虚胖 ~20px/侧，
/// 曾导致靠边时明明放得下的位置被判出界、扇形被迫收窄留大空档。
fn rotated_blade_half_extents(angle_deg: f64) -> (f64, f64) {
    let rad = angle_deg.to_radians();
    // 花瓣轴向外（宽端朝外、尖端朝球）；形状对横向镜像对称，v 取向不影响结果
    let ux = rad.cos();
    let uy = rad.sin();
    let mut hw = 0.0_f64;
    let mut hh = 0.0_f64;
    for &(s, c) in &BLADE_HULL {
        let wx = s * ux - c * uy;
        let wy = s * uy + c * ux;
        hw = hw.max(wx.abs());
        hh = hh.max(wy.abs());
    }
    (hw + FRAME_PAD, hh + FRAME_PAD)
}

fn petals_fit_on_screen(
    count: u32,
    fan_start_deg: f64,
    fan_arc_deg: f64,
    center_x: f64,
    center_y: f64,
    radius: f64,
    mon_x: f64,
    mon_y: f64,
    mon_w: f64,
    mon_h: f64,
) -> bool {
    if count == 0 {
        return true;
    }
    for index in 0..count {
        let angle = fan_start_deg + (fan_arc_deg * (f64::from(index) + 0.5)) / f64::from(count);
        let rad = angle.to_radians();
        let px = center_x + rad.cos() * radius;
        let py = center_y + rad.sin() * radius;
        let (hw, hh) = rotated_blade_half_extents(angle);
        if px - hw < mon_x + SCREEN_PAD
            || px + hw > mon_x + mon_w - SCREEN_PAD
            || py - hh < mon_y + SCREEN_PAD
            || py + hh > mon_y + mon_h - SCREEN_PAD
        {
            return false;
        }
    }
    true
}

/// 半径恒为紧凑值（花瓣贴球、任何位置观感一致）；放不下就提高重叠、再减瓣数，绝不拉远。
/// 返回 (数量, 半径)。
fn fit_petals(
    desired: u32,
    fan_start_deg: f64,
    fan_arc_deg: f64,
    center_x: f64,
    center_y: f64,
    mon_x: f64,
    mon_y: f64,
    mon_w: f64,
    mon_h: f64,
) -> (u32, f64) {
    let desired = desired.max(MIN_PETALS);
    let overlap_steps = [0.0_f64, 0.10, 0.20, MAX_OVERLAP_RATIO, COMPACT_OVERLAP_MAX];
    let compact_r = CLEARANCE_MIN;

    // 1) 固定半径，提高重叠以塞下期望数量
    for &overlap in &overlap_steps {
        let by_angle =
            ((fan_arc_deg / min_petal_angle_deg(compact_r, overlap)).floor() as u32).max(MIN_PETALS);
        if by_angle >= desired
            && petals_fit_on_screen(
                desired,
                fan_start_deg,
                fan_arc_deg,
                center_x,
                center_y,
                compact_r,
                mon_x,
                mon_y,
                mon_w,
                mon_h,
            )
        {
            return (desired, compact_r);
        }
    }

    // 2) 塞不下就减瓣数（半径保持不变）
    let by_angle = ((fan_arc_deg / min_petal_angle_deg(compact_r, COMPACT_OVERLAP_MAX)).floor()
        as u32)
        .max(MIN_PETALS);
    let mut count = desired.min(by_angle);
    while count >= MIN_PETALS {
        if petals_fit_on_screen(
            count,
            fan_start_deg,
            fan_arc_deg,
            center_x,
            center_y,
            compact_r,
            mon_x,
            mon_y,
            mon_w,
            mon_h,
        ) {
            return (count, compact_r);
        }
        if count == MIN_PETALS {
            break;
        }
        count -= 1;
    }

    (MIN_PETALS, compact_r)
}

fn candidates(left: f64, right: f64, top: f64, bottom: f64) -> [Candidate; 8] {
    [
        Candidate {
            direction: "down",
            fan_start_deg: 0.0,
            fan_arc_deg: 180.0,
            space: bottom,
            corner: false,
        },
        Candidate {
            direction: "up",
            fan_start_deg: -180.0,
            fan_arc_deg: 180.0,
            space: top,
            corner: false,
        },
        Candidate {
            direction: "right",
            fan_start_deg: -90.0,
            fan_arc_deg: 180.0,
            space: right,
            corner: false,
        },
        Candidate {
            direction: "left",
            fan_start_deg: 90.0,
            fan_arc_deg: 180.0,
            space: left,
            corner: false,
        },
        Candidate {
            direction: "se",
            fan_start_deg: 0.0,
            fan_arc_deg: 90.0,
            space: right.min(bottom),
            corner: true,
        },
        Candidate {
            direction: "sw",
            fan_start_deg: 90.0,
            fan_arc_deg: 90.0,
            space: left.min(bottom),
            corner: true,
        },
        Candidate {
            direction: "ne",
            fan_start_deg: -90.0,
            fan_arc_deg: 90.0,
            space: right.min(top),
            corner: true,
        },
        Candidate {
            direction: "nw",
            fan_start_deg: -180.0,
            fan_arc_deg: 90.0,
            space: left.min(top),
            corner: true,
        },
    ]
}

/// 花瓣 + 圆球在屏幕坐标下的外接框（按旋转后瓣片 + 阴影）。
fn content_bounds_on_screen(
    screen_orb_cx: f64,
    screen_orb_cy: f64,
    radius: f64,
    fan_start_deg: f64,
    fan_arc_deg: f64,
    petal_count: u32,
) -> (f64, f64, f64, f64) {
    let half_orb = ORB_IDLE / 2.0;
    let mut left = screen_orb_cx - half_orb;
    let mut right = screen_orb_cx + half_orb;
    let mut top = screen_orb_cy - half_orb;
    let mut bottom = screen_orb_cy + half_orb;

    if petal_count == 0 {
        return (left, right, top, bottom);
    }
    let n = f64::from(petal_count);
    for index in 0..petal_count {
        let angle = fan_start_deg + (fan_arc_deg * (f64::from(index) + 0.5)) / n;
        let rad = angle.to_radians();
        let px = screen_orb_cx + rad.cos() * radius;
        let py = screen_orb_cy + rad.sin() * radius;
        let (hw, hh) = rotated_blade_half_extents(angle);
        left = left.min(px - hw);
        right = right.max(px + hw);
        top = top.min(py - hh);
        bottom = bottom.max(py + hh);
    }
    (left, right, top, bottom)
}

/// 按真实花瓣外接框扩窗；球靠近某一侧时，把窗铺到该侧 work area 边，
/// 吃掉「球与屏边之间的空隙」，避免扇形掠过空隙时被 overflow 截断。
pub fn anchor_expanded_frame(
    screen_orb_cx: f64,
    screen_orb_cy: f64,
    radius: f64,
    fan_start_deg: f64,
    fan_arc_deg: f64,
    petal_count: u32,
    mon_x: f64,
    mon_y: f64,
    mon_w: f64,
    mon_h: f64,
) -> (f64, f64, f64, f64, f64, f64) {
    let half_orb = ORB_IDLE / 2.0;
    let mon_right = mon_x + mon_w;
    let mon_bottom = mon_y + mon_h;
    // 最坏旋转外接半对角 + 半径，用于判断是否贴边铺满
    let petal_reach =
        radius + (BLADE_W * BLADE_W + BLADE_H * BLADE_H).sqrt() * 0.5 + FRAME_PAD;

    let (mut left, mut right, mut top, mut bottom) = content_bounds_on_screen(
        screen_orb_cx,
        screen_orb_cy,
        radius,
        fan_start_deg,
        fan_arc_deg,
        petal_count,
    );

    // 球离某边不足一瓣伸距：窗直接铺到该边，不再在球外侧留一条同宽裁切带
    if screen_orb_cx - mon_x <= petal_reach {
        left = mon_x;
    }
    if mon_right - screen_orb_cx <= petal_reach {
        right = mon_right;
    }
    if screen_orb_cy - mon_y <= petal_reach {
        top = mon_y;
    }
    if mon_bottom - screen_orb_cy <= petal_reach {
        bottom = mon_bottom;
    }

    let mut win_x = left.max(mon_x);
    let mut win_y = top.max(mon_y);
    let mut win_right = right.min(mon_right);
    let mut win_bottom = bottom.min(mon_bottom);

    // 整颗球必须在窗内，球心屏幕坐标不变
    win_x = win_x.min(screen_orb_cx - half_orb).max(mon_x);
    win_y = win_y.min(screen_orb_cy - half_orb).max(mon_y);
    win_right = win_right.max(screen_orb_cx + half_orb).min(mon_right);
    win_bottom = win_bottom.max(screen_orb_cy + half_orb).min(mon_bottom);

    if win_right < win_x + ORB_IDLE {
        win_right = (win_x + ORB_IDLE).min(mon_right);
        win_x = (win_right - ORB_IDLE).max(mon_x);
    }
    if win_bottom < win_y + ORB_IDLE {
        win_bottom = (win_y + ORB_IDLE).min(mon_bottom);
        win_y = (win_bottom - ORB_IDLE).max(mon_y);
    }

    // ceil 避免亚像素尺寸导致最外一圈被裁 1px
    let win_w = (win_right - win_x).max(ORB_IDLE).ceil();
    let win_h = (win_bottom - win_y).max(ORB_IDLE).ceil();
    let orb_local_x = screen_orb_cx - win_x;
    let orb_local_y = screen_orb_cy - win_y;
    (orb_local_x, orb_local_y, win_w, win_h, win_x, win_y)
}

/// 瓣数优先；同瓣数时优先更小半径（正常不会出现，半径已固定），再取更大扇角。
fn is_better_layout(next: &FanLayoutDto, prev: &FanLayoutDto) -> bool {
    if next.max_petals != prev.max_petals {
        return next.max_petals > prev.max_petals;
    }
    if (next.radius - prev.radius).abs() > 0.5 {
        return next.radius < prev.radius;
    }
    next.fan_arc_deg > prev.fan_arc_deg
}

fn make_layout(
    direction: &str,
    fan_start: f64,
    arc: f64,
    max_petals: u32,
    radius: f64,
    center_x: f64,
    center_y: f64,
    mon_x: f64,
    mon_y: f64,
    mon_w: f64,
    mon_h: f64,
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
) -> FanLayoutDto {
    let (orb_local_x, orb_local_y, window_width, window_height, window_x, window_y) =
        anchor_expanded_frame(
            center_x,
            center_y,
            radius,
            fan_start,
            arc,
            max_petals,
            mon_x,
            mon_y,
            mon_w,
            mon_h,
        );
    FanLayoutDto {
        fan_start_deg: fan_start,
        fan_arc_deg: arc,
        max_petals,
        radius,
        direction: direction.to_string(),
        center_x,
        center_y,
        margin_left: left,
        margin_right: right,
        margin_top: top,
        margin_bottom: bottom,
        orb_local_x,
        orb_local_y,
        window_width,
        window_height,
        window_x,
        window_y,
    }
}

fn try_layout(
    direction: &str,
    fan_start: f64,
    arc: f64,
    desired_count: u32,
    center_x: f64,
    center_y: f64,
    mon_x: f64,
    mon_y: f64,
    mon_w: f64,
    mon_h: f64,
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
) -> FanLayoutDto {
    let (max_petals, radius) = fit_petals(
        desired_count,
        fan_start,
        arc,
        center_x,
        center_y,
        mon_x,
        mon_y,
        mon_w,
        mon_h,
    );
    make_layout(
        direction,
        fan_start,
        arc,
        max_petals,
        radius,
        center_x,
        center_y,
        mon_x,
        mon_y,
        mon_w,
        mon_h,
        left,
        right,
        top,
        bottom,
    )
}

/// 不靠边：360° 铺满；先用紧凑半径 + 最多 30% 重叠，不因瓣数变多先拉远。
fn try_around_layout(
    desired_count: u32,
    center_x: f64,
    center_y: f64,
    mon_x: f64,
    mon_y: f64,
    mon_w: f64,
    mon_h: f64,
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
) -> Option<FanLayoutDto> {
    let compact_r = CLEARANCE_MIN;
    let need = compact_r + BLADE_SEMI_AXIS + FRAME_PAD + SCREEN_PAD;
    if left < need || right < need || top < need || bottom < need {
        return None;
    }

    let layout = try_layout(
        "around",
        -135.0, // 4 瓣时对应上下左右
        360.0,
        desired_count,
        center_x,
        center_y,
        mon_x,
        mon_y,
        mon_w,
        mon_h,
        left,
        right,
        top,
        bottom,
    );
    if layout.max_petals >= 1 {
        Some(layout)
    } else {
        None
    }
}

/// 根据球心与显示器边距选择展开方式：
/// - 空间够 → 环绕 360°
/// - 靠边 → 扇形铺满开阔侧；放不下就收窄扇角 / 减瓣数，半径始终固定
pub fn resolve_adaptive_fan(
    center_x: f64,
    center_y: f64,
    mon_x: f64,
    mon_y: f64,
    mon_w: f64,
    mon_h: f64,
    desired_count: u32,
) -> FanLayoutDto {
    let left = (center_x - mon_x).max(0.0);
    let right = (mon_x + mon_w - center_x).max(0.0);
    let top = (center_y - mon_y).max(0.0);
    let bottom = (mon_y + mon_h - center_y).max(0.0);

    let around = try_around_layout(
        desired_count,
        center_x,
        center_y,
        mon_x,
        mon_y,
        mon_w,
        mon_h,
        left,
        right,
        top,
        bottom,
    );
    // 环绕能放下全部瓣数才直接采用；放不下时先记下，
    // 与靠边扇形候选按「瓣数优先」比较，避免贴边过渡带只剩 1~3 瓣。
    if let Some(layout) = &around {
        if layout.max_petals >= desired_count {
            return layout.clone();
        }
    }

    // 贴边判定：按真实轮廓最坏支撑（轴向瓣片指向屏幕边）判断
    let around_need = CLEARANCE_MIN + BLADE_SEMI_AXIS + FRAME_PAD + SCREEN_PAD;
    let near_left = left < around_need;
    let near_right = right < around_need;
    let near_top = top < around_need;
    let near_bottom = bottom < around_need;

    let all = candidates(left, right, top, bottom);

    let forced_dir = if near_top && near_left {
        Some("se")
    } else if near_top && near_right {
        Some("sw")
    } else if near_bottom && near_left {
        Some("ne")
    } else if near_bottom && near_right {
        Some("nw")
    } else if near_top {
        Some("down")
    } else if near_bottom {
        Some("up")
    } else if near_left {
        Some("right")
    } else if near_right {
        Some("left")
    } else {
        None
    };

    let mut pool: Vec<Candidate> = if let Some(dir) = forced_dir {
        all.iter().copied().filter(|c| c.direction == dir).collect()
    } else {
        let mut halves: Vec<_> = all.iter().copied().filter(|c| !c.corner).collect();
        halves.sort_by(|a, b| {
            b.space
                .partial_cmp(&a.space)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        halves
    };

    if pool.is_empty() {
        pool.push(all[0]);
    }

    let mut best: Option<FanLayoutDto> = None;

    for candidate in &pool {
        // 贴边：先试更大扇角，便于在固定半径下排开瓣数；
        // 贴角：也逐档收窄扇角，把花瓣收进实际可用的角度区间（半径不变，能多放几瓣）
        let arcs: Vec<f64> = if candidate.corner {
            vec![
                candidate.fan_arc_deg,
                75.0,
                60.0,
                45.0,
                30.0,
            ]
        } else {
            vec![330.0, 300.0, 270.0, 240.0, 210.0, 180.0, 150.0, 120.0, 90.0]
        };
        let mid = candidate.fan_start_deg + candidate.fan_arc_deg / 2.0;
        for arc in arcs {
            let fan_start = mid - arc / 2.0;
            let layout = try_layout(
                candidate.direction,
                fan_start,
                arc,
                desired_count,
                center_x,
                center_y,
                mon_x,
                mon_y,
                mon_w,
                mon_h,
                left,
                right,
                top,
                bottom,
            );
            if best.as_ref().map(|prev| is_better_layout(&layout, prev)).unwrap_or(true) {
                best = Some(layout);
            }
        }
    }

    for candidate in &all {
        let mid = candidate.fan_start_deg + candidate.fan_arc_deg / 2.0;
        let fan_start = mid - candidate.fan_arc_deg / 2.0;
        let layout = try_layout(
            candidate.direction,
            fan_start,
            candidate.fan_arc_deg,
            desired_count,
            center_x,
            center_y,
            mon_x,
            mon_y,
            mon_w,
            mon_h,
            left,
            right,
            top,
            bottom,
        );
        if best.as_ref().map(|prev| is_better_layout(&layout, prev)).unwrap_or(true) {
            best = Some(layout);
        }
    }

    // 环绕放不下全部瓣数时，与最佳扇形候选比较（瓣数优先），谁放得多用谁。
    if let Some(around_layout) = around {
        if best
            .as_ref()
            .map(|prev| is_better_layout(&around_layout, prev))
            .unwrap_or(true)
        {
            best = Some(around_layout);
        }
    }

    let layout = best.unwrap_or_else(|| {
        make_layout(
            "down",
            0.0,
            180.0,
            MIN_PETALS,
            CLEARANCE_MIN,
            center_x,
            center_y,
            mon_x,
            mon_y,
            mon_w,
            mon_h,
            left,
            right,
            top,
            bottom,
        )
    });

    layout
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 半径必须与居中时完全一致（用户要求：花瓣半径不随球位置变化）。
    fn assert_fixed_radius(layout: &FanLayoutDto) {
        assert_eq!(layout.radius, CLEARANCE_MIN);
    }

    /// 过渡带复现：球距底边 ~160px（>156px 预检门槛，但 < 斜向花瓣实际所需净空）。
    /// 修复前：环绕布局被直接采用，瓣数退化到 1~3；
    /// 修复后：应与靠边扇形比较，6 瓣全部放下。
    #[test]
    fn transitional_band_prefers_fan_with_more_petals() {
        let mon_x = 0.0;
        let mon_y = 0.0;
        let mon_w = 1920.0;
        let mon_h = 1080.0;
        // 距底边 ~160px，其余三侧留足净空
        let center_x = mon_w / 2.0;
        let center_y = mon_h - 160.0;

        let layout = resolve_adaptive_fan(
            center_x, center_y, mon_x, mon_y, mon_w, mon_h, 6,
        );
        assert_eq!(
            layout.max_petals, 6,
            "过渡带位置应放下全部 6 瓣（direction={}）",
            layout.direction,
        );
        assert_fixed_radius(&layout);
    }

    /// 居中位置：环绕布局应保持原优先行为，6 瓣全出。
    #[test]
    fn centered_keeps_around_layout() {
        let layout = resolve_adaptive_fan(
            960.0, 540.0, 0.0, 0.0, 1920.0, 1080.0, 6,
        );
        assert_eq!(layout.max_petals, 6);
        assert_eq!(layout.direction, "around");
        assert_fixed_radius(&layout);
    }

    /// 真正贴角：半径不变的前提下靠收窄扇角，至少应能放下 2 瓣（修复前只有 1 瓣）。
    #[test]
    fn near_corner_keeps_radius_and_fits_two() {
        let layout = resolve_adaptive_fan(
            40.0, 40.0, 0.0, 0.0, 1920.0, 1080.0, 6,
        );
        assert_fixed_radius(&layout);
        assert!(
            layout.max_petals >= 2,
            "贴角应收窄扇角放下至少 2 瓣，实际 {}",
            layout.max_petals,
        );
    }

    /// 截屏复现：球距右边 ~140px，6 瓣曾被挤进 240° 弧、右侧留 120° 空档
    /// （旋转外接盒校验过保守）。按真实轮廓校验后应铺开 ≥270°。
    #[test]
    fn near_right_edge_fans_wider_than_before() {
        let mon_w = 1920.0;
        let mon_h = 1080.0;
        let layout = resolve_adaptive_fan(
            mon_w - 140.0, 540.0, 0.0, 0.0, mon_w, mon_h, 6,
        );
        assert_eq!(layout.max_petals, 6);
        assert_fixed_radius(&layout);
        assert!(
            layout.fan_arc_deg >= 270.0,
            "距右 140px 应铺开 ≥270°，实际 {}°",
            layout.fan_arc_deg,
        );
    }

    /// 全屏网格扫描：任何位置半径恒定；瓣数可以少，但不能一张花瓣都没有。
    #[test]
    fn sweep_positions_radius_constant_and_never_empty() {
        let mon_w = 1440.0; // 小屏（如笔记本）更容易触发空间不足
        let mon_h = 900.0;
        for cx in [28.0, 60.0, 120.0, 300.0, 720.0, 1140.0, 1320.0, 1412.0] {
            for cy in [28.0, 60.0, 120.0, 300.0, 450.0, 600.0, 780.0, 840.0, 872.0] {
                let layout = resolve_adaptive_fan(
                    cx, cy, 0.0, 0.0, mon_w, mon_h, 6,
                );
                assert_fixed_radius(&layout);
                assert!(
                    layout.max_petals >= 1,
                    "位置 ({cx},{cy}) 一瓣都放不下",
                );
            }
        }
    }
}
