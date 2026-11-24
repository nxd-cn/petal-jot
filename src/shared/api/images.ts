import { convertFileSrc, invoke } from "@tauri-apps/api/core";

const urlCache = new Map<string, string>();

/** 将剪贴板图片字节落盘，返回相对路径 `noteId/uuid.ext`。 */
export async function saveImage(
  noteId: string,
  bytes: Uint8Array,
  ext: string,
): Promise<string> {
  return invoke<string>("images_save", {
    noteId,
    bytes: Array.from(bytes),
    ext,
  });
}

/** 相对路径 → 可在 WebView 中加载的 asset URL（带缓存）。 */
export async function imageSrcUrl(relativePath: string): Promise<string> {
  const cached = urlCache.get(relativePath);
  if (cached) return cached;
  const abs = await invoke<string>("images_absolute_path", {
    relativePath,
  });
  const url = convertFileSrc(abs);
  urlCache.set(relativePath, url);
  return url;
}

/** 删除落盘图片文件，并清掉前端 URL 缓存。 */
export async function deleteImage(relativePath: string): Promise<void> {
  urlCache.delete(relativePath);
  await invoke<void>("images_delete", { relativePath });
}

/** 从 MIME 推断扩展名。 */
export function extFromMime(mime: string): string | null {
  const type = mime.toLowerCase();
  if (type === "image/png") return "png";
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  if (type === "image/gif") return "gif";
  if (type === "image/webp") return "webp";
  if (type === "image/bmp") return "bmp";
  return null;
}
