import { useEffect, useState } from "react";
import {
  formatReminderInput,
  formatReminderLabel,
  parseReminderInput,
} from "../shared/reminderTime";
import type { Locale } from "../shared/i18n";

type Props = {
  remindAt: number;
  isDue: boolean;
  ariaLabel: string;
  locale: Locale;
  onCommit: (ms: number) => void;
  onClear: () => void;
  onFocusLine: () => void;
};

/**
 * 正文内闹钟：⏰ + 可编辑时间文本（无系统下拉）。
 * 宽度用隐藏镜像文字测量，避免右侧留白；失焦 / Enter 提交。
 */
export function ReminderTimeField({
  remindAt,
  isDue,
  ariaLabel,
  locale,
  onCommit,
  onClear,
  onFocusLine,
}: Props) {
  const [text, setText] = useState(() => formatReminderInput(remindAt));

  useEffect(() => {
    setText(formatReminderInput(remindAt));
  }, [remindAt]);

  const commitText = () => {
    const ms = parseReminderInput(text);
    if (ms == null) {
      setText(formatReminderInput(remindAt));
      return;
    }
    if (ms !== remindAt) onCommit(ms);
    else setText(formatReminderInput(remindAt));
  };

  return (
    <span className={`reminder-inline${isDue ? " is-due" : ""}`}>
      <span className="reminder-line-icon" aria-hidden>
        ⏰
      </span>
      <span className="reminder-line-time-wrap">
        <span className="reminder-line-time-sizer" aria-hidden>
          {text || " "}
        </span>
        <input
          className="reminder-line-time"
          type="text"
          size={1}
          inputMode="numeric"
          spellCheck={false}
          autoComplete="off"
          aria-label={
            isDue
              ? `${ariaLabel} · ${formatReminderLabel(remindAt, locale)}`
              : ariaLabel
          }
          title={
            isDue ? formatReminderLabel(remindAt, locale) : "YYYY-MM-DD HH:mm"
          }
          value={text}
          onFocus={() => onFocusLine()}
          onChange={(event) => setText(event.target.value)}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setText(formatReminderInput(remindAt));
              event.currentTarget.blur();
            }
          }}
          onMouseDown={(event) => event.stopPropagation()}
        />
      </span>
      <button
        type="button"
        className="reminder-inline-remove"
        aria-label={`${ariaLabel} ×`}
        title="×"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onClear()}
      >
        ×
      </button>
    </span>
  );
}
