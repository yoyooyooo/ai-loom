use std::path::{Path, PathBuf};

use axum::{http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};

use crate::state::AppState;

use super::utils::resolve_rollout_path;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckVibeLinkRequest {
    pub conversation_id: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckVibeLinkResponse {
    pub associated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_title: Option<String>,
}

pub async fn check_vibe_link(
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(body): Json<CheckVibeLinkRequest>,
) -> impl IntoResponse {
    if !feature_enabled() {
        return (
            StatusCode::OK,
            Json(CheckVibeLinkResponse {
                associated: false,
                project_id: None,
                task_id: None,
                project_name: None,
                task_title: None,
            }),
        )
            .into_response();
    }
    // 1) 解析会话 ID（优先使用传入的 conversation_id；否则从 rollout JSONL 顶部 session_meta 提取）
    let session_id = if let Some(id) = body
        .conversation_id
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        Some(id.to_string())
    } else if let Some(path_raw) = body.path.as_deref() {
        if let Some(path) = resolve_rollout_path(path_raw, &state.workspace_root) {
            extract_first_session_meta_id(&path)
        } else {
            None
        }
    } else {
        None
    };

    let Some(session_id) = session_id else {
        return (
            StatusCode::OK,
            Json(CheckVibeLinkResponse {
                associated: false,
                project_id: None,
                task_id: None,
                project_name: None,
                task_title: None,
            }),
        )
            .into_response();
    };

    // 2) 定位 vibe-kanban 的 SQLite DB
    let Some(db_path) = resolve_vibe_db_path() else {
        return (
            StatusCode::OK,
            Json(CheckVibeLinkResponse {
                associated: false,
                project_id: None,
                task_id: None,
                project_name: None,
                task_title: None,
            }),
        )
            .into_response();
    };

    // 3) 查询映射关系：executor_sessions → task_attempts → tasks → projects
    match query_vibe_link(&db_path, &session_id).await {
        Ok(Some((project_id, task_id, project_name, task_title))) => (
            StatusCode::OK,
            Json(CheckVibeLinkResponse {
                associated: true,
                project_id: Some(project_id),
                task_id: Some(task_id),
                project_name,
                task_title,
            }),
        )
            .into_response(),
        Ok(None) => (
            StatusCode::OK,
            Json(CheckVibeLinkResponse {
                associated: false,
                project_id: None,
                task_id: None,
                project_name: None,
                task_title: None,
            }),
        )
            .into_response(),
        Err(err) => {
            tracing::warn!(target:"chat", error=%err, db=%db_path.display(), "vibe link 查询失败");
            (
                StatusCode::OK,
                Json(CheckVibeLinkResponse {
                    associated: false,
                    project_id: None,
                    task_id: None,
                    project_name: None,
                    task_title: None,
                }),
            )
                .into_response()
        }
    }
}

fn extract_first_session_meta_id(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(16) {
        let Ok(l) = line else { break };
        let s = l.trim();
        if s.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(s) else {
            break;
        };
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if t == "session_meta" {
            if let Some(id) = v
                .get("payload")
                .and_then(|p| p.get("id"))
                .and_then(|x| x.as_str())
            {
                return Some(id.to_string());
            } else {
                break;
            }
        } else {
            break;
        }
    }
    None
}

fn resolve_vibe_db_path() -> Option<PathBuf> {
    // 1) 显式环境变量（优先）
    if let Ok(p) = std::env::var("VIBE_KANBAN_DB_PATH") {
        let path = PathBuf::from(p);
        if path.exists() {
            return Some(path);
        }
    }
    if let Ok(p) = std::env::var("VIBE_KANBAN_DB") {
        let path = PathBuf::from(p);
        if path.exists() {
            return Some(path);
        }
    }
    // 2) 开发模式（若提供仓库路径）
    if let Ok(repo) = std::env::var("VIBE_KANBAN_REPO_DIR") {
        let dev = PathBuf::from(repo).join("dev_assets/db.sqlite");
        if dev.exists() {
            return Some(dev);
        }
    }
    // 3) 生产安装位置（平台默认）
    if let Some(base) = dirs::data_dir() {
        // macOS: ~/Library/Application Support
        // Linux: ~/.local/share
        // Windows: %APPDATA%
        // 兼容两种层级：ai.bloop.vibe-kanban / ai/bloop/vibe-kanban
        let candidate1 = base.join("ai.bloop.vibe-kanban/db.sqlite");
        if candidate1.exists() {
            return Some(candidate1);
        }
        let candidate2 = base.join("ai/bloop/vibe-kanban/db.sqlite");
        if candidate2.exists() {
            return Some(candidate2);
        }
    }
    None
}

async fn query_vibe_link(
    db_path: &Path,
    session_id: &str,
) -> Result<Option<(String, String, Option<String>, Option<String>)>, anyhow::Error> {
    use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions, Row};

    let opts = SqliteConnectOptions::new()
        .filename(db_path)
        // 只读连接（尽力而为；旧版 sqlite 驱动可能忽略）
        .log_statements(log::LevelFilter::Off);

    let pool = sqlx::SqlitePool::connect_with(opts).await?;
    let row = sqlx::query(
        r#"
        SELECT
          p.id   AS project_id,
          t.id   AS task_id,
          p.name AS project_name,
          t.title AS task_title
        FROM executor_sessions es
        JOIN task_attempts ta ON es.task_attempt_id = ta.id
        JOIN tasks t ON ta.task_id = t.id
        JOIN projects p ON t.project_id = p.id
        WHERE es.session_id = ?1
        LIMIT 1
        "#,
    )
    .bind(session_id)
    .fetch_optional(&pool)
    .await?;

    if let Some(r) = row {
        let project_id: String = r.try_get("project_id")?;
        let task_id: String = r.try_get("task_id")?;
        let project_name: Option<String> = r.try_get("project_name").ok();
        let task_title: Option<String> = r.try_get("task_title").ok();
        Ok(Some((project_id, task_id, project_name, task_title)))
    } else {
        Ok(None)
    }
}

fn feature_enabled() -> bool {
    let v = std::env::var("AILOOM_VIBE_LINK").unwrap_or_default();
    matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")
}
