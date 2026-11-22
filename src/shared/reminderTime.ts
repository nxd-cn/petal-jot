/** 本地时间 → datetime-local 字符串。 */
export function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local → 毫秒；无效则 null。 */
export function fromLocalInputValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = new Date(trimmed).getTime();
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
