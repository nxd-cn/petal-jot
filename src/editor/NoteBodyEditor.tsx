import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  forwardRef,
} from "react";
import {
  toLocalInputValue,
  fromLocalInputValue,
  formatReminderLabel,
} from "../shared/reminderTime";
import {
  defaultReminderAt,
  parseBodyLine,
  parseBodyLines,
  serializeBodyLines,
  type BodyLine,
} from "../shared/todoText";
import type { Locale } from "../shared/i18n";

export type NoteBodyEditorHandle = {
  addTodo: () => void;
  addReminder: () => void;
};

type Props = {
  noteId: string | null;
  value: string;
  onChange: (body: string) => void;
  placeholder: string;
  todoAriaLabel: string;
  reminderAriaLabel: string;
  locale?: Locale;
};

type Segment = "before" | "after";

type PendingFocus = {
  index: number;
  segment: Segment;
  caret?: number;
};

function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "0px";
  const min = Math.round(14 * 1.5);
  el.style.height = `${Math.max(el.scrollHeight, min)}px`;
}

function resolveFocusIndex(
  beforeRefs: React.MutableRefObject<(HTMLTextAreaElement | null)[]>,
  afterRefs: React.MutableRefObject<(HTMLTextAreaElement | null)[]>,
  focusIndexRef: React.MutableRefObject<number>,
  lineCount: number,
): number {
  const active = document.activeElement;
  const beforeIdx = beforeRefs.current.findIndex((el) => el && el === active);
  if (beforeIdx >= 0) return beforeIdx;
  const afterIdx = afterRefs.current.findIndex((el) => el && el === active);
  if (afterIdx >= 0) return afterIdx;
  return Math.min(Math.max(focusIndexRef.current, 0), Math.max(lineCount - 1, 0));
}

function mergeReminderText(line: BodyLine): string {
  if (line.remindAt == null) return line.text;
  return `${line.text}${line.after ?? ""}`;
}

/**
 * 按行编辑：待办勾选与提醒闹钟可同时出现在同一行。
 * 闹钟是行内块，前后都可继续输入文字。
 */
