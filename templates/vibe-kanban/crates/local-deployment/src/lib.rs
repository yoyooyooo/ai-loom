use anyhow::Result;
use db::Database;
use services::EntityService;

/// Local deployment configuration and dependency injection
#[derive(Clone)]
pub struct LocalDeployment {
    pub entity_service: EntityService,
}

impl LocalDeployment {
    /// Initialize all services and dependencies
    pub async fn new() -> Result<Self> {
        tracing::info!("Initializing database...");
        let database = Database::new().await?;
        let pool = database.pool().clone();

        tracing::info!("Initializing services...");
        let entity_service = EntityService::new(pool);

        Ok(Self {
            entity_service,
        })
    }
}