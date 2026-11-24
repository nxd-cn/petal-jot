import {
  useLayoutEffect,
  useRef,
  forwardRef,
  useImperativeHandle,
} from "react";
import {
  getCaretPlainOffset,
  getSelectionPlainOffsets,
  plainToRichHtml,
  richHtmlToPlain,
  setCaretPlainOffset,
} from "./richText";

export type NoteLineFieldHandle = {
  focus: (options?: FocusOptions) => void;
  getPlainValue: () => string;
  getCaret: () => number;
  getSelection: () => { start: number; end: number };
  setCaret: (offset: number) => void;
  el: () => HTMLDivElement | null;
};

type Props = {
  className?: string;
  value: string;
  placeholder?: string;
  ariaLabel?: string;
  /** 允许段内换行（图片右侧文字）；默认单行会剥掉 br/div */
  multiline?: boolean;
  onChange: (plain: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: React.ClipboardEvent<HTMLDivElement>) => void;
};

function autosize(el: HTMLDivElement | null) {
  if (!el) return;
  // 图片前/后段靠 float 绕排，锁定 height 会量不准，也容易挡住下方排字
  if (
    el.closest(".image-line-cluster") &&
    (el.classList.contains("note-line-input--after") ||
      el.classList.contains("note-line-input--before"))
  ) {
    el.style.height = "auto";
    el.style.minHeight = el.classList.contains("is-empty")
      ? "0px"
      : `${Math.round(14 * 1.5)}px`;
    return;
  }
  el.style.height = "0px";
  const min = Math.round(14 * 1.5);
  el.style.height = `${Math.max(el.scrollHeight, min)}px`;
}

/**
 * 单行可编辑字段：contentEditable 显示加粗，对外仍是 `**…**` 纯文本。
 */
export const NoteLineField = forwardRef<NoteLineFieldHandle, Props>(
  function NoteLineField(
    {
      className,
      value,
      placeholder,
      ariaLabel,
      multiline = false,
      onChange,
      onFocus,
      onBlur,
      onKeyDown,
      onPaste,
    },
    ref,
  ) {
    const elRef = useRef<HTMLDivElement | null>(null);
    const lastValueRef = useRef(value);
    const pendingCaretRef = useRef<number | null>(null);

    useImperativeHandle(ref, () => ({
      focus: (options) => elRef.current?.focus(options),
      getPlainValue: () =>
        elRef.current ? richHtmlToPlain(elRef.current.innerHTML) : value,
      getCaret: () =>
        elRef.current ? getCaretPlainOffset(elRef.current) : value.length,
      getSelection: () =>
        elRef.current
          ? getSelectionPlainOffsets(elRef.current)
          : { start: value.length, end: value.length },
      setCaret: (offset) => {
        pendingCaretRef.current = offset;
        if (elRef.current) setCaretPlainOffset(elRef.current, offset);
      },
      el: () => elRef.current,
    }));

    useLayoutEffect(() => {
      const el = elRef.current;
      if (!el) return;
      const currentPlain = richHtmlToPlain(el.innerHTML);
      if (currentPlain !== value) {
        el.innerHTML = plainToRichHtml(value);
        lastValueRef.current = value;
      }
      const pending = pendingCaretRef.current;
      if (pending != null) {
        pendingCaretRef.current = null;
        setCaretPlainOffset(el, pending);
      }
      autosize(el);
    }, [value]);

    return (
      <div
        ref={elRef}
        className={className}
        contentEditable
        role="textbox"
        aria-multiline={multiline}
        aria-label={ariaLabel}
        data-placeholder={placeholder}
        suppressContentEditableWarning
        onFocus={() => {
          // WebView2 默认 styleWithCSS，加粗会变成 span+font-weight；强制标签模式
          try {
            document.execCommand("styleWithCSS", false, "false");
          } catch {
            // ignore
          }
          onFocus?.();
        }}
        onBlur={() => {
          const el = elRef.current;
          if (el) {
            let plain = richHtmlToPlain(el.innerHTML);
            if (!multiline) {
              plain = plain.replace(/\n/g, "");
            } else if (plain.startsWith("\n")) {
              plain = plain.replace(/^\n+/, "");
            }
            if (plain !== lastValueRef.current) {
              lastValueRef.current = plain;
              onChange(plain);
            }
          }
          onBlur?.();
        }}
        onInput={() => {
          const el = elRef.current;
          if (!el) return;
          if (!multiline && el.querySelector("div, p, br")) {
            // 单行：禁止段内换行
            const plain = richHtmlToPlain(el.innerHTML).replace(/\n/g, "");
            el.innerHTML = plainToRichHtml(plain);
            setCaretPlainOffset(el, plain.length);
            lastValueRef.current = plain;
            onChange(plain);
            autosize(el);
            return;
          }
          let plain = richHtmlToPlain(el.innerHTML);
          if (!multiline) {
            plain = plain.replace(/\n/g, "");
          } else if (plain.startsWith("\n")) {
            plain = plain.replace(/^\n+/, "");
          }
          lastValueRef.current = plain;
          onChange(plain);
          autosize(el);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
        }}
        onPaste={(event) => {
          onPaste?.(event);
        }}
      />
    );
  },
);
