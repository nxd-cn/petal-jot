use crate::error::{AppError, AppResult};
use crate::models::{AppSettings, Note, NoteSummary, UpsertNoteInput, DEFAULT_NOTE_COLOR};
use rusqlite::{params, Connection};
use std::path::Path;
use uuid::Uuid;

/// 初始化 SQLite schema，并做轻量迁移。
pub fn init_db(path: &Path) -> AppResult<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          body TEXT NOT NULL DEFAULT '',
          cover_image TEXT,
          color TEXT NOT NULL DEFAULT '#dfdfdb',
          pinned INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_notes_feed
          ON notes (deleted_at, pinned DESC, updated_at DESC);
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        "#,
    )?;
    ensure_column(&conn, "notes", "color", "TEXT NOT NULL DEFAULT '#dfdfdb'")?;
    ensure_column(&conn, "notes", "sort_order", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "notes", "reminder_at", "INTEGER")?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS reminders (
          id TEXT PRIMARY KEY NOT NULL,
          note_id TEXT NOT NULL,
          remind_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_reminders_due
          ON reminders (remind_at);
        CREATE INDEX IF NOT EXISTS idx_reminders_note
          ON reminders (note_id, remind_at);
        "#,
    )?;
    migrate_legacy_note_reminders(&conn)?;
    backfill_sort_order(&conn)?;
    Ok(conn)
}

/// 把旧版 notes.reminder_at 迁到 reminders 表。
fn migrate_legacy_note_reminders(conn: &Connection) -> AppResult<()> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, reminder_at FROM notes
        WHERE reminder_at IS NOT NULL AND deleted_at IS NULL
        "#,
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    let ts = now_ms();
    for (note_id, remind_at) in rows {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM reminders WHERE note_id = ?1 AND remind_at = ?2",
            params![note_id, remind_at],
            |row| row.get(0),
        )?;
        if exists == 0 {
            conn.execute(
                r#"
                INSERT INTO reminders (id, note_id, remind_at, created_at)
                VALUES (?1, ?2, ?3, ?4)
                "#,
                params![Uuid::new_v4().to_string(), note_id, remind_at, ts],
            )?;
        }
        // 同步写入正文提醒行，与待办一样可见
        if let Ok(note) = get_note(conn, &note_id) {
            let already = note
                .body
                .lines()
                .any(|line| parse_reminder_at(line) == Some(remind_at));
            if !already {
                let marker = format!("- [@] {remind_at}");
                let next_body = if note.body.trim().is_empty() {
                    marker
                } else {
                    format!("{}\n{marker}", note.body.trim_end())
                };
                let title = title_from_body(&next_body);
                let _ = conn.execute(
                    "UPDATE notes SET title = ?1, body = ?2 WHERE id = ?3",
                    params![title, next_body, note_id],
                );
            }
        }
        conn.execute(
            "UPDATE notes SET reminder_at = NULL WHERE id = ?1",
            params![note_id],
        )?;
    }
    Ok(())
}

/// 已有数据若 sort_order 未区分开，按当前更新时间灌入固定顺序。
fn backfill_sort_order(conn: &Connection) -> AppResult<()> {
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    if total <= 1 {
        return Ok(());
    }
    let distinct: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT sort_order) FROM notes WHERE deleted_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    if distinct == total {
        return Ok(());
    }

    let mut stmt = conn.prepare(
        r#"
        SELECT id FROM notes
        WHERE deleted_at IS NULL
        ORDER BY pinned DESC, updated_at DESC, created_at DESC
        "#,
    )?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for (index, id) in ids.into_iter().enumerate() {
        conn.execute(
            "UPDATE notes SET sort_order = ?1 WHERE id = ?2",
            params![index as i64, id],
        )?;
    }
    Ok(())
}

fn next_sort_order(conn: &Connection) -> AppResult<i64> {
    let min: i64 = conn
        .query_row(
            "SELECT COALESCE(MIN(sort_order), 0) FROM notes WHERE deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(min - 1)
}

fn ensure_column(conn: &Connection, table: &str, column: &str, ddl_type: &str) -> AppResult<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut exists = false;
    for name in names {
        if name? == column {
            exists = true;
            break;
        }
    }
    if !exists {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {ddl_type}"),
            [],
        )?;
    }
    Ok(())
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn normalize_color(raw: Option<String>) -> String {
    let value = raw
        .unwrap_or_else(|| DEFAULT_NOTE_COLOR.to_string())
        .trim()
        .to_string();
    if value.starts_with('#') && (value.len() == 7 || value.len() == 4) {
        value
    } else {
        DEFAULT_NOTE_COLOR.to_string()
    }
}

