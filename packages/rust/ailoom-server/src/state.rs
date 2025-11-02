use crate::services::executors::registry::RuntimeRegistry;
use ailoom_fs::FsConfig;
use ailoom_store::Store;
use std::path::PathBuf;

#[derive(Clone)]
pub struct AppState {
    pub fs: FsConfig,
    pub store: Store,
    pub root: PathBuf,
    pub workspace_root: PathBuf,
    pub ws_hub: Option<crate::ws::hub::Hub>,
    pub runtime_registry: RuntimeRegistry,
}
