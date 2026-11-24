/**
 * 正文轻量富文本：仅加粗。
 * 存储仍是纯文本行，加粗用 `**…**`；编辑区用 <strong> 显示。
 */

/** 去掉加粗标记，供花瓣 / 侧栏摘要展示。 */
export function stripBoldMarkers(text: string): string {
  return text.replace(/\*\*([\s\S]+?)\*\*/g, "$1");
}

/** 纯文本（含 `**`）→ 编辑区 HTML。 */
export function plainToRichHtml(plain: string): string {
  const escaped = plain
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>");
}

/** 编辑区 HTML → 纯文本（加粗变回 `**`）。 */
export function richHtmlToPlain(html: string): string {
  if (!html) return "";
  const template = document.createElement("template");
  template.innerHTML = html;
  return walkNodes(template.content.childNodes);
}

function walkNodes(nodes: NodeListOf<ChildNode> | ChildNode[]): string {
  let out = "";
  for (const node of Array.from(nodes)) {
    out += walkNode(node);
  }
  return out;
}

/** WebView2 / Chromium 可能用 <b>、<strong> 或 style="font-weight:bold" 的 span。 */
function isBoldElement(el: HTMLElement): boolean {
  const tag = el.tagName;
  if (tag === "STRONG" || tag === "B") return true;
  const attr = (el.getAttribute("style") || "").toLowerCase();
  if (/font-weight\s*:\s*(bold|bolder|[6-9]00)/.test(attr)) return true;
  const weight = (el.style.fontWeight || "").toLowerCase();
  if (weight === "bold" || weight === "bolder") return true;
  const numeric = Number(weight);
  return Number.isFinite(numeric) && numeric >= 600;
}

function walkNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (tag === "BR") return "";
  if (tag === "SCRIPT" || tag === "STYLE") return "";
  const inner = walkNodes(el.childNodes);
  if (isBoldElement(el)) {
    if (!inner) return "";
    return `**${inner}**`;
  }
  return inner;
}

/**
 * 把 WebView2 的 font-weight span 收成 <strong>，保证落库 `**` 与再次编辑一致。
 */
export function normalizeBoldDom(root: HTMLElement): void {
  const candidates = Array.from(root.querySelectorAll("span, font"));
  for (const node of candidates) {
    const el = node as HTMLElement;
    if (!isBoldElement(el)) continue;
    const strong = document.createElement("strong");
    while (el.firstChild) strong.appendChild(el.firstChild);
    el.replaceWith(strong);
  }
}

/** 当前选区起点在 root 内对应的纯文本偏移（含 `**` 标记）。 */
export function getCaretPlainOffset(root: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return richHtmlToPlain(root.innerHTML).length;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) {
    return richHtmlToPlain(root.innerHTML).length;
  }
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  const frag = pre.cloneContents();
  const holder = document.createElement("div");
  holder.appendChild(frag);
  return richHtmlToPlain(holder.innerHTML).length;
}

/** 当前选区 [start, end) 纯文本偏移。 */
export function getSelectionPlainOffsets(
  root: HTMLElement,
): { start: number; end: number } {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    const len = richHtmlToPlain(root.innerHTML).length;
    return { start: len, end: len };
  }
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) {
    const len = richHtmlToPlain(root.innerHTML).length;
    return { start: len, end: len };
  }
  const start = offsetAt(root, range.startContainer, range.startOffset);
  const end = offsetAt(root, range.endContainer, range.endOffset);
  return start <= end ? { start, end } : { start: end, end: start };
}

function offsetAt(root: HTMLElement, container: Node, offset: number): number {
  const pre = document.createRange();
  pre.selectNodeContents(root);
  try {
    pre.setEnd(container, offset);
  } catch {
    return richHtmlToPlain(root.innerHTML).length;
  }
  const frag = pre.cloneContents();
  const holder = document.createElement("div");
  holder.appendChild(frag);
  return richHtmlToPlain(holder.innerHTML).length;
}

/** 按纯文本偏移放置光标（折叠选区）。 */
export function setCaretPlainOffset(root: HTMLElement, plainOffset: number): void {
  const target = Math.max(0, plainOffset);
  const point = findPositionForPlainOffset(root, target);
  if (!point) {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    return;
  }
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

type DomPoint = { node: Node; offset: number };

/**
 * 在可见 DOM 中找到对应纯文本偏移的位置。
 * 纯文本偏移按 richHtmlToPlain 规则计数（strong 两侧含 `**`）。
 */
function findPositionForPlainOffset(
  root: HTMLElement,
  plainOffset: number,
): DomPoint | null {
  let remaining = plainOffset;

  const visit = (node: Node): DomPoint | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (remaining <= text.length) {
        return { node, offset: remaining };
      }
      remaining -= text.length;
      return null;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === "BR" || tag === "SCRIPT" || tag === "STYLE") return null;

    const bold = isBoldElement(el);
    if (bold) {
      if (remaining < 2) {
        // 落在开头的 `**` 上 → 贴到加粗文本起始
        const first = firstTextNode(el);
        return first ? { node: first, offset: 0 } : { node: el, offset: 0 };
      }
      remaining -= 2;
    }

    for (const child of Array.from(el.childNodes)) {
      const hit = visit(child);
      if (hit) return hit;
    }

    if (bold) {
      if (remaining < 2) {
        const last = lastTextNode(el);
        if (last) {
          return { node: last, offset: (last.textContent ?? "").length };
        }
        return { node: el, offset: el.childNodes.length };
      }
      remaining -= 2;
    }
    return null;
  };

  for (const child of Array.from(root.childNodes)) {
    const hit = visit(child);
    if (hit) return hit;
  }
  return null;
}

function firstTextNode(root: Node): Text | null {
  if (root.nodeType === Node.TEXT_NODE) return root as Text;
  for (const child of Array.from(root.childNodes)) {
    const hit = firstTextNode(child);
    if (hit) return hit;
  }
  return null;
}

function lastTextNode(root: Node): Text | null {
  if (root.nodeType === Node.TEXT_NODE) return root as Text;
  const children = Array.from(root.childNodes);
  for (let i = children.length - 1; i >= 0; i -= 1) {
    const hit = lastTextNode(children[i]);
    if (hit) return hit;
  }
  return null;
}

/** 当前选区是否处于加粗（用于 B 按钮按下态）。 */
export function queryBoldActive(): boolean {
  try {
    return document.queryCommandState("bold");
  } catch {
    return false;
  }
}

/**
 * 切换选区加粗。优先 execCommand（原生切换）；
 * 无选区时不插入空加粗。
 * Windows WebView2 会倾向 styleWithCSS → span+font-weight，这里强制标签模式并规范化。
 */
export function toggleBoldInEditable(root: HTMLElement): boolean {
  root.focus();
  const { start, end } = getSelectionPlainOffsets(root);
  if (start === end) return false;
  try {
    // false：用 <b>/<strong>，避免 WebView2 写成 font-weight span
    document.execCommand("styleWithCSS", false, "false");
  } catch {
    // 旧引擎无此命令时忽略
  }
  try {
    const ok = document.execCommand("bold");
    if (!ok) return false;
  } catch {
    return false;
  }
  normalizeBoldDom(root);
  return true;
}
