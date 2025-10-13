use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use ts_rs::TS;

/// Main entity model - replace with your actual entity
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export, export_to = "../shared/types.ts")]
pub struct Entity {
    pub id: String, // UUID stored as string for SQLite compatibility
    pub name: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Create entity request
#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../shared/types.ts")]
pub struct CreateEntity {
    pub name: String,
    pub description: Option<String>,
}

/// Update entity request
#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../shared/types.ts")]
pub struct UpdateEntity {
    pub name: Option<String>,
    pub description: Option<String>,
}

impl Entity {
    /// Create a new entity
    pub async fn create(
        pool: &sqlx::SqlitePool,
        create_entity: CreateEntity,
    ) -> Result<Self, sqlx::Error> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        let entity = sqlx::query_as::<_, Self>(
            r#"
            INSERT INTO entities (id, name, description, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            RETURNING *
            "#,
        )
        .bind(id)
        .bind(create_entity.name)
        .bind(create_entity.description)
        .bind(&now)
        .bind(&now)
        .fetch_one(pool)
        .await?;

        Ok(entity)
    }

    /// Get entity by ID
    pub async fn get_by_id(
        pool: &sqlx::SqlitePool,
        id: String,
    ) -> Result<Option<Self>, sqlx::Error> {
        let entity = sqlx::query_as::<_, Self>(
            "SELECT * FROM entities WHERE id = ?1"
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;

        Ok(entity)
    }

    /// Get all entities
    pub async fn list_all(
        pool: &sqlx::SqlitePool,
    ) -> Result<Vec<Self>, sqlx::Error> {
        let entities = sqlx::query_as::<_, Self>(
            "SELECT * FROM entities ORDER BY created_at DESC"
        )
        .fetch_all(pool)
        .await?;

        Ok(entities)
    }

    /// Update entity
    pub async fn update(
        pool: &sqlx::SqlitePool,
        id: String,
        update_entity: UpdateEntity,
    ) -> Result<Option<Self>, sqlx::Error> {
        let now = chrono::Utc::now().to_rfc3339();

        let entity = sqlx::query_as::<_, Self>(
            r#"
            UPDATE entities 
            SET 
                name = COALESCE(?2, name),
                description = COALESCE(?3, description),
                updated_at = ?4
            WHERE id = ?1
            RETURNING *
            "#,
        )
        .bind(id)
        .bind(update_entity.name)
        .bind(update_entity.description)
        .bind(&now)
        .fetch_optional(pool)
        .await?;

        Ok(entity)
    }

    /// Delete entity
    pub async fn delete(
        pool: &sqlx::SqlitePool,
        id: String,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query("DELETE FROM entities WHERE id = ?1")
            .bind(id)
            .execute(pool)
            .await?;

        Ok(result.rows_affected() > 0)
    }
}