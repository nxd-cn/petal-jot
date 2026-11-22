use serde::{Deserialize, Serialize};

const ORB_IDLE: f64 = 56.0;
const PETAL_WIDTH: f64 = 104.0;
const PETAL_HEIGHT: f64 = 112.0;
/// 球到花瓣中心的最小净空（避免盖住圆球）。
const CLEARANCE_MIN: f64 = ORB_IDLE / 2.0 + 14.0 + PETAL_HEIGHT / 2.0;
const FAN_RADIUS_MAX: f64 = 200.0;
const SCREEN_PAD: f64 = 10.0;
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

/// 在扇角内均分 `count` 片、指定重叠时，刚好「挨着」所需半径。
fn radius_needed(count: u32, fan_arc_deg: f64, overlap_ratio: f64) -> f64 {
    let n = f64::from(count.max(1));
    let overlap = overlap_ratio.clamp(0.0, COMPACT_OVERLAP_MAX);
    let min_center = PETAL_WIDTH * (1.0 - overlap).max(0.2);
    let half_step = (fan_arc_deg / n / 2.0).to_radians();
    let sin_a = half_step.sin().abs().max(1e-3);
    min_center / (2.0 * sin_a)
}

fn clamp_radius(radius: f64) -> f64 {
    radius.clamp(CLEARANCE_MIN, FAN_RADIUS_MAX)
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
        let edge_slack_x = PETAL_WIDTH * 0.15;
        let edge_slack_y = PETAL_HEIGHT * 0.15;
        if px - PETAL_WIDTH / 2.0 + edge_slack_x < mon_x + SCREEN_PAD
            || px + PETAL_WIDTH / 2.0 - edge_slack_x > mon_x + mon_w - SCREEN_PAD
            || py - PETAL_HEIGHT / 2.0 + edge_slack_y < mon_y + SCREEN_PAD
            || py + PETAL_HEIGHT / 2.0 - edge_slack_y > mon_y + mon_h - SCREEN_PAD
        {
            return false;
        }
    }
    true
}

/// 优先固定最小半径（保持花瓣贴球），加大重叠 / 略减数量；实在不行再扩大半径。
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

    // 1) 固定紧凑半径，提高重叠以塞下期望数量
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

    // 2) 紧凑半径下尽量多放（宁可少瓣，也不把距离拉远）
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

    // 3) 最后才扩大半径
    let radius = clamp_radius(
        radius_needed(desired, fan_arc_deg, MAX_OVERLAP_RATIO).max(CLEARANCE_MIN),
    );
    if petals_fit_on_screen(
        desired,
        fan_start_deg,
        fan_arc_deg,
        center_x,
        center_y,
        radius,
        mon_x,
        mon_y,
        mon_w,
        mon_h,
    ) {
        let by_angle =
            ((fan_arc_deg / min_petal_angle_deg(radius, MAX_OVERLAP_RATIO)).floor() as u32)
                .max(MIN_PETALS);
        if by_angle >= desired {
            return (desired, radius);
        }
    }

    let radius = FAN_RADIUS_MAX;
    let by_angle = ((fan_arc_deg / min_petal_angle_deg(radius, MAX_OVERLAP_RATIO)).floor() as u32)
        .max(MIN_PETALS);
    let mut count = desired.min(by_angle);
    while count >= MIN_PETALS {
        if petals_fit_on_screen(
            count,
            fan_start_deg,
            fan_arc_deg,
            center_x,
            center_y,
            radius,
            mon_x,
            mon_y,
            mon_w,
            mon_h,
        ) {
            let tight =
                clamp_radius(radius_needed(count, fan_arc_deg, MAX_OVERLAP_RATIO).max(CLEARANCE_MIN));
            return (count, tight);
        }
        if count == MIN_PETALS {
            break;
        }
        count -= 1;
    }
    (MIN_PETALS, CLEARANCE_MIN)
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

