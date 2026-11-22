import {
  displayTodoExcerpt,
  lineVisibleText,
  parseBodyLine,
} from "./todoText";

/** 展示用标题截取长度（首行）。 */
export const NOTE_TITLE_DISPLAY_LEN = 12;

/** 取正文首条有文字内容作为标题（提醒行取闹钟前后文字）。 */
export function firstLineTitle(body: string): string {
  for (const raw of body.split(/\r?\n/)) {
    const line = parseBodyLine(raw);
    const text = lineVisibleText(line).trim();
    if (text) return text;
  }
  return "";
}

/** 展示用截断标题。 */
export function displayTitle(bodyOrTitle: string, maxLen = NOTE_TITLE_DISPLAY_LEN): string {
  const raw = firstLineTitle(bodyOrTitle) || "未命名便签";
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, maxLen)}…`;
}

/** 去掉首行后的摘要；有待办时带进度。 */
export function displayExcerpt(body: string, maxLen = 24): string {
  return displayTodoExcerpt(body, maxLen);
}
