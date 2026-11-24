/**
 * 剪贴板粘贴解析：把带格式内容（网页 / Word / 聊天窗口复制的富文本）
 * 转成行模型可用的片段列表。
 * - 多行文本 → 每行一个片段
 * - HTML 列表项（<li>）→ 待办片段
 * - 其余 HTML 块级元素（<p>/<div>/<h1-6>/<tr>…）按换行拆分
 * 纯文本存储不承载粗体/颜色，只保留结构（行、列表）。
 */

/** 一段粘贴内容：todo=true 表示来自列表项，应落成待办行。 */
export type PastedPiece = {
  text: string;
  todo: boolean;
  checked: boolean;
};

/** 超大粘贴的安全上限：超出部分并入最后一行，避免一次粘出上千个 textarea。 */
const MAX_PIECES = 200;

const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TR",
  "UL",
]);

/** 剪贴板内容 → 结构化片段。优先按 HTML 结构解析（保留列表/段落划分）。 */
export function parseClipboard(plain: string, html: string | null): PastedPiece[] {
  if (html && html.trim().length > 0) {
    const pieces = htmlToPieces(normalizeClipboardHtml(html));
    if (pieces.length > 0) {
      return capPieces(pieces);
    }
  }
  const plainPieces = plainToPieces(plain);
  return capPieces(plainPieces);
}

/**
 * Windows Word / Outlook / 部分浏览器会给出 CF_HTML 头（Version/StartHTML…），
 * 真正片段包在 StartFragment…EndFragment 里；去掉后再交给 DOMParser。
 */
function normalizeClipboardHtml(html: string): string {
  const fragment = html.match(
    /<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/i,
  );
  if (fragment?.[1]) return fragment[1];

  const startHtml = /StartHTML:(\d+)/i.exec(html);
  const endHtml = /EndHTML:(\d+)/i.exec(html);
  if (startHtml && endHtml) {
    const start = Number(startHtml[1]);
    const end = Number(endHtml[1]);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return html.slice(start, end);
    }
  }

  const htmlTag = html.search(/<html[\s>]/i);
  if (htmlTag > 0) return html.slice(htmlTag);
  return html;
}

function plainToPieces(plain: string): PastedPiece[] {
  if (plain.length === 0) return [];
  // Windows 剪贴板常用 \r\n；统一按行拆
  return plain.split(/\r\n|\r|\n/).map((text) => ({
    text,
    todo: false,
    checked: false,
  }));
}

function htmlToPieces(html: string): PastedPiece[] {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return [];
  }

  const pieces: PastedPiece[] = [];
  let buf = "";
  let todo = false;
  let checked = false;

  const flush = () => {
    // HTML 源码里的空白（缩进、换行）不参与渲染，压缩掉
    const text = buf.replace(/\s+/g, " ").trim();
    if (text.length > 0 || todo) {
      pieces.push({ text, todo, checked });
    }
    buf = "";
    todo = false;
    checked = false;
  };

  const walk = (node: Node) => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      buf += node.nodeValue ?? "";
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
    const el = node as Element;
    const tag = el.tagName;
    if (tag === "STYLE" || tag === "SCRIPT" || tag === "HEAD") return;
    if (tag === "BR") {
      flush();
      return;
    }
    if (tag === "LI") {
      flush();
      todo = true;
      const box = el.querySelector('input[type="checkbox"]');
      checked =
        box != null
          ? box.hasAttribute("checked")
          : el.classList.contains("checked");
      el.childNodes.forEach(walk);
      flush();
      return;
    }
    el.childNodes.forEach(walk);
    if (BLOCK_TAGS.has(tag)) {
      flush();
    }
  };

  Array.from(doc.body.childNodes).forEach(walk);
  flush();
  return pieces;
}

function capPieces(pieces: PastedPiece[]): PastedPiece[] {
  if (pieces.length <= MAX_PIECES) return pieces;
  const head = pieces.slice(0, MAX_PIECES - 1);
  const rest = pieces
    .slice(MAX_PIECES - 1)
    .map((piece) => piece.text.trim())
    .filter(Boolean)
    .join(" ");
  return [...head, { text: rest, todo: false, checked: false }];
}
