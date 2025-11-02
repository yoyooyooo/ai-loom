use std::collections::HashMap;
use std::sync::Arc;

use ailoom_executors::{
    ProviderError, RuntimeSnapshot, SharedProvider, SpawnConfig, StandardProvider,
};
use tokio::sync::RwLock;

/// Provider 无关的运行时调度器。
#[derive(Default, Clone)]
pub struct RuntimeRegistry {
    providers: Arc<RwLock<HashMap<String, SharedProvider>>>,
}

impl RuntimeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register_provider<P>(&self, provider: Arc<P>)
    where
        P: StandardProvider + 'static,
    {
        let mut guard = self.providers.write().await;
        guard.insert(provider.id().to_string(), provider as SharedProvider);
    }

    async fn provider(&self, id: &str) -> Result<SharedProvider, ProviderError> {
        let guard = self.providers.read().await;
        guard
            .get(id)
            .cloned()
            .ok_or_else(|| ProviderError::Unavailable(format!("provider {:?} not registered", id)))
    }

    pub async fn provider_ids(&self) -> Vec<String> {
        let guard = self.providers.read().await;
        guard.keys().cloned().collect()
    }

    pub async fn new_conversation(
        &self,
        provider: &str,
        config: SpawnConfig,
    ) -> Result<String, ProviderError> {
        let provider = self.provider(provider).await?;
        provider.new_conversation(config).await
    }

    pub async fn runtime_snapshots(&self, provider: Option<&str>) -> Vec<RuntimeSnapshot> {
        let providers: Vec<SharedProvider> = {
            let guard = self.providers.read().await;
            guard.values().cloned().collect()
        };

        if let Some(id) = provider {
            if let Some(p) = providers.into_iter().find(|p| p.id() == id) {
                return p.runtime_snapshots().await;
            }
            return Vec::new();
        }

        let mut snapshots = Vec::new();
        for provider in providers.into_iter() {
            snapshots.extend(provider.runtime_snapshots().await);
        }
        snapshots
    }

    pub async fn warm_conversation(
        &self,
        provider: &str,
        conversation_id: &str,
    ) -> Result<(), ProviderError> {
        let provider = self.provider(provider).await?;
        provider.ensure_listener(conversation_id).await
    }

    pub async fn terminate_conversation(
        &self,
        provider: &str,
        conversation_id: &str,
    ) -> Result<(), ProviderError> {
        let provider = self.provider(provider).await?;
        provider.terminate(conversation_id).await
    }

    pub async fn send_user_message(
        &self,
        provider: &str,
        conversation_id: &str,
        text: &str,
    ) -> Result<(), ProviderError> {
        let provider = self.provider(provider).await?;
        provider.send_user_message(conversation_id, text).await
    }

    pub async fn interrupt_conversation(
        &self,
        provider: &str,
        conversation_id: &str,
    ) -> Result<(), ProviderError> {
        let provider = self.provider(provider).await?;
        provider.interrupt(conversation_id).await
    }

    pub async fn is_runtime_alive(
        &self,
        provider: &str,
        conversation_id: &str,
    ) -> Result<bool, ProviderError> {
        let provider = self.provider(provider).await?;
        provider.is_alive(conversation_id).await
    }
}
