use std::time::Duration;

use ailoom_executors::{providers::codex::CodexProvider, SpawnConfig};
use ailoom_server::services::executors::registry::RuntimeRegistry;
use tokio::time::timeout;

/// 验证 per-conv 子进程两次连续创建不会阻塞。
///
/// 该测试需要本地可执行 `npx @openai/codex`；默认忽略，手动运行：
/// `cargo test -p ailoom-server per_conv::spawn_two_conversations -- --ignored`
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires Codex app-server (npx @openai/codex)"]
async fn spawn_two_conversations() -> anyhow::Result<()> {
    std::env::set_var("AILOOM_CODEX_MODE", "per_conv");
    if std::env::var("CODEX_VERSION").is_err() {
        std::env::set_var("CODEX_VERSION", "0.53.0");
    }
    // 关闭自动 GC，避免测试期子进程被背景回收
    std::env::set_var("AILOOM_EXEC_GC_INTERVAL_MS", "0");

    let workspace = std::env::current_dir()?;
    let registry = RuntimeRegistry::new();
    registry
        .register_provider(CodexProvider::new(workspace.clone(), None))
        .await;

    let spawn_config = SpawnConfig::default();
    let cid1 = timeout(
        Duration::from_secs(30),
        registry.new_conversation("codex", spawn_config.clone()),
    )
    .await??;
    let cid2 = timeout(
        Duration::from_secs(30),
        registry.new_conversation("codex", spawn_config),
    )
    .await??;

    assert_ne!(cid1, cid2);

    let _ = registry.terminate_conversation("codex", &cid1).await;
    let _ = registry.terminate_conversation("codex", &cid2).await;

    Ok(())
}