/// 按展开方向把窗口「长」向空侧；若窗口超出显示器则钳位，并反推局部坐标，
/// 保证球心屏幕位置不变（避免靠边时系统挪窗导致圆球跟着漂）。
pub fn anchor_expanded_frame(
    direction: &str,
    screen_orb_cx: f64,
    screen_orb_cy: f64,
    radius: f64,
    mon_x: f64,
    mon_y: f64,
    mon_w: f64,
    mon_h: f64,
) -> (f64, f64, f64, f64, f64, f64) {
    let reach = radius + PETAL_WIDTH.max(PETAL_HEIGHT) / 2.0 + 20.0;
    let side = radius + PETAL_WIDTH / 2.0 + 20.0;
    let half_orb = ORB_IDLE / 2.0;

    let (ideal_local_x, ideal_local_y, win_w, win_h) = match direction {
        "around" | "around270" => {
            let win_w = (side * 2.0).ceil();
            let win_h = (side * 2.0).ceil();
            (win_w / 2.0, win_h / 2.0, win_w, win_h)
        }
        "up" => {
            let win_w = (side * 2.0).ceil();
            let win_h = (half_orb + reach).ceil();
            (win_w / 2.0, win_h - half_orb, win_w, win_h)
        }
        "left" => {
            let win_w = (half_orb + reach).ceil();
            let win_h = (side * 2.0).ceil();
            (win_w - half_orb, win_h / 2.0, win_w, win_h)
        }
        "right" => {
            let win_w = (half_orb + reach).ceil();
            let win_h = (side * 2.0).ceil();
            (half_orb, win_h / 2.0, win_w, win_h)
        }
        "se" => {
            let win_w = (half_orb + reach).ceil();
            let win_h = (half_orb + reach).ceil();
            (half_orb, half_orb, win_w, win_h)
        }
        "sw" => {
            let win_w = (half_orb + reach).ceil();
            let win_h = (half_orb + reach).ceil();
            (win_w - half_orb, half_orb, win_w, win_h)
        }
        "ne" => {
            let win_w = (half_orb + reach).ceil();
            let win_h = (half_orb + reach).ceil();
            (half_orb, win_h - half_orb, win_w, win_h)
        }
        "nw" => {
            let win_w = (half_orb + reach).ceil();
            let win_h = (half_orb + reach).ceil();
            (win_w - half_orb, win_h - half_orb, win_w, win_h)
        }
        _ => {
            let win_w = (side * 2.0).ceil();
            let win_h = (half_orb + reach).ceil();
            (win_w / 2.0, half_orb, win_w, win_h)
        }
    };

    // 先按球心对齐；窗口若超出屏幕则钳位，并反推局部坐标钉住球心。
    let mut win_x = screen_orb_cx - ideal_local_x;
    let mut win_y = screen_orb_cy - ideal_local_y;
    if win_w <= mon_w {
        win_x = win_x.clamp(mon_x, mon_x + mon_w - win_w);
    } else {
        win_x = mon_x;
    }
    if win_h <= mon_h {
        win_y = win_y.clamp(mon_y, mon_y + mon_h - win_h);
    } else {
        win_y = mon_y;
    }

    let orb_local_x = screen_orb_cx - win_x;
    let orb_local_y = screen_orb_cy - win_y;
    (orb_local_x, orb_local_y, win_w, win_h, win_x, win_y)
}

/// 瓣数优先；同瓣数时优先更小半径（保持花瓣贴紧圆球），再取更大扇角。
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
            direction, center_x, center_y, radius, mon_x, mon_y, mon_w, mon_h,
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
    let need = compact_r + PETAL_WIDTH.max(PETAL_HEIGHT) / 2.0 + SCREEN_PAD;
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
/// - 空间够 → 环绕 360°；瓣数变多先收紧间距（最多 30% 重叠），不先拉远半径
/// - 靠边 → 扇形铺满开阔侧可用角度，同样优先重叠再扩半径
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

    if let Some(layout) = try_around_layout(
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
    ) {
        return layout;
    }

    // 贴边判定：按紧凑半径净空判断，避免瓣数变多就过早切半扇 / 拉远
    let around_need =
        CLEARANCE_MIN + PETAL_WIDTH.max(PETAL_HEIGHT) / 2.0 + SCREEN_PAD;
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
        // 贴边：先试更大扇角，便于在 CLEARANCE_MIN 半径下排开瓣数，避免把花瓣推远
        let arcs: Vec<f64> = if candidate.corner {
            vec![candidate.fan_arc_deg]
        } else {
            vec![270.0, 240.0, 210.0, 180.0, 150.0, 120.0, 90.0]
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
