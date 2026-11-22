import { fromLocalInputValue } from "./reminderTime";

/**
 * 正文行：待办与提醒可同时存在（remindAt 可选）。
 * 有提醒时，闹钟是行内块：`text` 在前、`after` 在后。
 * - 普通：{ kind:"text", text }
 * - 仅提醒：{ kind:"text", text, remindAt, after? }
 * - 仅待办：{ kind:"todo", checked, text }
 * - 待办+提醒：{ kind:"todo", checked, text, remindAt, after? }
 */
export type BodyLine =
  | { kind: "text"; text: string; remindAt?: number; after?: string }
  | { kind: "todo"; checked: boolean; text: string; remindAt?: number; after?: string };

/** `- [ ] before [@] <time> after` 待办+提醒 */
const TODO_REMINDER_RE =
  /^\s*[-*+]\s+\[([ xX])\]\s+(.*?)\[@\]\s+(\S+)\s?(.*)$/;
/** `- [@] <time> after` 仅提醒（无前缀文字，兼容旧格式） */
const REMINDER_BULLET_RE = /^\s*[-*+]\s+\[@\]\s+(\S+)\s?(.*)$/;
/** `before [@] <time> after` 行内提醒 */
const REMINDER_INLINE_RE = /^(.*?)\[@\]\s+(\S+)\s?(.*)$/;
/** `- [ ] text` 仅待办 */
const TODO_ONLY_RE = /^\s*[-*+]\s+\[([ xX])\]\s?(.*)$/;

function parseRemindAtToken(token: string): number | null {
  const asMs = Number(token);
  if (Number.isFinite(asMs) && asMs > 1_000_000_000_000) {
    return asMs;
  }
  return fromLocalInputValue(token);
}

function withAfter(after: string | undefined): { after?: string } {
  return after && after.length > 0 ? { after } : {};
}

/** 行内可见文字（闹钟前后合并）。 */
export function lineVisibleText(line: BodyLine): string {
  if (line.remindAt == null) return line.text;
  const after = line.after ?? "";
  if (!line.text) return after;
  if (!after) return line.text;
  return `${line.text}${after}`;
}

/** 去掉行首待办 / 提醒标记，用于标题展示。 */
export function stripTodoMarker(line: string): string {
  return lineVisibleText(parseBodyLine(line)).trimEnd();
}

/** 解析单行。 */
export function parseBodyLine(raw: string): BodyLine {
  const both = raw.match(TODO_REMINDER_RE);
  if (both?.[3]) {
    const remindAt = parseRemindAtToken(both[3]);
    if (remindAt != null) {
      return {
        kind: "todo",
        checked: both[1] !== " ",
        text: (both[2] ?? "").trimEnd(),
        remindAt,
        ...withAfter(both[4] ?? ""),
      };
    }
  }

  const bullet = raw.match(REMINDER_BULLET_RE);
  if (bullet?.[1]) {
    const remindAt = parseRemindAtToken(bullet[1]);
    if (remindAt != null) {
      return {
        kind: "text",
        text: "",
        remindAt,
        ...withAfter(bullet[2] ?? ""),
      };
    }
  }

  const inline = raw.match(REMINDER_INLINE_RE);
  if (inline?.[2]) {
    const remindAt = parseRemindAtToken(inline[2]);
    if (remindAt != null) {
      return {
        kind: "text",
        text: (inline[1] ?? "").trimEnd(),
        remindAt,
        ...withAfter(inline[3] ?? ""),
      };
    }
  }

  const todo = raw.match(TODO_ONLY_RE);
  if (todo && todo[1] !== "@") {
    return {
      kind: "todo",
      checked: todo[1] !== " ",
      text: todo[2] ?? "",
    };
  }

  return { kind: "text", text: raw };
}

/** 正文 → 行列表。 */
export function parseBodyLines(body: string): BodyLine[] {
  if (body.length === 0) {
    return [{ kind: "text", text: "" }];
  }
  const lines = body.split(/\r?\n/).map(parseBodyLine);
  return lines.length > 0 ? lines : [{ kind: "text", text: "" }];
}

function serializeReminderTail(remind: number, after: string | undefined): string {
  const rest = after && after.length > 0 ? ` ${after}` : "";
  return `[@] ${remind}${rest}`;
}

/** 行列表 → 正文。 */
export function serializeBodyLines(lines: BodyLine[]): string {
  return lines
    .map((line) => {
      const text = line.text;
      const remind = line.remindAt;
      const after = line.after;
      if (line.kind === "todo") {
        const box = `- [${line.checked ? "x" : " "}]`;
        if (remind != null) {
          const head = text.length > 0 ? `${text} ` : "";
          return `${box} ${head}${serializeReminderTail(remind, after)}`;
        }
        return `${box} ${text}`;
      }
      if (remind != null) {
        if (text.length > 0) {
          return `${text} ${serializeReminderTail(remind, after)}`;
        }
        return `- ${serializeReminderTail(remind, after)}`;
      }
      return text;
    })
    .join("\n");
}

/** 是否没有任何实质内容。 */
export function isBlankBodyLines(body: string): boolean {
  return parseBodyLines(body).every((line) => {
    if (line.remindAt != null) return false;
    return line.text.trim().length === 0;
  });
}

/** 统计待办完成进度。 */
export function todoProgress(body: string): { done: number; total: number } | null {
  let done = 0;
  let total = 0;
  for (const line of parseBodyLines(body)) {
    if (line.kind !== "todo") continue;
    total += 1;
    if (line.checked) done += 1;
  }
  return total > 0 ? { done, total } : null;
}

/** 展示用摘要。 */
export function displayTodoExcerpt(
  body: string,
  maxLen = 24,
  progressLabel?: (done: number, total: number) => string,
): string {
  const progress = todoProgress(body);
  const rest = body
    .split(/\r?\n/)
    .slice(1)
    .map((line) => stripTodoMarker(line).trim())
    .filter(Boolean)
    .join(" ");

  if (progress) {
    const label =
      progressLabel?.(progress.done, progress.total) ??
      `${progress.done}/${progress.total}`;
    if (!rest) return label;
    const combined = `${label} · ${rest}`;
    return combined.length <= maxLen ? combined : `${combined.slice(0, maxLen)}…`;
  }

  if (!rest) return "";
  return rest.length <= maxLen ? rest : `${rest.slice(0, maxLen)}…`;
}

/** 默认新建提醒：30 分钟后。 */
export function defaultReminderAt(fromMs = Date.now()): number {
  return fromMs + 30 * 60_000;
}