/// 解析行内提醒时间：支持 `- [@] ms` 与 `- [ ] [@] ms 文字`（待办+提醒同行）。
fn parse_reminder_at(line: &str) -> Option<i64> {
    let idx = line.find("[@]")?;
    let after = line[idx + 3..].trim_start();
    let token = after.split_whitespace().next().unwrap_or("");
    if token.is_empty() {
        return None;
    }
    if let Ok(ms) = token.parse::<i64>() {
        if ms > 1_000_000_000_000 {
            return Some(ms);
        }
    }
    // 兼容旧的本地 datetime-local：YYYY-MM-DDTHH:mm
    if token.len() >= 16 && token.as_bytes().get(10) == Some(&b'T') {
        let y: i64 = token.get(0..4)?.parse().ok()?;
        let mo: i64 = token.get(5..7)?.parse().ok()?;
        let d: i64 = token.get(8..10)?.parse().ok()?;
        let h: i64 = token.get(11..13)?.parse().ok()?;
        let mi: i64 = token.get(14..16)?.parse().ok()?;
        let days = civil_days_from_civil(y, mo, d)?;
        let ms = days
            .checked_mul(86_400_000)?
            .checked_add(h.checked_mul(3_600_000)?)?
            .checked_add(mi.checked_mul(60_000)?)?;
        return Some(ms);
    }
    None
}

/// 从行里去掉 `[@] <time>`，保留待办标记与正文。
fn remove_reminder_marker(line: &str) -> String {
    let Some(idx) = line.find("[@]") else {
        return line.to_string();
    };
    let before = line[..idx].trim_end();
    let after = line[idx + 3..].trim_start();
    let rest = match after.split_once(char::is_whitespace) {
        Some((_, r)) => r.trim_start(),
        None => "",
    };
    if rest.is_empty() {
        before.to_string()
    } else if before.is_empty() {
        rest.to_string()
    } else {
        format!("{before} {rest}")
    }
}

/// 公历日期 → 距 Unix 纪元的整天数（UTC）。
fn civil_days_from_civil(y: i64, m: i64, d: i64) -> Option<i64> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // Howard Hinnant civil_from_days 逆运算
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// 去掉行首待办 / 行内提醒标记，只留正文。
fn strip_todo_marker(line: &str) -> String {
    let without_reminder = remove_reminder_marker(line);
    let trimmed = without_reminder.trim_start();
    let bytes = trimmed.as_bytes();
    if bytes.len() < 5 {
        return without_reminder.trim().to_string();
    }
    let bullet = bytes[0];
    if !(bullet == b'-' || bullet == b'*' || bullet == b'+') {
        return without_reminder.trim().to_string();
    }
    let after_bullet = trimmed[1..].trim_start();
    let ab = after_bullet.as_bytes();
    if ab.len() < 3 || ab[0] != b'[' || ab[2] != b']' {
        return without_reminder.trim().to_string();
    }
    let mark = ab[1];
    if mark != b' ' && mark != b'x' && mark != b'X' {
        return without_reminder.trim().to_string();
    }
    after_bullet[3..].trim().to_string()
}

fn is_todo_line(line: &str) -> Option<bool> {
    let trimmed = line.trim_start();
    let bytes = trimmed.as_bytes();
    if bytes.len() < 5 {
        return None;
    }
    let bullet = bytes[0];
    if !(bullet == b'-' || bullet == b'*' || bullet == b'+') {
        return None;
    }
    let after_bullet = trimmed[1..].trim_start();
    let ab = after_bullet.as_bytes();
    if ab.len() < 3 || ab[0] != b'[' || ab[2] != b']' {
        return None;
    }
    let mark = ab[1];
    if mark == b' ' {
        Some(false)
    } else if mark == b'x' || mark == b'X' {
        Some(true)
    } else {
        None
    }
}

fn todo_progress(body: &str) -> Option<(usize, usize)> {
    let mut done = 0usize;
    let mut total = 0usize;
    for line in body.lines() {
        if let Some(checked) = is_todo_line(line) {
            total += 1;
            if checked {
                done += 1;
            }
        }
    }
    if total == 0 {
        None
    } else {
        Some((done, total))
    }
}

fn title_from_body(body: &str) -> String {
    body.lines()
        .map(strip_todo_marker)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .chars()
        .take(80)
        .collect()
}