export const NoteBodyEditor = forwardRef<NoteBodyEditorHandle, Props>(
  function NoteBodyEditor(
    {
      noteId,
      value,
      onChange,
      placeholder,
      todoAriaLabel,
      reminderAriaLabel,
      locale = "zh",
    },
    ref,
  ) {
    const [lines, setLines] = useState<BodyLine[]>(() => parseBodyLines(value));
    const [nowMs, setNowMs] = useState(() => Date.now());
    const linesRef = useRef(lines);
    const beforeRefs = useRef<(HTMLTextAreaElement | null)[]>([]);
    const afterRefs = useRef<(HTMLTextAreaElement | null)[]>([]);
    const focusIndexRef = useRef(0);
    const pendingFocusRef = useRef<PendingFocus | null>(null);

    useEffect(() => {
      linesRef.current = lines;
    }, [lines]);

    useEffect(() => {
      setNowMs(Date.now());
    }, [noteId]);

    useEffect(() => {
      const tick = window.setInterval(() => setNowMs(Date.now()), 5_000);
      return () => window.clearInterval(tick);
    }, []);

    useEffect(() => {
      if (serializeBodyLines(linesRef.current) === value) return;
      setLines(parseBodyLines(value));
    }, [noteId, value]);

    useLayoutEffect(() => {
      beforeRefs.current.forEach((el) => autosize(el));
      afterRefs.current.forEach((el) => autosize(el));
      const pending = pendingFocusRef.current;
      if (!pending) return;
      pendingFocusRef.current = null;
      const el =
        pending.segment === "after"
          ? afterRefs.current[pending.index]
          : beforeRefs.current[pending.index];
      if (!el) return;
      el.focus();
      const caret =
        pending.caret != null ? pending.caret : el.value.length;
      const clamped = Math.max(0, Math.min(caret, el.value.length));
      el.setSelectionRange(clamped, clamped);
    }, [lines]);

    const commit = useCallback(
      (next: BodyLine[], focus?: PendingFocus | number) => {
        const normalized =
          next.length > 0 ? next : ([{ kind: "text", text: "" }] as BodyLine[]);
        linesRef.current = normalized;
        setLines(normalized);
        if (focus != null) {
          const pending: PendingFocus =
            typeof focus === "number"
              ? { index: focus, segment: "before" }
              : focus;
          pendingFocusRef.current = pending;
          focusIndexRef.current = pending.index;
        }
        onChange(serializeBodyLines(normalized));
      },
      [onChange],
    );

    useImperativeHandle(
      ref,
      () => ({
        addTodo: () => {
          const current = linesRef.current;
          if (current.length === 0) {
            commit([{ kind: "todo", checked: false, text: "" }], 0);
            return;
          }
          let at = resolveFocusIndex(
            beforeRefs,
            afterRefs,
            focusIndexRef,
            current.length,
          );
          let line = current[at];
          if (
            line?.kind === "text" &&
            line.text.length === 0 &&
            line.remindAt == null &&
            at > 0
          ) {
            const prev = current[at - 1];
            if (prev && mergeReminderText(prev).length > 0) {
              at -= 1;
              line = prev;
            }
          }
          const next = [...current];
          if (line?.kind === "text") {
            next[at] = {
              kind: "todo",
              checked: false,
              text: line.text,
              remindAt: line.remindAt,
              ...(line.after ? { after: line.after } : {}),
            };
            commit(next, at);
            return;
          }
          if (line?.kind === "todo") {
            return;
          }
          next.splice(at + 1, 0, { kind: "todo", checked: false, text: "" });
          commit(next, at + 1);
        },
        addReminder: () => {
          const current = linesRef.current;
          const remindAt = defaultReminderAt();
          if (current.length === 0) {
            commit([{ kind: "text", text: "", remindAt, after: "" }], {
              index: 0,
              segment: "after",
              caret: 0,
            });
            return;
          }
          let at = resolveFocusIndex(
            beforeRefs,
            afterRefs,
            focusIndexRef,
            current.length,
          );
          let line = current[at];
          if (
            line?.kind === "text" &&
            line.text.length === 0 &&
            line.remindAt == null &&
            at > 0
          ) {
            const prev = current[at - 1];
            if (prev && mergeReminderText(prev).length > 0) {
              at -= 1;
              line = prev;
            }
          }
          const next = [...current];
          if (!line) {
            next.push({ kind: "text", text: "", remindAt, after: "" });
            commit(next, {
              index: next.length - 1,
              segment: "after",
              caret: 0,
            });
            return;
          }

          // 已有闹钟：光标在后段则不动；否则仍可改时间，焦点留在后段
          if (line.remindAt != null) {
            next[at] = { ...line, remindAt };
            commit(next, { index: at, segment: "after", caret: 0 });
            return;
          }

          // 按光标切开：前段 / 闹钟块 / 后段
          const active = document.activeElement;
          const beforeEl = beforeRefs.current[at];
          const caret =
            beforeEl && active === beforeEl
              ? beforeEl.selectionStart ?? line.text.length
              : line.text.length;
          const textBefore = line.text.slice(0, caret);
          const textAfter = line.text.slice(caret);
          next[at] = {
            ...line,
            text: textBefore,
            remindAt,
            after: textAfter,
          };
          commit(next, { index: at, segment: "after", caret: 0 });
        },
      }),
      [commit],
    );

    const setLineText = useCallback(
      (index: number, text: string) => {
        const current = linesRef.current;
        const line = current[index];
        if (!line) return;
        const next = [...current];
        next[index] = { ...line, text };
        commit(next);
      },
      [commit],
    );

    const setLineAfter = useCallback(
      (index: number, after: string) => {
        const current = linesRef.current;
        const line = current[index];
        if (!line || line.remindAt == null) return;
        const next = [...current];
        next[index] = { ...line, after };
        commit(next);
      },
      [commit],
    );

    const setReminderAt = useCallback(
      (index: number, remindAt: number) => {
        const current = linesRef.current;
        const line = current[index];
        if (!line) return;
        const next = [...current];
        next[index] = { ...line, remindAt };
        setNowMs(Date.now());
        commit(next);
      },
      [commit],
    );

    const clearReminder = useCallback(
      (index: number, focusAtJoin = false) => {
        const current = linesRef.current;
        const line = current[index];
        if (!line || line.remindAt == null) return;
        const next = [...current];
        const merged = mergeReminderText(line);
        const joinAt = line.text.length;
        if (line.kind === "todo") {
          next[index] = {
            kind: "todo",
            checked: line.checked,
            text: merged,
          };
        } else {
          next[index] = { kind: "text", text: merged };
        }
        commit(next, {
          index,
          segment: "before",
          caret: focusAtJoin ? joinAt : merged.length,
        });
      },
      [commit],
    );

    const toggleTodo = useCallback(
      (index: number) => {
        const current = linesRef.current;
        const line = current[index];
        if (!line || line.kind !== "todo") return;
        const next = [...current];
        next[index] = { ...line, checked: !line.checked };
        commit(next);
      },
      [commit],
    );

    const onBeforeKeyDown = useCallback(
      (index: number, event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        const current = linesRef.current;
        const line = current[index];
        if (!line) return;
        const el = event.currentTarget;
        const start = el.selectionStart ?? 0;
        const end = el.selectionEnd ?? 0;
        const hasReminder = line.remindAt != null;

        if (event.key === "ArrowRight" && start === end && start === line.text.length) {
          if (hasReminder) {
            event.preventDefault();
            const afterEl = afterRefs.current[index];
            afterEl?.focus();
            afterEl?.setSelectionRange(0, 0);
            return;
          }
        }

        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          const before = line.text.slice(0, start);
          const mid = line.text.slice(end);
          const next = [...current];

          if (line.kind === "todo") {
            if (
              line.text.trim().length === 0 &&
              (line.after ?? "").length === 0 &&
              mid.length === 0
            ) {
              next[index] =
                line.remindAt != null
                  ? {
                      kind: "text",
                      text: "",
                      remindAt: line.remindAt,
                      after: line.after ?? "",
                    }
                  : { kind: "text", text: "" };
              commit(next, index);
              return;
            }
            if (hasReminder) {
              // 回车在前段：前段留下，闹钟+后段落到下一行待办
              next[index] = { kind: "todo", checked: line.checked, text: before };
              next.splice(index + 1, 0, {
                kind: "todo",
                checked: false,
                text: mid,
                remindAt: line.remindAt,
                after: line.after ?? "",
              });
            } else {
              next[index] = { ...line, text: before };
              next.splice(index + 1, 0, {
                kind: "todo",
                checked: false,
                text: mid,
              });
            }
          } else if (hasReminder) {
            next[index] = { kind: "text", text: before };
            next.splice(index + 1, 0, {
              kind: "text",
              text: mid,
              remindAt: line.remindAt,
              after: line.after ?? "",
            });
          } else {
            next[index] = { ...line, text: before };
            next.splice(index + 1, 0, { kind: "text", text: mid });
          }
          commit(next, index + 1);
          return;
        }

        if (event.key === "Delete") {
          if (start === end && start === line.text.length && hasReminder) {
            event.preventDefault();
            // 删闹钟块，后段文字接到前面
            clearReminder(index, true);
          }
          return;
        }

        if (event.key === "Backspace") {
          if (start !== 0 || end !== 0) return;

          if (line.kind === "todo") {
            event.preventDefault();
            const next = [...current];
            next[index] =
              line.remindAt != null
                ? {
                    kind: "text",
                    text: line.text,
                    remindAt: line.remindAt,
                    after: line.after ?? "",
                  }
                : { kind: "text", text: line.text };
            commit(next, index);
            return;
          }

          if (hasReminder && line.text.length === 0) {
            event.preventDefault();
            clearReminder(index, true);
            return;
          }

          if (index === 0) return;
          event.preventDefault();
          const prev = current[index - 1];
          if (!prev) return;
          const next = [...current];

          if (prev.remindAt != null) {
            // 上一行已有闹钟：本行内容接到上一行后段
            const prevAfter = prev.after ?? "";
            next[index - 1] = {
              ...prev,
              after: `${prevAfter}${mergeReminderText(line)}`,
            };
            next.splice(index, 1);
            commit(next, {
              index: index - 1,
              segment: "after",
              caret: prevAfter.length,
            });
            return;
          }

          if (line.remindAt != null) {
            // 本行有闹钟：接到上一行后，闹钟仍留在合并行
            next[index - 1] =
              prev.kind === "todo"
                ? {
                    kind: "todo",
                    checked: prev.checked,
                    text: prev.text + line.text,
                    remindAt: line.remindAt,
                    after: line.after ?? "",
                  }
                : {
                    kind: "text",
                    text: prev.text + line.text,
                    remindAt: line.remindAt,
                    after: line.after ?? "",
                  };
            next.splice(index, 1);
            commit(next, {
              index: index - 1,
              segment: "before",
              caret: prev.text.length + line.text.length,
            });
            return;
          }

          next[index - 1] = { ...prev, text: prev.text + line.text };
          next.splice(index, 1);
          commit(next, {
            index: index - 1,
            segment: "before",
            caret: prev.text.length,
          });
        }
      },
      [clearReminder, commit],
    );

    const onAfterKeyDown = useCallback(
      (index: number, event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        const current = linesRef.current;
        const line = current[index];
        if (!line || line.remindAt == null) return;
        const el = event.currentTarget;
        const start = el.selectionStart ?? 0;
        const end = el.selectionEnd ?? 0;
        const after = line.after ?? "";

        if (event.key === "ArrowLeft" && start === end && start === 0) {
          event.preventDefault();
          const beforeEl = beforeRefs.current[index];
          const len = beforeEl?.value.length ?? line.text.length;
          beforeEl?.focus();
          beforeEl?.setSelectionRange(len, len);
          return;
        }

        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          const left = after.slice(0, start);
          const right = after.slice(end);
          const next = [...current];
          next[index] = { ...line, after: left };
          if (line.kind === "todo") {
            next.splice(index + 1, 0, {
              kind: "todo",
              checked: false,
              text: right,
            });
          } else {
            next.splice(index + 1, 0, { kind: "text", text: right });
          }
          commit(next, index + 1);
          return;
        }

        if (event.key === "Backspace" && start === end && start === 0) {
          event.preventDefault();
          // 后段开头退格：删掉闹钟块，文字前后粘回
          clearReminder(index, true);
        }
      },
      [clearReminder, commit],
    );

    const showPlaceholder =
      lines.length === 1 &&
      lines[0]?.kind === "text" &&
      lines[0].text.length === 0 &&
      lines[0].remindAt == null;

    return (
      <div className="note-body-editor" role="textbox" aria-multiline="true">
        {lines.map((line, index) => {
          const isTodo = line.kind === "todo";
          const hasReminder = line.remindAt != null;
          const isDue = hasReminder && line.remindAt! <= nowMs;
          return (
            <div
              key={index}
              className={`note-line${isTodo ? " note-line--todo" : ""}${
                hasReminder ? " note-line--reminder" : ""
              }${isDue ? " note-line--reminder-due" : ""}${
                isTodo && line.checked ? " is-checked" : ""
              }`}
            >
              {isTodo ? (
                <button
                  type="button"
                  className={`todo-check${line.checked ? " checked" : ""}`}
                  aria-label={todoAriaLabel}
                  aria-pressed={line.checked}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => toggleTodo(index)}
                >
                  <span className="todo-check-mark" aria-hidden>
                    {line.checked ? "✓" : ""}
                  </span>
                </button>
              ) : null}

              <span
                className={
                  hasReminder ? "reminder-line-cluster" : "note-line-main"
                }
              >
                <textarea
                  ref={(el) => {
                    beforeRefs.current[index] = el;
                  }}
                  className="note-line-input"
                  rows={1}
                  value={line.text}
                  placeholder={
                    showPlaceholder && index === 0 ? placeholder : undefined
                  }
                  aria-label={
                    isTodo
                      ? todoAriaLabel
                      : hasReminder
                        ? reminderAriaLabel
                        : undefined
                  }
                  onFocus={() => {
                    focusIndexRef.current = index;
                  }}
                  onChange={(event) => {
                    const text = event.target.value.replace(/\n/g, "");
                    setLineText(index, text);
                    autosize(event.currentTarget);
                  }}
                  onBlur={() => {
                    const current = linesRef.current[index];
                    if (
                      !current ||
                      current.kind !== "text" ||
                      current.remindAt != null
                    ) {
                      return;
                    }
                    const parsed = parseBodyLine(current.text);
                    if (parsed.kind === "text" && parsed.remindAt == null) return;
                    const next = [...linesRef.current];
                    next[index] = parsed;
                    commit(next);
                  }}
                  onKeyDown={(event) => onBeforeKeyDown(index, event)}
                />

                {hasReminder ? (
                  <>
                    <span
                      className={`reminder-inline${isDue ? " is-due" : ""}`}
                    >
                      <span className="reminder-line-icon" aria-hidden>
                        <svg
                          viewBox="0 0 24 24"
                          width="13"
                          height="13"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.1"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="12" cy="13" r="7" />
                          <path d="M12 10v3.5l2 1M9 3.5 7 6M15 3.5l2 2.5" />
                        </svg>
                      </span>
                      <input
                        className="reminder-line-time"
                        type="datetime-local"
                        aria-label={
                          isDue
                            ? `${reminderAriaLabel} · ${formatReminderLabel(line.remindAt!, locale)}`
                            : reminderAriaLabel
                        }
                        title={
                          isDue
                            ? formatReminderLabel(line.remindAt!, locale)
                            : undefined
                        }
                        value={toLocalInputValue(line.remindAt!)}
                        onFocus={() => {
                          focusIndexRef.current = index;
                        }}
                        onChange={(event) => {
                          const ms = fromLocalInputValue(event.target.value);
                          if (ms == null) return;
                          setReminderAt(index, ms);
                        }}
                        onKeyDown={(event) => {
                          if (
                            event.key === "Backspace" ||
                            event.key === "Delete"
                          ) {
                            event.preventDefault();
                            clearReminder(index, true);
                          }
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                      />
                      <button
                        type="button"
                        className="reminder-inline-remove"
                        aria-label={`${reminderAriaLabel} ×`}
                        title="×"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => clearReminder(index, true)}
                      >
                        ×
                      </button>
                    </span>
                    <textarea
                      ref={(el) => {
                        afterRefs.current[index] = el;
                      }}
                      className="note-line-input note-line-input--after"
                      rows={1}
                      value={line.after ?? ""}
                      aria-label={reminderAriaLabel}
                      onFocus={() => {
                        focusIndexRef.current = index;
                      }}
                      onChange={(event) => {
                        const text = event.target.value.replace(/\n/g, "");
                        setLineAfter(index, text);
                        autosize(event.currentTarget);
                      }}
                      onKeyDown={(event) => onAfterKeyDown(index, event)}
                    />
                  </>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    );
  },
);
