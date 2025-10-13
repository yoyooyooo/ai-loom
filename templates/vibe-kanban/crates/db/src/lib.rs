pub mod models;

use std::{fs::File, path::Path, str::FromStr};

use anyhow::Result;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    SqlitePool,
};

/// Database connection manager
pub struct Database {
    pool: SqlitePool,
}

impl Database {
    /// Create new database connection
    pub async fn new() -> Result<Self> {
        let database_url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "sqlite://./vibe-starter.db".to_string());

        ensure_sqlite_file_exists(&database_url)?;

        let connect_options =
            SqliteConnectOptions::from_str(&database_url)?.create_if_missing(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(10)
            .connect_with(connect_options)
            .await?;

        // Run migrations - sqlx::migrate! looks for migrations relative to the crate root
        sqlx::migrate!().run(&pool).await?;

        Ok(Self { pool })
    }

    /// Get database pool
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

fn ensure_sqlite_file_exists(database_url: &str) -> Result<()> {
    const SQLITE_PREFIX: &str = "sqlite://";

    if !database_url.starts_with(SQLITE_PREFIX) {
        // Non-SQLite URLs (e.g. mocks/tests) are ignored.
        return Ok(());
    }

    let path_part = &database_url[SQLITE_PREFIX.len()..];

    // In-memory DBs use the `:memory:` pseudo file; no file handling needed.
    if path_part.starts_with(":") {
        return Ok(());
    }

    // Normalize leading slashes so both `sqlite://./foo` 与 `sqlite:///foo` 生效。
    let normalized = path_part.trim_start_matches('/');
    if normalized.is_empty() {
        return Ok(());
    }

    let db_path = Path::new(normalized);
    if let Some(parent) = db_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    if !db_path.exists() {
        File::create(db_path)?;
    }

    Ok(())
}
