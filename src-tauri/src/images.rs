//! 便签图片：落盘到 appData/images，正文用 `![](petal-img:相对路径)` 引用。

use crate::error::{AppError, AppResult};
use std::fs;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

pub const IMAGE_MARKER_PREFIX: &str = "![](petal-img:";
pub const IMAGE_MARKER_SUFFIX: &str = ")";

/// `{appData}/images` 根目录（不存在则创建）。
pub fn images_root(app_data_dir: &Path) -> AppResult<PathBuf> {
    let root = app_data_dir.join("images");
    fs::create_dir_all(&root)?;
    Ok(root)
}

/// 校验相对路径：禁止 `..` / 绝对路径，只允许 `noteId/file.ext`。
pub fn sanitize_relative_path(relative: &str) -> AppResult<PathBuf> {
    let trimmed = relative.trim().replace('\\', "/");
    if trimmed.is_empty() || trimmed.starts_with('/') {
        return Err(AppError::Message(format!("invalid image path: {relative}")));
    }
    let path = PathBuf::from(&trimmed);
    for comp in path.components() {
        match comp {
            Component::Normal(_) => {}
            _ => {
                return Err(AppError::Message(format!("invalid image path: {relative}")));
            }
        }
    }
    if path.components().count() < 2 {
        return Err(AppError::Message(format!(
            "image path must be noteId/file: {relative}"
        )));
    }
    Ok(path)
}

/// 相对路径 → 绝对路径（必须落在 images 根下）。
pub fn absolute_image_path(app_data_dir: &Path, relative: &str) -> AppResult<PathBuf> {
    let root = images_root(app_data_dir)?;
    let rel = sanitize_relative_path(relative)?;
    let abs = root.join(&rel);
    if !abs.starts_with(&root) {
        return Err(AppError::Message(format!("image path escape: {relative}")));
    }
    Ok(abs)
}

/// 规范化扩展名：仅允许常见位图后缀。
pub fn normalize_ext(ext: &str) -> AppResult<String> {
    let e = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    match e.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" => {
            Ok(if e == "jpeg" { "jpg".into() } else { e })
        }
        _ => Err(AppError::Message(format!("unsupported image ext: {ext}"))),
    }
}

/// 将字节写入 `images/{noteId}/{uuid}.{ext}`，返回相对路径。
pub fn save_image_bytes(
    app_data_dir: &Path,
    note_id: &str,
    bytes: &[u8],
    ext: &str,
) -> AppResult<String> {
    if note_id.trim().is_empty() {
        return Err(AppError::Message("noteId required to save image".into()));
    }
    if bytes.is_empty() {
        return Err(AppError::Message("empty image bytes".into()));
    }
    // 约 20MB 上限，避免粘贴超大截图撑爆库与备份
    const MAX_BYTES: usize = 20 * 1024 * 1024;
    if bytes.len() > MAX_BYTES {
        return Err(AppError::Message(format!(
            "image too large: {} bytes (max {MAX_BYTES})",
            bytes.len()
        )));
    }
    let ext = normalize_ext(ext)?;
    let root = images_root(app_data_dir)?;
    let note_dir = root.join(note_id.trim());
    fs::create_dir_all(&note_dir)?;
    let name = format!("{}.{ext}", Uuid::new_v4());
    let abs = note_dir.join(&name);
    fs::write(&abs, bytes).map_err(|err| {
        eprintln!(
            "[petaljot] images_save write failed path={} err={err}",
            abs.display()
        );
        AppError::Io(err)
    })?;
    let relative = format!("{}/{}", note_id.trim(), name);
    eprintln!(
        "[petaljot] images_save ok relative={relative} bytes={}",
        bytes.len()
    );
    Ok(relative)
}

/// 是否含图片标记（可夹在前后文字之间，可带 `|w=280`）。
pub fn is_image_line(line: &str) -> bool {
    line.contains(IMAGE_MARKER_PREFIX)
}

/// 解析图片相对路径；忽略可选 `|w=` 与前后文字。
pub fn parse_image_src(line: &str) -> Option<&str> {
    let start = line.find(IMAGE_MARKER_PREFIX)? + IMAGE_MARKER_PREFIX.len();
    let rest = line.get(start..)?;
    let end = rest.find(IMAGE_MARKER_SUFFIX)?;
    let inner = rest.get(..end)?.trim();
    if inner.is_empty() {
        return None;
    }
    // path 或 path|w=280
    let path = inner.split('|').next()?.trim();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

/// 删除某笔记下全部落盘图片（`images/{noteId}/`）；目录不存在视为成功。
pub fn delete_note_images(app_data_dir: &Path, note_id: &str) -> AppResult<()> {
    let id = note_id.trim();
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
    {
        return Err(AppError::Message(format!(
            "invalid note id for images: {note_id}"
        )));
    }
    let dir = images_root(app_data_dir)?.join(id);
    if !dir.exists() {
        eprintln!("[petaljot] images_delete_note skip missing note_id={id}");
        return Ok(());
    }
    fs::remove_dir_all(&dir).map_err(|err| {
        eprintln!(
            "[petaljot] images_delete_note failed note_id={id} path={} err={err}",
            dir.display()
        );
        AppError::Io(err)
    })?;
    eprintln!(
        "[petaljot] images_delete_note ok note_id={id} path={}",
        dir.display()
    );
    Ok(())
}

/// 按相对路径删除落盘图片；文件不存在视为成功。空笔记目录一并尝试清理。
pub fn delete_image_file(app_data_dir: &Path, relative: &str) -> AppResult<()> {
    let abs = absolute_image_path(app_data_dir, relative)?;
    if abs.is_file() {
        fs::remove_file(&abs).map_err(|err| {
            eprintln!(
                "[petaljot] images_delete remove failed path={} err={err}",
                abs.display()
            );
            AppError::Io(err)
        })?;
        eprintln!(
            "[petaljot] images_delete ok relative={relative} path={}",
            abs.display()
        );
    } else {
        eprintln!(
            "[petaljot] images_delete skip missing relative={relative} path={}",
            abs.display()
        );
    }
    if let Some(parent) = abs.parent() {
        // 仅当笔记图片目录已空时删除，忽略非空/权限等错误
        let _ = fs::remove_dir(parent);
    }
    Ok(())
}

/// 从正文收集全部图片相对路径（去重、保序）。
pub fn collect_image_refs(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in body.lines() {
        if let Some(src) = parse_image_src(line) {
            if !out.iter().any(|s| s == src) {
                out.push(src.to_string());
            }
        }
    }
    out
}

/// 正文是否含实质内容（文字 / 待办 / 提醒 / 图片）。
pub fn body_has_content(body: &str) -> bool {
    for line in body.lines() {
        if is_image_line(line) {
            return true;
        }
        if !line.trim().is_empty() {
            return true;
        }
    }
    false
}
