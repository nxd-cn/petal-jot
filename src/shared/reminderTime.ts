const pad2 = (n: number) => String(n).padStart(2, "0");

/** 本地时间 → datetime-local 字符串（兼容旧调用）。 */
export function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** datetime-local → 毫秒；无效则 null。 */
export function fromLocalInputValue(value: string): number | null {
  return parseReminderInput(value);
}

/** 正文闹钟可编辑文本：`YYYY-MM-DD HH:mm`（无下拉，直接输入）。 */
export function formatReminderInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 解析用户输入的提醒时间。
 * 支持：`YYYY-MM-DD HH:mm`、`YYYY-MM-DDTHH:mm`、`M/D HH:mm`、`HH:mm`（当天；已过则次日）。
 */
export function parseReminderInput(value: string, nowMs = Date.now()): number | null {
  const raw = value.trim().replace(/\s+/g, " ");
  if (!raw) return null;

  // 2026-11-24 14:30 / 2026-11-24T14:30
  let m = raw.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/,
  );
  if (m) {
    return localDateMs(+m[1], +m[2], +m[3], +m[4], +m[5]);
  }

  // 11/24 14:30 或 11-24 14:30
  m = raw.match(/^(\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})$/);
  if (m) {
    const now = new Date(nowMs);
    return localDateMs(now.getFullYear(), +m[1], +m[2], +m[3], +m[4]);
  }

  // 14:30 → 今天；若已过则明天
  m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const now = new Date(nowMs);
    let ms = localDateMs(
      now.getFullYear(),
      now.getMonth() + 1,
      now.getDate(),
      +m[1],
      +m[2],
    );
    if (ms == null) return null;
    if (ms <= nowMs) {
      ms += 24 * 60 * 60_000;
    }
    return ms;
  }

  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function localDateMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number | null {
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  const d = new Date(year, month - 1, day, hour, minute, 0, 0);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** 相对现在偏移分钟后的本地输入值。 */
export function localInputAfterMinutes(minutes: number): string {
  return toLocalInputValue(Date.now() + minutes * 60_000);
}

/** 展示用简短提醒时间。 */
export function formatReminderLabel(ms: number, locale: "zh" | "en"): string {
  const d = new Date(ms);
  if (locale === "en") {
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return d.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
