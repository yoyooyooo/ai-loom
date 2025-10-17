use ailoom_core as core;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous};
use sqlx::Row;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlx error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

#[derive(Clone)]
pub struct Store {
    pool: sqlx::SqlitePool,
    workspace_id: String,
}

impl Store {
    /// Connect to sqlite file path and scope to a workspace (by key -> id mapping).
    pub async fn connect_path(path: &Path, workspace_key: &str) -> Result<Self, StoreError> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(8)
            .after_connect(|conn, _meta| Box::pin(async move {
                // Enforce referential integrity on every connection
                sqlx::query("PRAGMA foreign_keys=ON;").execute(conn).await?;
                Ok(())
            }))
            .connect_with(options)
            .await?;
        let mut s = Self { pool, workspace_id: workspace_key.to_string() };
        s.migrate().await?;
        // ensure workspace row and get id; use workspace_key as root_path fallback
        let ws_id = s
            .ensure_workspace_get_id(workspace_key, workspace_key)
            .await?;
        s.workspace_id = ws_id;
        Ok(s)
    }

    /// Connect via database URL and scope to a workspace key.
    pub async fn connect(database_url: &str, workspace_key: &str) -> Result<Self, StoreError> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(8)
            .after_connect(|conn, _meta| Box::pin(async move {
                sqlx::query("PRAGMA foreign_keys=ON;").execute(conn).await?;
                Ok(())
            }))
            .connect(database_url)
            .await?;
        let mut s = Self { pool, workspace_id: workspace_key.to_string() };
        s.migrate().await?;
        let ws_id = s
            .ensure_workspace_get_id(workspace_key, workspace_key)
            .await?;
        s.workspace_id = ws_id;
        Ok(s)
    }

    async fn migrate(&self) -> Result<(), StoreError> {
        // Pragmas
        sqlx::query("PRAGMA journal_mode=WAL;")
            .execute(&self.pool)
            .await?;
        sqlx::query("PRAGMA synchronous=NORMAL;")
            .execute(&self.pool)
            .await?;
        sqlx::query("PRAGMA busy_timeout=3000;")
            .execute(&self.pool)
            .await?;

        // Workspaces table first: referenced by annotations FK
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS workspaces (
                id TEXT PRIMARY KEY,
                key TEXT UNIQUE NOT NULL,
                root_path TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            "#,
        )
        .execute(&self.pool)
        .await?;

        // Annotations with explicit FK to workspaces(id)
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS annotations (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                start_column INTEGER,
                end_column INTEGER,
                selected_text TEXT NOT NULL,
                comment TEXT NOT NULL,
                pre_context_hash TEXT,
                post_context_hash TEXT,
                file_digest TEXT,
                tags TEXT,
                priority TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
                    ON DELETE RESTRICT
                    ON UPDATE CASCADE
            );
            "#,
        )
        .execute(&self.pool)
        .await?;

        // Clean schema (fresh DB expected during development). No legacy backfill.

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_annotations_file_path ON annotations(file_path);",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_annotations_created_at ON annotations(created_at);",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_annotations_file_span_created ON annotations(file_path, start_line, end_line, created_at);")
            .execute(&self.pool)
            .await?;
        // workspace-scoped indices
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_annotations_ws_id ON annotations(workspace_id);")
            .execute(&self.pool)
            .await?;
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_annotations_ws_id_file ON annotations(workspace_id, file_path);")
            .execute(&self.pool)
            .await?;
        // workspace indices
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_workspaces_updated_at ON workspaces(updated_at);")
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Upsert current workspace row by unique `key` and return its id (UUID-like or existing).
    pub async fn ensure_workspace_get_id(&self, key: &str, root_path: &str) -> Result<String, StoreError> {
        // Try select existing by key
        if let Some(row) = sqlx::query("SELECT id FROM workspaces WHERE key = ?1")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?
        {
            let id: String = row.get::<String, _>("id");
            // Update root_path/updated_at for hygiene
            let _ = sqlx::query(
                "UPDATE workspaces SET root_path=?2, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE key=?1",
            )
            .bind(key)
            .bind(root_path)
            .execute(&self.pool)
            .await;
            return Ok(id);
        }
        // Insert new row with generated id
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            r#"INSERT INTO workspaces (id, key, root_path, created_at, updated_at)
               VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))"#,
        )
        .bind(&id)
        .bind(key)
        .bind(root_path)
        .execute(&self.pool)
        .await?;
        Ok(id)
    }

    pub async fn list_annotations(&self) -> Result<Vec<core::Annotation>, StoreError> {
        let rows = sqlx::query_as::<_, AnnotationRow>(
            r#"SELECT id, file_path, start_line, end_line, start_column, end_column, selected_text, comment,
               pre_context_hash, post_context_hash, file_digest, tags, priority, created_at, updated_at
               FROM annotations WHERE workspace_id = ?1 ORDER BY created_at DESC"#
        )
        .bind(&self.workspace_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(AnnotationRow::into_core).collect())
    }

    pub async fn insert_annotation(&self, ann: &core::Annotation) -> Result<(), StoreError> {
        sqlx::query(
            r#"INSERT INTO annotations
               (id, file_path, start_line, end_line, start_column, end_column, selected_text, comment,
                pre_context_hash, post_context_hash, file_digest, tags, priority, created_at, updated_at, workspace_id)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)"#,
        )
        .bind(&ann.id)
        .bind(&ann.file_path)
        .bind(ann.start_line)
        .bind(ann.end_line)
        .bind(ann.start_column)
        .bind(ann.end_column)
        .bind(&ann.selected_text)
        .bind(&ann.comment)
        .bind(&ann.pre_context_hash)
        .bind(&ann.post_context_hash)
        .bind(&ann.file_digest)
        .bind(ann.tags.as_ref().map(|v| serde_json::to_string(v).unwrap_or("[]".into())))
        .bind(&ann.priority)
        .bind(&ann.created_at)
        .bind(&ann.updated_at)
        .bind(&self.workspace_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_annotation(&self, id: &str) -> Result<Option<core::Annotation>, StoreError> {
        let r = sqlx::query_as::<_, AnnotationRow>(
            r#"SELECT id, file_path, start_line, end_line, start_column, end_column, selected_text, comment,
                pre_context_hash, post_context_hash, file_digest, tags, priority, created_at, updated_at
                FROM annotations WHERE id = ?1 AND workspace_id = ?2"#
        )
        .bind(id)
        .bind(&self.workspace_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(r.map(AnnotationRow::into_core))
    }

    pub async fn update_annotation(&self, ann: &core::Annotation) -> Result<(), StoreError> {
        sqlx::query(
            r#"UPDATE annotations SET
                file_path=?2, start_line=?3, end_line=?4, start_column=?5, end_column=?6,
                selected_text=?7, comment=?8, pre_context_hash=?9, post_context_hash=?10, file_digest=?11,
                tags=?12, priority=?13, created_at=?14, updated_at=?15
              WHERE id=?1 AND workspace_id=?16"#
        )
        .bind(&ann.id)
        .bind(&ann.file_path)
        .bind(ann.start_line)
        .bind(ann.end_line)
        .bind(ann.start_column)
        .bind(ann.end_column)
        .bind(&ann.selected_text)
        .bind(&ann.comment)
        .bind(&ann.pre_context_hash)
        .bind(&ann.post_context_hash)
        .bind(&ann.file_digest)
        .bind(ann.tags.as_ref().map(|v| serde_json::to_string(v).unwrap_or("[]".into())))
        .bind(&ann.priority)
        .bind(&ann.created_at)
        .bind(&ann.updated_at)
        .bind(&self.workspace_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_annotation(&self, id: &str) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM annotations WHERE id=?1 AND workspace_id=?2")
            .bind(id)
            .bind(&self.workspace_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn export_all(&self) -> Result<Vec<core::Annotation>, StoreError> {
        self.list_annotations().await
    }

    pub async fn import_annotations(
        &self,
        anns: &[core::Annotation],
    ) -> Result<(u64, u64, u64), StoreError> {
        let mut added = 0u64;
        let mut updated = 0u64;
        let mut skipped = 0u64;
        for a in anns {
            let existing = self.get_annotation(&a.id).await?;
            if let Some(old) = existing {
                if a.updated_at > old.updated_at {
                    self.update_annotation(a).await?;
                    updated += 1;
                } else {
                    skipped += 1;
                }
            } else {
                self.insert_annotation(a).await?;
                added += 1;
            }
        }
        Ok((added, updated, skipped))
    }
}

impl Store {
    pub async fn list_annotations_by_ids(
        &self,
        ids: &[String],
    ) -> Result<Vec<core::Annotation>, StoreError> {
        if ids.is_empty() {
            return self.list_annotations().await;
        }
        // Dynamically build IN clause (scoped by workspace_id)
        let mut q = String::from("SELECT id, file_path, start_line, end_line, start_column, end_column, selected_text, comment, pre_context_hash, post_context_hash, file_digest, tags, priority, created_at, updated_at FROM annotations WHERE workspace_id = ?1 AND id IN (");
        for i in 0..ids.len() {
            if i > 0 {
                q.push(',');
            }
            q.push('?');
            q.push_str(&(i + 2).to_string());
        }
        q.push(')');
        let mut query = sqlx::query_as::<_, AnnotationRow>(&q).bind(&self.workspace_id);
        for id in ids {
            query = query.bind(id);
        }
        let rows = query.fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(AnnotationRow::into_core).collect())
    }
}

#[derive(Debug, sqlx::FromRow)]
struct AnnotationRow {
    id: String,
    file_path: String,
    start_line: i64,
    end_line: i64,
    start_column: Option<i64>,
    end_column: Option<i64>,
    selected_text: String,
    comment: String,
    pre_context_hash: Option<String>,
    post_context_hash: Option<String>,
    file_digest: Option<String>,
    tags: Option<String>,
    priority: Option<String>,
    created_at: String,
    updated_at: String,
}

impl AnnotationRow {
    fn into_core(self) -> core::Annotation {
        core::Annotation {
            id: self.id,
            file_path: self.file_path,
            start_line: self.start_line,
            end_line: self.end_line,
            start_column: self.start_column,
            end_column: self.end_column,
            selected_text: self.selected_text,
            comment: self.comment,
            pre_context_hash: self.pre_context_hash,
            post_context_hash: self.post_context_hash,
            file_digest: self.file_digest,
            tags: self.tags.and_then(|s| serde_json::from_str(&s).ok()),
            priority: self.priority,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}