/// 从正文同步 reminders 表（正文 `[@] ms` 为准）。
/// 已到期的只留在正文展示，不再写入调度表，避免重复响铃。
fn sync_reminders_from_body(conn: &Connection, note_id: &str, body: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM reminders WHERE note_id = ?1",
        params![note_id],
    )?;
    let ts = now_ms();
    for line in body.lines() {
        let Some(remind_at) = parse_reminder_at(line) else {
            continue;
        };
        if remind_at <= ts {
            continue;
        }
        conn.execute(
            r#"
            INSERT INTO reminders (id, note_id, remind_at, created_at)
            VALUES (?1, ?2, ?3, ?4)
            "#,
            params![Uuid::new_v4().to_string(), note_id, remind_at, ts],
        )?;
    }
    Ok(())
}

fn excerpt_from(body: &str) -> String {
    // 摘要跳过首行（首行即标题）；有待办时带进度
    let rest = body
        .lines()
        .skip(1)
        .map(strip_todo_marker)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if let Some((done, total)) = todo_progress(body) {
        let progress = format!("{done}/{total}");
        if rest.is_empty() {
            return progress;
        }
        return format!("{progress} · {rest}").chars().take(56).collect();
    }
    rest.chars().take(56).collect()
}

/// 正文是否含未到期闹钟（已过期的不在花瓣上展示标记）。
fn body_has_reminder(body: &str) -> bool {
    let now = now_ms();
    body.lines().any(|line| match parse_reminder_at(line) {
        Some(at) => at > now,
        None => false,
    })
}

fn map_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteSummary> {
    let body: String = row.get(2)?;
    let color: String = row.get(3)?;
    Ok(NoteSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        excerpt: excerpt_from(&body),
        color: if color.trim().is_empty() {
            DEFAULT_NOTE_COLOR.to_string()
        } else {
            color
        },
        updated_at: row.get(4)?,
        pinned: row.get::<_, i64>(5)? != 0,
        sort_order: row.get(6)?,
        has_reminder: body_has_reminder(&body),
    })
}

fn summary_from_note(note: &crate::models::Note) -> NoteSummary {
    NoteSummary {
        id: note.id.clone(),
        title: note.title.clone(),
        excerpt: excerpt_from(&note.body),
        color: note.color.clone(),
        updated_at: note.updated_at,
        pinned: note.pinned,
        sort_order: 0,
        has_reminder: body_has_reminder(&note.body),
    }
}

const PETAL_LIST_MAX: u32 = 12;

/// 花瓣展示：按侧栏排序取前 N 条有内容便签。
pub fn list_recent(conn: &Connection, limit: u32) -> AppResult<Vec<NoteSummary>> {
    let limit = limit.clamp(1, PETAL_LIST_MAX);
    let mut stmt = conn.prepare(
        r#"
        SELECT id, title, body, color, updated_at, pinned, sort_order
        FROM notes
        WHERE deleted_at IS NULL AND trim(body) != ''
        ORDER BY sort_order ASC, created_at ASC
        LIMIT ?1
        "#,
    )?;
    let rows = stmt.query_map(params![limit], map_summary)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 花瓣列表，并把 `pin_ids`（如到期闹钟便签）置顶纳入，不受原排序位置限制。
pub fn list_recent_pinning(
    conn: &Connection,
    limit: u32,
    pin_ids: &[String],
) -> AppResult<Vec<NoteSummary>> {
    let fill_to = limit.clamp(1, PETAL_LIST_MAX) as usize;
    let mut out: Vec<NoteSummary> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for id in pin_ids {
        if out.len() as u32 >= PETAL_LIST_MAX {
            break;
        }
        let note = match get_note(conn, id) {
            Ok(n) => n,
            Err(_) => continue,
        };
        if note.deleted_at.is_some() {
            continue;
        }
        if note.body.trim().is_empty() {
            continue;
        }
        if seen.insert(note.id.clone()) {
            out.push(summary_from_note(&note));
        }
    }

    let target = fill_to.max(out.len()).min(PETAL_LIST_MAX as usize);
    for note in list_recent(conn, PETAL_LIST_MAX)? {
        if out.len() >= target {
            break;
        }
        if seen.insert(note.id.clone()) {
            out.push(note);
        }
    }

    Ok(out)
}

/// 主界面侧栏：固定 sort_order，不随点击变化。
pub fn list_ordered(conn: &Connection, limit: u32) -> AppResult<Vec<NoteSummary>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, title, body, color, updated_at, pinned, sort_order
        FROM notes
        WHERE deleted_at IS NULL
        ORDER BY sort_order ASC, created_at ASC
        LIMIT ?1
        "#,
    )?;
    let rows = stmt.query_map(params![limit], map_summary)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 按关键词搜索标题与正文，返回固定排序命中列表。
