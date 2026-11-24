use serde::{Deserialize, Serialize};

pub const DEFAULT_NOTE_COLOR: &str = "#dfdfdb";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    pub body: String,
    pub color: String,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub excerpt: String,
    pub color: String,
    pub updated_at: i64,
    pub pinned: bool,
    #[serde(default)]
    pub sort_order: i64,
    /// 正文是否含未到期闹钟（花瓣标记；过期不展示）
    #[serde(default)]
    pub has_reminder: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertNoteInput {
    pub id: Option<String>,
    pub title: String,
    pub body: String,
    pub color: Option<String>,
    pub pinned: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub petal_count: u32,
    pub orb_visible: bool,
    pub orb_x: f64,
    pub orb_y: f64,
    pub hotkey_new: String,
    pub hotkey_orb: String,
    /// zh | en
    #[serde(default = "default_locale")]
    pub locale: String,
}

fn default_locale() -> String {
    "zh".into()
}

impl Default for AppSettings {
    fn default() -> Self {
        let hotkey_new = if cfg!(target_os = "macos") {
            "Command+Shift+N"
        } else {
            "Control+Shift+N"
        }
        .to_string();
        let hotkey_orb = if cfg!(target_os = "macos") {
            "Command+Shift+Space"
        } else {
            "Control+Shift+Space"
        }
        .to_string();
        Self {
            petal_count: 8,
            orb_visible: true,
            orb_x: 120.0,
            orb_y: 120.0,
            hotkey_new,
            hotkey_orb,
            locale: default_locale(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorOpenPayload {
    pub mode: String,
    pub id: Option<String>,
}

/// 单条导出便签（含排序，便于导入后保持相对顺序）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupNote {
    pub id: String,
    pub title: String,
    pub body: String,
    pub color: String,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub sort_order: i64,
}

/// 花记 JSON 备份文件根结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub format: String,
    pub version: u32,
    pub exported_at: i64,
    pub notes: Vec<BackupNote>,
}

impl BackupFile {
    pub const FORMAT: &'static str = "petaljot-backup";
    pub const VERSION: u32 = 1;
}

/// 导入统计：新增 / 覆盖更新 / 因本地更新而不覆盖。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStats {
    pub inserted: u32,
    pub updated: u32,
    pub skipped: u32,
}
