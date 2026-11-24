import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  forwardRef,
} from "react";
import { deleteImage, extFromMime, saveImage } from "../shared/api/images";
import { defaultReminderAt, parseBodyLine, parseBodyLines, serializeBodyLines, type BodyLine } from "../shared/todoText";
import { parseClipboard, type PastedPiece } from "./pasteParse";
import {
  NoteLineField,
  type NoteLineFieldHandle,
} from "./NoteLineField";
import { NoteImageLine } from "./NoteImageLine";
import { ReminderTimeField } from "./ReminderTimeField";
import {
  queryBoldActive,
  richHtmlToPlain,
  toggleBoldInEditable,
} from "./richText";
import { t, type Locale } from "../shared/i18n";

/** 从行列表收集图片相对路径（去重）。 */
function collectImageSrcs(lines: BodyLine[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.kind === "image" && line.src && !out.includes(line.src)) {
      out.push(line.src);
    }
  }
  return out;
}

/** 异步删除落盘图片；失败只打日志，不阻断编辑。 */
function purgeImageFiles(srcs: string[]): void {
  for (const src of srcs) {
    void deleteImage(src).catch((err) => {
      console.error("[petaljot] delete image failed", src, err);
    });
  }
}

export type NoteBodyEditorHandle = {
  addTodo: () => void;
  addReminder: () => void;
  /** 切换当前选区加粗；无选区时返回 false */
  toggleBold: () => boolean;
  /** 当前选区是否已加粗（供工具栏按下态） */
  isBoldActive: () => boolean;
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

/** 图片行：前段左浮 + 图片左浮，后段从右侧绕排并落到图下 */
function ImageLineClusterView(props: {
  line: Extract<BodyLine, { kind: "image" }>;
  selected: boolean;
  locale: Locale;
  beforeRef: (handle: NoteLineFieldHandle | null) => void;
  afterRef: (handle: NoteLineFieldHandle | null) => void;
  onFocus: () => void;
  onBeforeChange: (text: string) => void;
  onAfterChange: (text: string) => void;
  onBeforeKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onAfterKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onBeforePaste: (event: React.ClipboardEvent<HTMLDivElement>) => void;
  onAfterPaste: (event: React.ClipboardEvent<HTMLDivElement>) => void;
  onResize: (width: number) => void;
  onRemove: () => void;
}) {
  const {
    line,
    selected,
    locale,
    beforeRef,
    afterRef,
    onFocus,
    onBeforeChange,
    onAfterChange,
    onBeforeKeyDown,
    onAfterKeyDown,
    onBeforePaste,
    onAfterPaste,
    onResize,
    onRemove,
  } = props;
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const afterHandleRef = useRef<NoteLineFieldHandle | null>(null);
  const beforeEmpty = line.text.length === 0;

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const afterEl = afterHandleRef.current?.el() ?? null;
    if (!anchor || !afterEl) return;
    const sync = () => {
      const lineMin = Math.round(14 * 1.5);
      // 后段至少与图片同高，保证右侧与图下可点可写
      afterEl.style.minHeight = `${Math.max(lineMin, anchor.offsetHeight)}px`;
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(anchor);
    return () => {
      ro.disconnect();
    };
  }, [line.src, line.width, line.after]);

  return (
    <span className="image-line-cluster">
      <NoteLineField
        ref={beforeRef}
        className={`note-line-input note-line-input--before${
          beforeEmpty ? " is-empty" : ""
        }`}
        value={line.text}
        multiline
        ariaLabel={t(locale, "noteImage")}
        onFocus={onFocus}
        onChange={onBeforeChange}
        onKeyDown={onBeforeKeyDown}
        onPaste={onBeforePaste}
      />
      <span ref={anchorRef} className="image-line-anchor">
        <NoteImageLine
          src={line.src}
          width={line.width}
          selected={selected}
          ariaLabel={t(locale, "noteImage")}
          viewLabel={t(locale, "viewOriginalImage")}
          closeLabel={t(locale, "closeImagePreview")}
          removeLabel={t(locale, "removeImage")}
          resizeLabel={t(locale, "resizeImage")}
          onFocus={onFocus}
          onResize={onResize}
          onRemove={onRemove}
          onPaste={onBeforePaste}
        />
      </span>
      <NoteLineField
        ref={(handle) => {
          afterHandleRef.current = handle;
          afterRef(handle);
        }}
        className="note-line-input note-line-input--after"
        value={line.after ?? ""}
        multiline
        ariaLabel={t(locale, "noteImage")}
        onFocus={onFocus}
        onChange={onAfterChange}
        onKeyDown={onAfterKeyDown}
        onPaste={onAfterPaste}
      />
    </span>
  );
}

type PendingFocus = {
  index: number;
  segment: Segment;
  caret?: number;
};

/** 粘贴片段 → 行模型（列表项转待办）。 */
function pastedPieceToLine(piece: PastedPiece, text: string): BodyLine {
  return piece.todo
    ? { kind: "todo", checked: piece.checked, text }
    : { kind: "text", text };
}

/** 从事件目标解析所在行下标（不在任何行内返回 null）。 */
function lineIndexFromElement(target: HTMLElement | null): number | null {
  const lineEl = target?.closest(".note-line");
  if (!lineEl?.parentElement) return null;
  const siblings = Array.from(lineEl.parentElement.children).filter((el) =>
    el.classList.contains("note-line"),
  );
  const at = siblings.indexOf(lineEl);
  return at >= 0 ? at : null;
}

function fieldEl(handle: NoteLineFieldHandle | null): HTMLElement | null {
  return handle?.el() ?? null;
}

function resolveFocusIndex(
  beforeRefs: React.MutableRefObject<(NoteLineFieldHandle | null)[]>,
  afterRefs: React.MutableRefObject<(NoteLineFieldHandle | null)[]>,
  focusIndexRef: React.MutableRefObject<number>,
  lineCount: number,
): number {
  const active = document.activeElement;
  const beforeIdx = beforeRefs.current.findIndex((h) => {
    const el = fieldEl(h);
    return el && (el === active || el.contains(active));
  });
  if (beforeIdx >= 0) return beforeIdx;
  const afterIdx = afterRefs.current.findIndex((h) => {
    const el = fieldEl(h);
    return el && (el === active || el.contains(active));
  });
  if (afterIdx >= 0) return afterIdx;
  return Math.min(Math.max(focusIndexRef.current, 0), Math.max(lineCount - 1, 0));
}

