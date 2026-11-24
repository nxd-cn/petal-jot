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
  onChange: (plain: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: React.ClipboardEvent<HTMLDivElement>) => void;
};

function autosize(el: HTMLDivElement | null) {
  if (!el) return;
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
        aria-multiline="false"
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
            const plain = richHtmlToPlain(el.innerHTML);
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
          // 禁止段内换行：contentEditable 偶发插入 <div>/<br>
          if (el.querySelector("div, p, br")) {
            const plain = richHtmlToPlain(el.innerHTML).replace(/\n/g, "");
            el.innerHTML = plainToRichHtml(plain);
            setCaretPlainOffset(el, plain.length);
            lastValueRef.current = plain;
            onChange(plain);
            autosize(el);
            return;
          }
          const plain = richHtmlToPlain(el.innerHTML);
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
