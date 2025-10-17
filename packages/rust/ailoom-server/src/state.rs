use ailoom_fs::FsConfig;
use ailoom_store::Store;
use std::path::PathBuf;

#[derive(Clone)]
pub struct AppState {
  pub fs: FsConfig,
  pub store: Store,
  pub root: PathBuf,
  pub workspace_root: PathBuf,
}