function resolveFocusSegment(
  afterRefs: React.MutableRefObject<(NoteLineFieldHandle | null)[]>,
  index: number,
): Segment {
  const active = document.activeElement;
  const afterEl = fieldEl(afterRefs.current[index]);
  if (afterEl && (afterEl === active || afterEl.contains(active))) return "after";
  return "before";
}

function mergeReminderText(line: BodyLine): string {
  if (line.kind === "image") return "";
  if (line.remindAt == null) return line.text;
  return `${line.text}${line.after ?? ""}`;
}

/** 从 DataTransfer 取第一张位图（粘贴 / 拖入，macOS + Windows）。 */
async function readDataTransferImage(
  data: DataTransfer | null,
): Promise<{ bytes: Uint8Array; ext: string } | null> {
  if (!data) return null;
  // 拖入文件时 items 里 type 有时为空，优先扫 files
  for (const file of Array.from(data.files)) {
    const mime = file.type || guessMimeFromName(file.name);
    if (!mime.startsWith("image/")) continue;
    const ext = extFromMime(mime) ?? extFromFileName(file.name) ?? "png";
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.length === 0) continue;
    return { bytes: buf, ext };
  }
  for (const item of Array.from(data.items)) {
    if (!item.type.startsWith("image/")) continue;
    const ext = extFromMime(item.type);
    if (!ext) continue;
    const file = item.getAsFile();
    if (!file) continue;
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.length === 0) continue;
    return { bytes: buf, ext };
  }
  return null;
}

function guessMimeFromName(name: string): string {
  const ext = extFromFileName(name);
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  return "";
}

function extFromFileName(name: string): string | null {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return null;
  const e = m[1];
  if (e === "jpeg") return "jpg";
  if (["png", "jpg", "gif", "webp", "bmp"].includes(e)) return e;
  return null;
}

function dataTransferHasImage(data: DataTransfer | null): boolean {
  if (!data) return false;
  if (
    Array.from(data.files).some((f) => {
      const mime = f.type || guessMimeFromName(f.name);
      return mime.startsWith("image/");
    })
  ) {
    return true;
  }
  return Array.from(data.items).some(
    (item) =>
      item.type.startsWith("image/") ||
      (item.kind === "file" &&
        (!item.type || item.type.startsWith("image/"))),
  );
}

/**
 * dragover 阶段浏览器常不暴露 files 内容，只能靠 types / items 判断。
 * 只要像在拖文件，就放行，真正是否图片在 drop 里再读。
 */