pub fn search_notes(conn: &Connection, query: &str, limit: u32) -> AppResult<Vec<NoteSummary>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = format!("%{}%", q.replace('%', "\\%").replace('_', "\\_"));
    let mut stmt = conn.prepare(
        r#"
        SELECT id, title, body, color, updated_at, pinned, sort_order
        FROM notes
        WHERE deleted_at IS NULL
          AND trim(body) != ''
          AND (title LIKE ?1 ESCAPE '\' OR body LIKE ?1 ESCAPE '\')
        ORDER BY sort_order ASC, created_at ASC
        LIMIT ?2
        "#,
    )?;
    let rows = stmt.query_map(params![pattern, limit], map_summary)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 按传入 id 顺序重写 sort_order；未出现在列表中的未删除便签追加到末尾。
pub fn reorder_notes(conn: &mut Connection, ids: &[String]) -> AppResult<()> {
    if ids.is_empty() {
        return Ok(());
    }

    let mut ordered: Vec<String> = Vec::with_capacity(ids.len());
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if seen.insert(id.clone()) {
            ordered.push(id.clone());
        }
    }

    let mut stmt = conn.prepare(
        "SELECT id FROM notes WHERE deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC",
    )?;
    let existing = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    for id in existing {
        if seen.insert(id.clone()) {
            ordered.push(id);
        }
    }

    let tx = conn.transaction()?;
    for (index, id) in ordered.iter().enumerate() {
        tx.execute(
            "UPDATE notes SET sort_order = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![index as i64, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// 按 id 读取便签。
pub fn get_note(conn: &Connection, id: &str) -> AppResult<Note> {
    conn.query_row(
        r#"
        SELECT id, title, body, color, pinned, created_at, updated_at, deleted_at
        FROM notes WHERE id = ?1
        "#,
        params![id],
        |row| {
            let color: String = row.get(3)?;
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                body: row.get(2)?,
                color: if color.trim().is_empty() {
                    DEFAULT_NOTE_COLOR.to_string()
                } else {
                    color
                },
                pinned: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                deleted_at: row.get(7)?,
            })
        },
    )
    .map_err(|err| match err {
        rusqlite::Error::QueryReturnedNoRows => {
            AppError::Message(format!("note not found: {id}"))
        }
        other => other.into(),
    })
}

/// 新建或更新便签。
pub fn upsert_note(conn: &Connection, input: UpsertNoteInput) -> AppResult<Note> {
    let ts = now_ms();
    let id = input
        .id
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let pinned = input.pinned.unwrap_or(false);
    let color = normalize_color(input.color);
    // 标题始终取正文首行，忽略前端传入的独立标题
    let title = title_from_body(&input.body);

    let existing = get_note(conn, &id);
    let note = match existing {
        Ok(old) => {
            conn.execute(
                r#"
                UPDATE notes
                SET title = ?1, body = ?2, color = ?3, pinned = ?4, updated_at = ?5
                WHERE id = ?6
                "#,
                params![
                    title,
                    input.body,
                    color,
                    if pinned { 1 } else { 0 },
                    ts,
                    id
                ],
            )?;
            Note {
                id: id.clone(),
                title,
                body: input.body.clone(),
                color,
                pinned,
                created_at: old.created_at,
                updated_at: ts,
                deleted_at: old.deleted_at,
            }
        }
        Err(AppError::Message(_)) => {
            let sort_order = next_sort_order(conn)?;
            conn.execute(
                r#"
                INSERT INTO notes (id, title, body, color, pinned, created_at, updated_at, deleted_at, sort_order)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)
                "#,
                params![
                    id,
                    title,
                    input.body,
                    color,
                    if pinned { 1 } else { 0 },
                    ts,
                    ts,
                    sort_order
                ],
            )?;
            Note {
                id: id.clone(),
                title,
                body: input.body.clone(),
                color,
                pinned,
                created_at: ts,
                updated_at: ts,
                deleted_at: None,
            }
        }
        Err(other) => return Err(other),
    };
    sync_reminders_from_body(conn, &note.id, &note.body)?;
    Ok(note)
}

