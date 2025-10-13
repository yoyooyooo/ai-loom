use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
};
use local_deployment::LocalDeployment;
use db::models::{Entity, CreateEntity, UpdateEntity};

/// List all entities
pub async fn list_entities(
    State(deployment): State<LocalDeployment>,
) -> Result<Json<Vec<Entity>>, StatusCode> {
    match deployment.entity_service.list_entities().await {
        Ok(entities) => Ok(Json(entities)),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// Create a new entity
pub async fn create_entity(
    State(deployment): State<LocalDeployment>,
    Json(create_entity): Json<CreateEntity>,
) -> Result<Json<Entity>, StatusCode> {
    match deployment.entity_service.create_entity(create_entity).await {
        Ok(entity) => Ok(Json(entity)),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// Get entity by ID
pub async fn get_entity(
    State(deployment): State<LocalDeployment>,
    Path(id): Path<String>,
) -> Result<Json<Entity>, StatusCode> {
    match deployment.entity_service.get_entity(id).await {
        Ok(Some(entity)) => Ok(Json(entity)),
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// Update entity
pub async fn update_entity(
    State(deployment): State<LocalDeployment>,
    Path(id): Path<String>,
    Json(update_entity): Json<UpdateEntity>,
) -> Result<Json<Entity>, StatusCode> {
    match deployment.entity_service.update_entity(id, update_entity).await {
        Ok(Some(entity)) => Ok(Json(entity)),
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// Delete entity
pub async fn delete_entity(
    State(deployment): State<LocalDeployment>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    match deployment.entity_service.delete_entity(id).await {
        Ok(true) => Ok(StatusCode::NO_CONTENT),
        Ok(false) => Err(StatusCode::NOT_FOUND),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}