function dataTransferLooksLikeFileDrag(data: DataTransfer | null): boolean {
  if (!data) return false;
  const types = Array.from(data.types ?? []);
  if (types.includes("Files")) return true;
  return Array.from(data.items).some((item) => item.kind === "file");
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
    const beforeRefs = useRef<(NoteLineFieldHandle | null)[]>([]);
    const afterRefs = useRef<(NoteLineFieldHandle | null)[]>([]);
    const focusIndexRef = useRef(0);
    const pendingFocusRef = useRef<PendingFocus | null>(null);
    /** 整条全选（多行 textarea 无法原生跨行选中，Cmd/Ctrl+A 直接触发） */
    const [allSelected, setAllSelected] = useState(false);
    const allSelectedRef = useRef(false);
    /** 鼠标跨行拖选的行区间（含两端） */
    const [lineSelection, setLineSelection] = useState<{
      from: number;
      to: number;
    } | null>(null);
    const lineSelectionRef = useRef<{ from: number; to: number } | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    /** 拖选进行态：从某行按下、跨行后升级为整行块选 */
    const dragStateRef = useRef<{
      active: boolean;
      blockMode: boolean;
      startLine: number;
      startX: number;
      startY: number;
    } | null>(null);

    const enterAllSelected = useCallback(() => {
      allSelectedRef.current = true;
      setAllSelected(true);
    }, []);

    const clearAllSelected = useCallback(() => {
      if (!allSelectedRef.current) return;
      allSelectedRef.current = false;
      setAllSelected(false);
    }, []);

    const setLineSelectionRange = useCallback((from: number, to: number) => {
      lineSelectionRef.current = { from, to };
      setLineSelection({ from, to });
    }, []);

    const clearLineSelection = useCallback(() => {
      if (!lineSelectionRef.current) return;
      lineSelectionRef.current = null;
      setLineSelection(null);
    }, []);

    useEffect(() => {
      linesRef.current = lines;
    }, [lines]);

    useEffect(() => {
      setNowMs(Date.now());
      clearAllSelected();
      clearLineSelection();
    }, [noteId, clearAllSelected, clearLineSelection]);

    useEffect(() => {
      const tick = window.setInterval(() => setNowMs(Date.now()), 5_000);
      return () => window.clearInterval(tick);
    }, []);

    useEffect(() => {
      if (serializeBodyLines(linesRef.current) === value) return;
      setLines(parseBodyLines(value));
    }, [noteId, value]);

    useLayoutEffect(() => {
      const pending = pendingFocusRef.current;
      if (!pending) return;
      pendingFocusRef.current = null;
      const field =
        pending.segment === "after"
          ? afterRefs.current[pending.index]
          : beforeRefs.current[pending.index];
      if (!field) return;
      field.focus();
      const len = field.getPlainValue().length;
      const caret = pending.caret != null ? pending.caret : len;
      field.setCaret(Math.max(0, Math.min(caret, len)));
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
            // 当前行已是待办：再点一次取消，保留文字与闹钟
            next[at] =
              line.remindAt != null
                ? {
                    kind: "text",
                    text: line.text,
                    remindAt: line.remindAt,
                    ...(line.after ? { after: line.after } : {}),
                  }
                : { kind: "text", text: line.text };
            commit(next, at);
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
          // 不跳到上一行：空行 / 有字都行，按当前光标所在行随意置放
          const at = resolveFocusIndex(
            beforeRefs,
            afterRefs,
            focusIndexRef,
            current.length,
          );
          const line = current[at];
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

          if (line.kind === "image") {
            next.splice(at + 1, 0, {
              kind: "text",
              text: "",
              remindAt,
              after: "",
            });
            commit(next, {
              index: at + 1,
              segment: "after",
              caret: 0,
            });
            return;
          }

          // 已有闹钟：只更新时间，焦点留在后段
          if (line.remindAt != null) {
            next[at] = { ...line, remindAt };
            commit(next, { index: at, segment: "after", caret: 0 });
            return;
          }

          // 按光标切开：前段 / 闹钟块 / 后段（光标在哪就插到哪）
          const segment = resolveFocusSegment(afterRefs, at);
          const beforeField = beforeRefs.current[at];
          const afterField = afterRefs.current[at];
          let textBefore = line.text;
          let textAfter = "";
          if (segment === "after" && afterField) {
            // 理论上无闹钟时没有后段；兜底整段放前
            textBefore = line.text;
            textAfter = "";
          } else if (beforeField) {
            const beforeEl = fieldEl(beforeField);
            const active = document.activeElement;
            const caret =
              beforeEl &&
              (beforeEl === active || beforeEl.contains(active))
                ? beforeField.getCaret()
                : line.text.length;
            textBefore = line.text.slice(0, caret);
            textAfter = line.text.slice(caret);
          }
          next[at] = {
            ...line,
            text: textBefore,
            remindAt,
            after: textAfter,
          };
          commit(next, { index: at, segment: "after", caret: 0 });
        },
        toggleBold: () => {
          const active = document.activeElement;
          if (!(active instanceof HTMLElement)) return false;
          const editable = active.closest(
            '[contenteditable="true"]',
          ) as HTMLElement | null;
          if (!editable || !editable.isContentEditable) return false;
          const ok = toggleBoldInEditable(editable);
          if (!ok) return false;
          const plain = richHtmlToPlain(editable.innerHTML).replace(/\n/g, "");
          const index = resolveFocusIndex(
            beforeRefs,
            afterRefs,
            focusIndexRef,
            linesRef.current.length,
          );
          const segment = resolveFocusSegment(afterRefs, index);
          const current = linesRef.current;
          const line = current[index];
          if (!line || line.kind === "image") return false;
          const next = [...current];
          if (segment === "after" && line.remindAt != null) {
            next[index] = { ...line, after: plain };
          } else {
            next[index] = { ...line, text: plain };
          }
          commit(next);
          return true;
        },
        isBoldActive: () => queryBoldActive(),
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
        if (!line) return;
        if (line.kind !== "image" && line.remindAt == null) return;
        const next = [...current];
        next[index] = { ...line, after };
        commit(next);
      },
      [commit],
    );

    const setImageWidth = useCallback(
      (index: number, width: number) => {
        const current = linesRef.current;
        const line = current[index];
        if (!line || line.kind !== "image") return;
        const next = [...current];
        next[index] = { ...line, width };
        commit(next);
      },
      [commit],
    );

    const setReminderAt = useCallback(
      (index: number, remindAt: number) => {
        const current = linesRef.current;
        const line = current[index];
        if (!line || line.kind === "image") return;
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
        if (!line || line.kind === "image" || line.remindAt == null) return;
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

    /**
     * 在光标处插入图片：前后文字留在同一行（text / after），可继续输入。
     */
    const insertImageAt = useCallback(
      (index: number, segment: Segment, relativePath: string) => {
        const current = linesRef.current;
        const next = [...current];
        const line = current[index];

        const focusAfter = (at: number) => {
          commit(next, { index: at, segment: "after", caret: 0 });
        };

        if (!line) {
          next.push({
            kind: "image",
            src: relativePath,
            text: "",
            after: "",
          });
          focusAfter(next.length - 1);
          return;
        }

        if (line.kind === "image") {
          const field =
            segment === "after"
              ? afterRefs.current[index]
              : beforeRefs.current[index];
          const source =
            segment === "after" ? (line.after ?? "") : line.text;
          const sel = field?.getSelection() ?? {
            start: source.length,
            end: source.length,
          };
          const head = source.slice(0, sel.start);
          const tail = source.slice(sel.end);
          if (segment === "after") {
            next[index] = { ...line, after: head };
            next.splice(index + 1, 0, {
              kind: "image",
              src: relativePath,
              text: "",
              after: tail,
            });
            focusAfter(index + 1);
            return;
          }
          next[index] = { ...line, text: head };
          next.splice(index + 1, 0, {
            kind: "image",
            src: relativePath,
            text: "",
            after: tail,
          });
          focusAfter(index + 1);
          return;
        }

        const field =
          segment === "after"
            ? afterRefs.current[index]
            : beforeRefs.current[index];
        const source =
          segment === "after" ? (line.after ?? "") : line.text;
        const sel = field?.getSelection() ?? {
          start: source.length,
          end: source.length,
        };
        const head = source.slice(0, sel.start);
        const tail = source.slice(sel.end);

        // 带闹钟：闹钟行保留前半，图片另起一行夹住后半
        if (line.remindAt != null) {
          if (segment === "after") {
            next[index] = { ...line, after: head };
            next.splice(index + 1, 0, {
              kind: "image",
              src: relativePath,
              text: "",
              after: tail,
            });
            focusAfter(index + 1);
            return;
          }
          next[index] = { ...line, text: head };
          next.splice(index + 1, 0, {
            kind: "image",
            src: relativePath,
            text: "",
            after: tail,
          });
          focusAfter(index + 1);
          return;
        }

        // 普通 / 待办行：整行变成「前文字 + 图片 + 后文字」
        next[index] = {
          kind: "image",
          src: relativePath,
          text: head,
          after: tail,
        };
        focusAfter(index);
      },
      [commit],
    );

    const insertPastedPieces = useCallback(
      (index: number, segment: Segment, pieces: PastedPiece[]) => {
        const current = linesRef.current;
        const line = current[index];
        if (!line) return;

        const field =
          segment === "after"
            ? afterRefs.current[index]
            : beforeRefs.current[index];
        const source =
          segment === "after" ? (line.after ?? "") : line.text;
        const sel = field?.getSelection() ?? {
          start: source.length,
          end: source.length,
        };
        const start = sel.start;
        const end = sel.end;

        const pieceLine = pastedPieceToLine;

        // 粘到空文本行开头的列表项：把当前行直接转成待办
        const asTodoHead = (
          piece: PastedPiece,
          head: string,
        ): boolean =>
          piece.todo &&
          line.kind === "text" &&
          line.remindAt == null &&
          head.trim().length === 0;

        if (pieces.length === 1) {
          const piece = pieces[0];
          const merged = source.slice(0, start) + piece.text + source.slice(end);
          const next = [...current];
          if (segment === "after") {
            next[index] = { ...line, after: merged };
          } else if (asTodoHead(piece, source.slice(0, start))) {
            next[index] = { kind: "todo", checked: piece.checked, text: merged };
          } else {
            next[index] = { ...line, text: merged };
          }
          commit(next, { index, segment, caret: start + piece.text.length });
          return;
        }

        const next = [...current];
        const head = source.slice(0, start);
        const tail = source.slice(end);

        if (
          segment === "before" &&
          line.kind !== "image" &&
          line.remindAt == null
        ) {
          if (asTodoHead(pieces[0], head)) {
            next[index] = {
              kind: "todo",
              checked: pieces[0].checked,
              text: pieces[0].text,
            };
          } else {
            next[index] = { ...line, text: head + pieces[0].text };
          }
          const inserted = pieces.slice(1, -1).map((p) => pieceLine(p, p.text));
          const last = pieces[pieces.length - 1];
          inserted.push(pieceLine(last, last.text + tail));
          next.splice(index + 1, 0, ...inserted);
          commit(next, { index: index + inserted.length, segment: "before" });
          return;
        }

        if (segment === "before") {
          // 行内带闹钟 / 图片：前段更新，其余片段落到新行
          next[index] = { ...line, text: head + pieces[0].text };
          const inserted = pieces.slice(1).map((p, i) =>
            pieceLine(p, i === 0 ? p.text + tail : p.text),
          );
          next.splice(index + 1, 0, ...inserted);
          commit(next, { index: index + inserted.length, segment: "before" });
          return;
        }

        // segment === "after"：前段并入闹钟后段，其余各自成行
        next[index] = { ...line, after: head + pieces[0].text };
        const inserted = pieces.slice(1, -1).map((p) => pieceLine(p, p.text));
        const last = pieces[pieces.length - 1];
        inserted.push(pieceLine(last, last.text + tail));
        next.splice(index + 1, 0, ...inserted);
        commit(next, { index: index + inserted.length, segment: "before" });
      },
      [commit],
    );

    /** 拦截粘贴：优先图片落盘；否则按行/结构拆分文本。 */
    const onSegmentPaste = useCallback(
      (
        index: number,
        segment: Segment,
        event: React.ClipboardEvent<HTMLDivElement>,
      ) => {
        const data = event.clipboardData;
        const hasImage = Array.from(data?.items ?? []).some((item) =>
          item.type.startsWith("image/"),
        );
        if (hasImage && noteId) {
          event.preventDefault();
          const at = index;
          void (async () => {
            const img = await readDataTransferImage(data);
            if (!img) return;
            try {
              const relative = await saveImage(noteId, img.bytes, img.ext);
              if (lineSelectionRef.current) {
                const { from, to } = lineSelectionRef.current;
                clearLineSelection();
                const next = [...linesRef.current];
                purgeImageFiles(collectImageSrcs(next.slice(from, to + 1)));
                next.splice(from, to - from + 1, {
                  kind: "image",
                  src: relative,
                  text: "",
                  after: "",
                });
                commit(next, {
                  index: from,
                  segment: "after",
                  caret: 0,
                });
                return;
              }
              if (allSelectedRef.current) {
                clearAllSelected();
                purgeImageFiles(collectImageSrcs(linesRef.current));
                commit(
                  [{ kind: "image", src: relative, text: "", after: "" }],
                  { index: 0, segment: "after", caret: 0 },
                );
                return;
              }
              insertImageAt(at, segment, relative);
            } catch (err) {
              console.error("[petaljot] paste image failed", err);
            }
          })();
          return;
        }

        const plain = data.getData("text/plain");
        const html = data.getData("text/html");
        const pieces = parseClipboard(plain, html);
        if (pieces.length === 0) return;
        event.preventDefault();
        if (lineSelectionRef.current) {
          const { from, to } = lineSelectionRef.current;
          clearLineSelection();
          const next = [...linesRef.current];
          purgeImageFiles(collectImageSrcs(next.slice(from, to + 1)));
          const newLines = pieces.map((p) => pastedPieceToLine(p, p.text));
          next.splice(from, to - from + 1, ...newLines);
          commit(next, {
            index: from + newLines.length - 1,
            segment: "before",
          });
          return;
        }
        if (allSelectedRef.current) {
          clearAllSelected();
          purgeImageFiles(collectImageSrcs(linesRef.current));
          commit([{ kind: "text", text: "" }], 0);
          insertPastedPieces(0, "before", pieces);
          return;
        }
        insertPastedPieces(index, segment, pieces);
      },
      [
        noteId,
        insertImageAt,
        insertPastedPieces,
        commit,
        clearAllSelected,
        clearLineSelection,
      ],
    );

    const onBeforeKeyDown = useCallback(
      (index: number, event: React.KeyboardEvent<HTMLDivElement>) => {
        // 全选 / 行选区激活时统一交给编辑器级处理
        if (allSelectedRef.current || lineSelectionRef.current) return;
        const current = linesRef.current;
        const line = current[index];
        if (!line) return;
        const field = beforeRefs.current[index];
        const { start, end } = field?.getSelection() ?? {
          start: line.text.length,
          end: line.text.length,
        };
        const isImage = line.kind === "image";
        const hasReminder = !isImage && line.remindAt != null;

        if (event.key === "ArrowRight" && start === end && start === line.text.length) {
          if (hasReminder || isImage) {
            event.preventDefault();
            const afterField = afterRefs.current[index];
            afterField?.focus();
            afterField?.setCaret(0);
            return;
          }
        }

        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          const before = line.text.slice(0, start);
          const mid = line.text.slice(end);
          const next = [...current];

          if (isImage) {
            // 图片前段：Enter 在绕排栏内换行，字多了自然落到图片下方
            next[index] = { ...line, text: `${before}\n${mid}` };
            commit(next, {
              index,
              segment: "before",
              caret: before.length + 1,
            });
            return;
          }

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
          if (start === end && start === line.text.length) {
            if (isImage) {
              event.preventDefault();
              const afterField = afterRefs.current[index];
              afterField?.focus();
              afterField?.setCaret(0);
              return;
            }
            const nextLine = current[index + 1];
            // 行尾 Delete：下一行是图片则删掉图片（含落盘文件）
            if (nextLine?.kind === "image" && !hasReminder) {
              event.preventDefault();
              purgeImageFiles([nextLine.src]);
              const next = [...current];
              next.splice(index + 1, 1);
              commit(next, {
                index,
                segment: "before",
                caret: start,
              });
              return;
            }
            if (hasReminder) {
              event.preventDefault();
              // 删闹钟块，后段文字接到前面
              clearReminder(index, true);
            }
          }
          return;
        }

        if (event.key === "Backspace") {
          if (start !== 0 || end !== 0) return;

          if (isImage) {
            if (index === 0) return;
            event.preventDefault();
            const prev = current[index - 1];
            if (!prev || prev.kind === "image") {
              // 空前段：删整张图（含落盘文件），前后文字并成普通行
              if (line.text.length === 0) {
                purgeImageFiles([line.src]);
                const next = [...current];
                const merged = `${line.after ?? ""}`;
                next[index] = { kind: "text", text: merged };
                commit(next, { index, segment: "before", caret: 0 });
              }
              return;
            }
            const next = [...current];
            if (prev.remindAt == null) {
              next[index - 1] = {
                ...prev,
                text: prev.text + line.text,
              };
              next[index] = { ...line, text: "" };
              commit(next, {
                index: index - 1,
                segment: "before",
                caret: prev.text.length + line.text.length,
              });
            }
            return;
          }

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

          // 行首 Backspace：上一行是图片 → 并回图片右侧文字，不删图
          if (prev.kind === "image") {
            const prevAfter = prev.after ?? "";
            const carry = mergeReminderText(line);
            next[index - 1] = {
              ...prev,
              after: `${prevAfter}${carry}`,
            };
            next.splice(index, 1);
            commit(next, {
              index: index - 1,
              segment: "after",
              caret: prevAfter.length,
            });
            return;
          }

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
      (index: number, event: React.KeyboardEvent<HTMLDivElement>) => {
        // 全选 / 行选区激活时统一交给编辑器级处理
        if (allSelectedRef.current || lineSelectionRef.current) return;
        const current = linesRef.current;
        const line = current[index];
        if (!line) return;
        if (line.kind !== "image" && line.remindAt == null) return;
        const field = afterRefs.current[index];
        const after = line.after ?? "";
        const { start, end } = field?.getSelection() ?? {
          start: after.length,
          end: after.length,
        };

        if (event.key === "ArrowLeft" && start === end && start === 0) {
          event.preventDefault();
          const beforeField = beforeRefs.current[index];
          const len = beforeField?.getPlainValue().length ?? line.text.length;
          beforeField?.focus();
          beforeField?.setCaret(len);
          return;
        }

        if (
          line.kind === "image" &&
          event.key === "Backspace" &&
          start === end &&
          start === 0
        ) {
          event.preventDefault();
          // 右侧文字开头退格：先回到图片左侧文字；左侧也空则与上一行合并
          if (line.text.length > 0) {
            const beforeField = beforeRefs.current[index];
            const len = beforeField?.getPlainValue().length ?? line.text.length;
            beforeField?.focus();
            beforeField?.setCaret(len);
            return;
          }
          if (index === 0) return;
          const prev = current[index - 1];
          if (!prev || prev.kind === "image") return;
          const next = [...current];
          const joinAt =
            prev.remindAt != null
              ? (prev.after ?? "").length
              : prev.text.length;
          if (prev.remindAt != null) {
            next[index - 1] = {
              ...prev,
              after: `${prev.after ?? ""}${line.after ?? ""}`,
            };
          } else {
            next[index - 1] = {
              ...prev,
              text: `${prev.text}${line.after ?? ""}`,
            };
          }
          next.splice(index, 1);
          commit(next, {
            index: index - 1,
            segment: prev.remindAt != null ? "after" : "before",
            caret: joinAt,
          });
          return;
        }

        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          const left = after.slice(0, start);
          const right = after.slice(end);
          const next = [...current];
          // 图片后段：Enter 在绕排栏内换行，可落到图片下方
          if (line.kind === "image") {
            next[index] = { ...line, after: `${left}\n${right}` };
            commit(next, {
              index,
              segment: "after",
              caret: left.length + 1,
            });
            return;
          }
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
          commit(next, {
            index: index + 1,
            segment: "before",
            caret: 0,
          });
          return;
        }

        if (event.key === "Backspace" && start === end && start === 0) {
          event.preventDefault();
          // 闹钟后段开头退格：删掉闹钟块，文字前后粘回
          clearReminder(index, true);
        }
      },
      [clearReminder, commit],
    );

    /** 把焦点放到指定行末尾；有闹钟 / 图片时落到后段末尾。 */
    const focusLineEnd = useCallback((index: number) => {
      const line = linesRef.current[index];
      if (!line) return;
      const useAfter = line.kind === "image" || line.remindAt != null;
      const field = useAfter
        ? afterRefs.current[index]
        : beforeRefs.current[index];
      if (!field) return;

      const placeCaret = () => {
        field.focus({ preventScroll: true });
        const caret = field.getPlainValue().length;
        try {
          field.setCaret(caret);
        } catch {
          // WebView2 偶发未就绪
        }
        focusIndexRef.current = index;
      };

      placeCaret();
      // Windows WebView2：同步 focus 偶发未生效，下一帧再落一次
      const el = field.el();
      if (el && document.activeElement !== el) {
        window.requestAnimationFrame(placeCaret);
      }
    }, []);

    /** 写入系统剪贴板。WebView2 上 navigator.clipboard 权限不稳，优先用隐藏 textarea + execCommand。 */
    const copyTextViaClipboard = useCallback((text: string) => {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.setAttribute("readonly", "");
      helper.style.position = "fixed";
      helper.style.left = "-9999px";
      helper.style.top = "0";
      document.body.appendChild(helper);
      helper.focus();
      helper.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      helper.remove();
      if (!ok && navigator.clipboard) {
        void navigator.clipboard.writeText(text).catch(() => {});
      }
    }, []);

    /** 复制整条正文（含 `- [ ]` 待办 / `[@]` 提醒标记）。 */
    const copyAllText = useCallback(() => {
      copyTextViaClipboard(serializeBodyLines(linesRef.current));
      // 复制助手会抢走焦点，落回编辑器
      focusLineEnd(Math.max(linesRef.current.length - 1, 0));
    }, [copyTextViaClipboard, focusLineEnd]);

    /** 复制行选区间（含两端）。 */
    const copyLineRange = useCallback(
      (from: number, to: number) => {
        const lines = linesRef.current;
        const slice = lines.slice(
          Math.max(0, from),
          Math.min(lines.length, to + 1),
        );
        copyTextViaClipboard(serializeBodyLines(slice));
        focusLineEnd(Math.max(0, Math.min(from, lines.length - 1)));
      },
      [copyTextViaClipboard, focusLineEnd],
    );

    /** 删除行选区间，焦点落到删除处；区间内图片文件一并清除。 */
    const deleteLineRange = useCallback(
      (from: number, to: number) => {
        const next = [...linesRef.current];
        purgeImageFiles(collectImageSrcs(next.slice(from, to + 1)));
        next.splice(from, to - from + 1);
        const focusIdx = Math.max(0, Math.min(from, next.length - 1));
        commit(next, focusIdx);
        clearLineSelection();
      },
      [commit, clearLineSelection],
    );

    /** 屏幕坐标 → 行下标；落在行间隙时取最近行。 */
    const lineIndexAtPoint = useCallback(
      (x: number, y: number): number | null => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        if (el) {
          const at = lineIndexFromElement(el);
          if (at != null) return at;
        }
        const root = rootRef.current;
        if (!root) return null;
        const lineEls = Array.from(
          root.querySelectorAll<HTMLElement>(":scope > .note-line"),
        );
        let best: number | null = null;
        let bestDist = Infinity;
        lineEls.forEach((node, index) => {
          const rect = node.getBoundingClientRect();
          const cy = Math.max(rect.top, Math.min(y, rect.bottom));
          const dist = Math.abs(y - cy);
          if (dist < bestDist) {
            bestDist = dist;
            best = index;
          }
        });
        return best;
      },
      [],
    );

    /**
     * 鼠标跨行拖选：原生选区无法跨多个 textarea，
     * 从某行按下、拖到别的行时升级为整行块选（Notion 式行粒度选择）。
     */
    useEffect(() => {
      const onMove = (event: PointerEvent) => {
        const drag = dragStateRef.current;
        if (!drag?.active || event.buttons === 0) return;
        const idx = lineIndexAtPoint(event.clientX, event.clientY);
        if (idx == null) return;
        if (!drag.blockMode) {
          if (idx === drag.startLine) return;
          drag.blockMode = true;
          // 取消原生选区并交出焦点，避免与本行原生拖选打架
          window.getSelection()?.removeAllRanges();
          (document.activeElement as HTMLElement | null)?.blur();
        }
        window.getSelection()?.removeAllRanges();
        const from = Math.min(drag.startLine, idx);
        const to = Math.max(drag.startLine, idx);
        const prev = lineSelectionRef.current;
        if (prev?.from === from && prev?.to === to) return;
        setLineSelectionRange(from, to);
      };

      const onUp = () => {
        const drag = dragStateRef.current;
        if (!drag?.active) return;
        dragStateRef.current = null;
        if (!drag.blockMode) return;
        const sel = lineSelectionRef.current;
        if (!sel || sel.from === sel.to) {
          // 拖回原行：当作普通点击处理
          clearLineSelection();
          focusLineEnd(drag.startLine);
          return;
        }
        // 选中区间成立：焦点落回起始行，复制/删除由编辑器级按键接管
        focusLineEnd(sel.from);
      };

      const onCancel = () => {
        const drag = dragStateRef.current;
        dragStateRef.current = null;
        if (drag?.blockMode) {
          clearLineSelection();
          focusLineEnd(drag.startLine);
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      return () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
      };
    }, [
      lineIndexAtPoint,
      setLineSelectionRange,
      clearLineSelection,
      focusLineEnd,
    ]);

    /**
     * 编辑器级按键：一行一个 textarea 时原生无法跨行全选，
     * Cmd/Ctrl+A 直接进入整条全选（全行高亮），
     * 全选后支持复制 / 剪切 / 删除 / 打字替换 / 粘贴替换。
     */
    const onRootKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLDivElement>) => {
        const mod = event.metaKey || event.ctrlKey;
        const key = event.key;

        if (mod && key.toLowerCase() === "a") {
          // 一步到位：直接全选整条（不先选当前段）
          event.preventDefault();
          if (allSelectedRef.current) return; // 已全选，保持
          const active = document.activeElement;
          if (active instanceof HTMLElement && active.isContentEditable) {
            // 去掉段内原生选区高亮，避免视觉混淆
            window.getSelection()?.removeAllRanges();
          }
          clearLineSelection();
          enterAllSelected();
          return;
        }

        if (mod && key.toLowerCase() === "b") {
          if (allSelectedRef.current || lineSelectionRef.current) return;
          const active = document.activeElement;
          if (!(active instanceof HTMLElement) || !active.isContentEditable) {
            return;
          }
          event.preventDefault();
          const editable = active.closest(
            '[contenteditable="true"]',
          ) as HTMLElement | null;
          if (!editable) return;
          if (!toggleBoldInEditable(editable)) return;
          const plain = richHtmlToPlain(editable.innerHTML).replace(/\n/g, "");
          const index = resolveFocusIndex(
            beforeRefs,
            afterRefs,
            focusIndexRef,
            linesRef.current.length,
          );
          const segment = resolveFocusSegment(afterRefs, index);
          const current = linesRef.current;
          const line = current[index];
          if (!line || line.kind === "image") return;
          const next = [...current];
          if (segment === "after" && line.remindAt != null) {
            next[index] = { ...line, after: plain };
          } else {
            next[index] = { ...line, text: plain };
          }
          commit(next);
          return;
        }

        // 行选区激活：复制 / 剪切 / 删除 / 打字替换作用于选中区间
        const sel = lineSelectionRef.current;
        if (sel) {
          const { from, to } = sel;
          if (event.defaultPrevented) {
            clearLineSelection();
            return;
          }

          if (key === "Escape") {
            event.preventDefault();
            clearLineSelection();
            return;
          }

          if (mod && key.toLowerCase() === "c") {
            event.preventDefault();
            copyLineRange(from, to);
            return;
          }

          if (mod && key.toLowerCase() === "x") {
            event.preventDefault();
            copyLineRange(from, to);
            deleteLineRange(from, to);
            return;
          }

          if (key === "Backspace" || key === "Delete") {
            event.preventDefault();
            deleteLineRange(from, to);
            return;
          }

          if (mod || event.altKey) {
            clearLineSelection();
            return;
          }

          if (key.length === 1) {
            // 打字 = 区间替换为该行（IME 组合中放行，避免打断中文输入）
            if ((event.nativeEvent as KeyboardEvent).isComposing) {
              clearLineSelection();
              return;
            }
            event.preventDefault();
            const next = [...linesRef.current];
            purgeImageFiles(collectImageSrcs(next.slice(from, to + 1)));
            next.splice(from, to - from + 1, { kind: "text", text: key });
            commit(next, { index: from, segment: "before", caret: 1 });
            clearLineSelection();
            return;
          }

          // 方向键 / Home / End 等导航键：退出选区，保持默认行为
          if (
            !["Shift", "Control", "Meta", "Alt", "CapsLock", "Dead"].includes(
              key,
            )
          ) {
            clearLineSelection();
          }
          return;
        }

        if (!allSelectedRef.current) return;
        if (event.defaultPrevented) {
          clearAllSelected();
          return;
        }

        if (key === "Escape") {
          event.preventDefault();
          clearAllSelected();
          return;
        }

        if (mod && key.toLowerCase() === "c") {
          event.preventDefault();
          copyAllText();
          return;
        }

        if (mod && key.toLowerCase() === "x") {
          event.preventDefault();
          copyAllText();
          purgeImageFiles(collectImageSrcs(linesRef.current));
          commit([{ kind: "text", text: "" }], 0);
          clearAllSelected();
          return;
        }

        if (key === "Backspace" || key === "Delete") {
          event.preventDefault();
          purgeImageFiles(collectImageSrcs(linesRef.current));
          commit([{ kind: "text", text: "" }], 0);
          clearAllSelected();
          return;
        }

        // 其余组合键：退出全选后放行
        if (mod || event.altKey) {
          clearAllSelected();
          return;
        }

          if (key.length === 1) {
          // 直接打字 = 整条替换为该字符（IME 组合中放行，避免打断中文输入）
          if ((event.nativeEvent as KeyboardEvent).isComposing) {
            clearAllSelected();
            return;
          }
          event.preventDefault();
          purgeImageFiles(collectImageSrcs(linesRef.current));
          commit([{ kind: "text", text: key }], {
            index: 0,
            segment: "before",
            caret: 1,
          });
          clearAllSelected();
          return;
        }

        // 方向键 / Home / End 等导航键：退出全选，保持默认行为
        if (!["Shift", "Control", "Meta", "Alt", "CapsLock", "Dead"].includes(key)) {
          clearAllSelected();
        }
      },
      [
        commit,
        copyAllText,
        copyLineRange,
        deleteLineRange,
        enterAllSelected,
        clearAllSelected,
        clearLineSelection,
      ],
    );

    /**
     * 点到行内空白或正文下方空白时，仍聚焦到对应行输入框。
     * 用 pointerdown（而非仅 mousedown）兼顾 Windows WebView2。
     * 勾选、闹钟时间、按钮等交互控件不抢。
     */
    /** 允许拖入图片：dragover 必须 preventDefault，否则 drop 不会触发。 */
    const onEditorDragOver = useCallback(
      (event: React.DragEvent<HTMLDivElement>) => {
        if (!noteId || !dataTransferLooksLikeFileDrag(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
      },
      [noteId],
    );

    const onEditorDragEnter = useCallback(
      (event: React.DragEvent<HTMLDivElement>) => {
        if (!noteId || !dataTransferLooksLikeFileDrag(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      },
      [noteId],
    );

    const onEditorDrop = useCallback(
      (event: React.DragEvent<HTMLDivElement>) => {
        if (!noteId) return;
        if (
          !dataTransferLooksLikeFileDrag(event.dataTransfer) &&
          !dataTransferHasImage(event.dataTransfer)
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const data = event.dataTransfer;
        const fromLine = lineIndexFromElement(event.target as HTMLElement);
        const at =
          fromLine != null
            ? fromLine
            : resolveFocusIndex(
                beforeRefs,
                afterRefs,
                focusIndexRef,
                linesRef.current.length,
              );
        const segment = resolveFocusSegment(afterRefs, at);

        void (async () => {
          const img = await readDataTransferImage(data);
          if (!img) {
            console.error(
              "[petaljot] drop image: no readable image in transfer",
            );
            return;
          }
          try {
            const relative = await saveImage(noteId, img.bytes, img.ext);
            clearLineSelection();
            clearAllSelected();
            insertImageAt(at, segment, relative);
          } catch (err) {
            console.error("[petaljot] drop image failed", err);
          }
        })();
      },
      [noteId, insertImageAt, clearLineSelection, clearAllSelected],
    );

    const onEditorPointerDown = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        clearAllSelected();
        clearLineSelection();
        const target = event.target as HTMLElement | null;
        if (!target) return;

        // 记录拖选起点（勾选 / 缩放手柄等控件点击不参与拖选）
        const onControl = Boolean(
          target.closest("button") || target.closest(".note-image-resize"),
        );
        if (!onControl) {
          const at = lineIndexFromElement(target);
          dragStateRef.current = {
            active: true,
            blockMode: false,
            startLine: at ?? Math.max(linesRef.current.length - 1, 0),
            startX: event.clientX,
            startY: event.clientY,
          };
        }

        if (
          target.closest("textarea") ||
          target.closest('[contenteditable="true"]') ||
          target.closest("input") ||
          onControl
        ) {
          return;
        }

        event.preventDefault();

        const lineEl = target.closest(".note-line");
        const current = linesRef.current;
        let index = Math.max(current.length - 1, 0);
        if (lineEl?.parentElement) {
          const siblings = Array.from(lineEl.parentElement.children).filter(
            (el) => el.classList.contains("note-line"),
          );
          const at = siblings.indexOf(lineEl);
          if (at >= 0) index = at;
        }
        focusLineEnd(index);
      },
      [focusLineEnd, clearAllSelected, clearLineSelection],
    );

    const showPlaceholder =
      lines.length === 1 &&
      lines[0]?.kind === "text" &&
      lines[0].text.length === 0 &&
      lines[0].remindAt == null;

    return (
      <div
        ref={rootRef}
        className={`note-body-editor${allSelected ? " is-select-all" : ""}`}
        role="textbox"
        aria-multiline="true"
        onPointerDown={onEditorPointerDown}
        onKeyDown={onRootKeyDown}
        onDragEnter={onEditorDragEnter}
        onDragOver={onEditorDragOver}
        onDrop={onEditorDrop}
      >
        {lines.map((line, index) => {
          const inLineSelection =
            lineSelection != null &&
            index >= lineSelection.from &&
            index <= lineSelection.to;

          if (line.kind === "image") {
            return (
              <div
                key={index}
                className={`note-line note-line--image${
                  inLineSelection ? " is-line-selected" : ""
                }`}
                onMouseDown={(event) => {
                  // 点图片行空白（非图片/按钮）→ 聚焦右侧输入
                  const target = event.target as HTMLElement | null;
                  if (
                    target?.closest(
                      ".note-image-line, .note-line-input, button, .note-image-resize",
                    )
                  ) {
                    return;
                  }
                  event.preventDefault();
                  focusIndexRef.current = index;
                  const afterField = afterRefs.current[index];
                  afterField?.focus();
                  afterField?.setCaret(afterField.getPlainValue().length);
                }}
              >
                <ImageLineClusterView
                  line={line}
                  selected={inLineSelection}
                  locale={locale}
                  beforeRef={(handle) => {
                    beforeRefs.current[index] = handle;
                  }}
                  afterRef={(handle) => {
                    afterRefs.current[index] = handle;
                  }}
                  onFocus={() => {
                    focusIndexRef.current = index;
                  }}
                  onBeforeChange={(text) => setLineText(index, text)}
                  onAfterChange={(text) => setLineAfter(index, text)}
                  onBeforeKeyDown={(event) => onBeforeKeyDown(index, event)}
                  onAfterKeyDown={(event) => onAfterKeyDown(index, event)}
                  onBeforePaste={(event) =>
                    onSegmentPaste(index, "before", event)
                  }
                  onAfterPaste={(event) =>
                    onSegmentPaste(index, "after", event)
                  }
                  onResize={(width) => setImageWidth(index, width)}
                  onRemove={() => {
                    const next = [...linesRef.current];
                    const cur = next[index];
                    if (!cur || cur.kind !== "image") return;
                    purgeImageFiles([cur.src]);
                    const merged = `${cur.text}${cur.after ?? ""}`;
                    next[index] = { kind: "text", text: merged };
                    commit(next, {
                      index,
                      segment: "before",
                      caret: cur.text.length,
                    });
                  }}
                />
              </div>
            );
          }

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
              }${inLineSelection ? " is-line-selected" : ""}`}
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
                <NoteLineField
                  ref={(handle) => {
                    beforeRefs.current[index] = handle;
                  }}
                  className="note-line-input"
                  value={line.text}
                  placeholder={
                    showPlaceholder && index === 0 ? placeholder : undefined
                  }
                  ariaLabel={
                    isTodo
                      ? todoAriaLabel
                      : hasReminder
                        ? reminderAriaLabel
                        : undefined
                  }
                  onFocus={() => {
                    focusIndexRef.current = index;
                  }}
                  onChange={(text) => {
                    setLineText(index, text);
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
                  onPaste={(event) => onSegmentPaste(index, "before", event)}
                />

                {hasReminder ? (
                  <>
                    <ReminderTimeField
                      remindAt={line.remindAt!}
                      isDue={isDue}
                      ariaLabel={reminderAriaLabel}
                      locale={locale}
                      onFocusLine={() => {
                        focusIndexRef.current = index;
                      }}
                      onCommit={(ms) => setReminderAt(index, ms)}
                      onClear={() => clearReminder(index, true)}
                    />
                    <NoteLineField
                      ref={(handle) => {
                        afterRefs.current[index] = handle;
                      }}
                      className="note-line-input note-line-input--after"
                      value={line.after ?? ""}
                      ariaLabel={reminderAriaLabel}
                      onFocus={() => {
                        focusIndexRef.current = index;
                      }}
                      onChange={(text) => {
                        setLineAfter(index, text);
                      }}
                      onKeyDown={(event) => onAfterKeyDown(index, event)}
                      onPaste={(event) => onSegmentPaste(index, "after", event)}
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