/// 领取已到期提醒：
/// - **不改正文**（`[@]` 留在便签里，编辑器继续显示到期闹钟）
/// - 只从 reminders 表删除已到期行，避免重复响铃
/// - 便签挪到列表最前
pub fn claim_due_reminders(conn: &Connection) -> AppResult<Vec<String>> {
    let now = now_ms();
    let mut stmt = conn.prepare(
        r#"
        SELECT DISTINCT r.note_id
        FROM reminders r
        INNER JOIN notes n ON n.id = r.note_id
        WHERE n.deleted_at IS NULL AND r.remind_at <= ?1
        ORDER BY r.remind_at ASC
        "#,
    )?;
    let note_ids = stmt
        .query_map(params![now], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    if note_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut fired = Vec::new();
    for note_id in note_ids {
        conn.execute(
            "DELETE FROM reminders WHERE note_id = ?1 AND remind_at <= ?2",
            params![note_id, now],
        )?;
        let sort = next_sort_order(conn)?;
        conn.execute(
            r#"
            UPDATE notes
            SET sort_order = ?1, updated_at = ?2
            WHERE id = ?3 AND deleted_at IS NULL
            "#,
            params![sort, now, note_id],
        )?;
        fired.push(note_id);
    }
    Ok(fired)
}

/// 软删除便签。
pub fn soft_delete(conn: &mut Connection, id: &str) -> AppResult<()> {
    let ts = now_ms();
    let changed = conn.execute(
        "UPDATE notes SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
        params![ts, id],
    )?;
    if changed == 0 {
        return Err(AppError::Message(format!("note not found: {id}")));
    }
    let _ = conn.execute("DELETE FROM reminders WHERE note_id = ?1", params![id]);
    Ok(())
}

/// 软删除所有空白便签（未命名垃圾）。
pub fn purge_empty_notes(conn: &Connection) -> AppResult<u32> {
    let ts = now_ms();
    let _ = conn.execute(
        r#"
        DELETE FROM reminders
        WHERE note_id IN (
          SELECT id FROM notes WHERE deleted_at IS NULL AND trim(body) = ''
        )
        "#,
        [],
    );
    let changed = conn.execute(
        r#"
        UPDATE notes
        SET deleted_at = ?1, updated_at = ?1
        WHERE deleted_at IS NULL AND trim(body) = ''
        "#,
        params![ts],
    )?;
    Ok(changed as u32)
}

/// 复用已有空白草稿；没有则新建。同时清掉多余空白条。
pub fn find_or_create_draft(conn: &Connection) -> AppResult<Note> {
    let existing_id: Result<String, rusqlite::Error> = conn.query_row(
        r#"
        SELECT id FROM notes
        WHERE deleted_at IS NULL AND trim(body) = ''
        ORDER BY updated_at DESC
        LIMIT 1
        "#,
        [],
        |row| row.get(0),
    );

    match existing_id {
        Ok(id) => {
            let ts = now_ms();
            conn.execute(
                r#"
                UPDATE notes
                SET deleted_at = ?1, updated_at = ?1
                WHERE deleted_at IS NULL AND trim(body) = '' AND id != ?2
                "#,
                params![ts, id],
            )?;
            get_note(conn, &id)
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => upsert_note(
            conn,
            UpsertNoteInput {
                id: None,
                title: String::new(),
                body: String::new(),
                color: Some(DEFAULT_NOTE_COLOR.to_string()),
                pinned: Some(false),
            },
        ),
        Err(other) => Err(other.into()),
    }
}

fn settings_get_raw(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

fn settings_set_raw(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        r#"
        INSERT INTO settings (key, value) VALUES (?1, ?2)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
        params![key, value],
    )?;
    Ok(())
}

/// 读取应用设置，缺失时写入默认值。
pub fn load_settings(conn: &Connection) -> AppResult<AppSettings> {
    match settings_get_raw(conn, "app")? {
        Some(raw) => {
            let mut settings: AppSettings = serde_json::from_str(&raw)?;
            let normalized = if settings.locale.eq_ignore_ascii_case("en") {
                "en"
            } else {
                "zh"
            };
            if settings.locale != normalized {
                settings.locale = normalized.into();
                save_settings(conn, &settings)?;
            }
            Ok(settings)
        }
        None => {
            let defaults = AppSettings::default();
            save_settings(conn, &defaults)?;
            Ok(defaults)
        }
    }
}

/// 保存完整设置对象。
pub fn save_settings(conn: &Connection, settings: &AppSettings) -> AppResult<()> {
    let raw = serde_json::to_string(settings)?;
    settings_set_raw(conn, "app", &raw)?;
    Ok(())
}
