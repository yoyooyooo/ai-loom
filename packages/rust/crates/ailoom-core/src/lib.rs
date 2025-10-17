use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String, // relative to root
    pub r#type: EntryType,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryType {
    File,
    Dir,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChunk {
    pub path: String,
    pub language: String,
    pub size: u64,
    pub total_lines: usize,
    pub start_line: usize,
    pub end_line: usize,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("invalid path")]
    InvalidPath,
    #[error("not found")]
    NotFound,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub fn guess_language_by_ext(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|ext| match ext {
            "rs" => "rust",
            "ts" => "typescript",
            "tsx" => "typescript",
            "js" => "javascript",
            "jsx" => "javascript",
            "json" => "json",
            "md" => "markdown",
            "css" => "css",
            "html" => "html",
            _ => "plaintext",
        })
        .unwrap_or("plaintext")
        .to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub file_path: String,
    pub start_line: i64,
    pub end_line: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_column: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<i64>,
    pub selected_text: String,
    pub comment: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_context_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_context_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>, // P0 | P1 | P2
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAnnotation {
    pub file_path: String,
    pub start_line: i64,
    pub end_line: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_column: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<i64>,
    pub selected_text: String,
    pub comment: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_context_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_context_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAnnotation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_column: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_context_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_context_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
}
