use anyhow::Result;
use db::models::{Entity, CreateEntity, UpdateEntity};
use sqlx::SqlitePool;

/// Business logic for entity operations
#[derive(Clone)]
pub struct EntityService {
    pool: SqlitePool,
}

impl EntityService {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Create a new entity
    pub async fn create_entity(&self, create_entity: CreateEntity) -> Result<Entity> {
        let entity = Entity::create(&self.pool, create_entity).await?;
        Ok(entity)
    }

    /// Get entity by ID
    pub async fn get_entity(&self, id: String) -> Result<Option<Entity>> {
        let entity = Entity::get_by_id(&self.pool, id).await?;
        Ok(entity)
    }

    /// List all entities
    pub async fn list_entities(&self) -> Result<Vec<Entity>> {
        let entities = Entity::list_all(&self.pool).await?;
        Ok(entities)
    }

    /// Update entity
    pub async fn update_entity(&self, id: String, update_entity: UpdateEntity) -> Result<Option<Entity>> {
        let entity = Entity::update(&self.pool, id, update_entity).await?;
        Ok(entity)
    }

    /// Delete entity
    pub async fn delete_entity(&self, id: String) -> Result<bool> {
        let deleted = Entity::delete(&self.pool, id).await?;
        Ok(deleted)
    }
}