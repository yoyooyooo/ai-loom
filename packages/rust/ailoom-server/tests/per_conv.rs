use std::time::Duration;

use codex_app_server_protocol::NewConversationParams;
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
    std::env::set_var("AILOOM_CODEX_CHILD_GC_INTERVAL_MS", "0");

    let workspace = std::env::current_dir()?;
    let mut params = NewConversationParams::default();
    params.cwd = Some(workspace.to_string_lossy().to_string());

    let cid1 = timeout(
        Duration::from_secs(30),
        ailoom_server::services::codex::registry::spawn_new(
            workspace.clone(),
            None,
            params.clone(),
        ),
    )
    .await??;
    let cid2 = timeout(
        Duration::from_secs(30),
        ailoom_server::services::codex::registry::spawn_new(workspace.clone(), None, params),
    )
    .await??;

    assert_ne!(cid1, cid2);

    let _ = ailoom_server::services::codex::registry::hard_kill(&cid1).await;
    let _ = ailoom_server::services::codex::registry::hard_kill(&cid2).await;

    Ok(())
}
