use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::Duration;

use ailoom_executors::{providers::codex::CodexProvider, SpawnConfig};
use ailoom_server::services::executors::registry::RuntimeRegistry;
use anyhow::Result;
use tokio::time::timeout;

/// 覆盖 per-conv 流程：新建 + 发送 + 关闭 → 第二轮重复
/// 运行前需确保本机可执行 `npx @openai/codex@0.53.0 app-server`
/// 手动执行：`cargo test -p ailoom-server codex_flow::full_flow -- --ignored`
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires Codex app-server"]
async fn full_flow() -> Result<()> {
    std::env::set_var("AILOOM_CODEX_MODE", "per_conv");
    if std::env::var("CODEX_VERSION").is_err() {
        std::env::set_var("CODEX_VERSION", "0.53.0");
    }
    let workspace = std::env::current_dir()?;
    std::env::set_var("AILOOM_EXEC_GC_INTERVAL_MS", "0");

    let registry = RuntimeRegistry::new();
    registry
        .register_provider(CodexProvider::new(workspace.clone(), None))
        .await;

    let cid1 = run_round(registry.clone(), "1+1=?").await?;
    ensure_session_contains_answer(&cid1, "2").await?;
    let cid2 = run_round(registry.clone(), "2+2=?").await?;
    ensure_session_contains_answer(&cid2, "4").await?;
    Ok(())
}

async fn run_round(registry: RuntimeRegistry, prompt: &str) -> Result<String> {
    let spawn_config = SpawnConfig::default();
    let cid = timeout(
        Duration::from_secs(90),
        registry.new_conversation("codex", spawn_config.clone()),
    )
    .await
    .map_err(|_| anyhow::anyhow!("timeout waiting for new_conversation"))?
    .map_err(|e| anyhow::anyhow!(e.to_string()))?;

    timeout(
        Duration::from_secs(90),
        registry.send_user_message("codex", &cid, prompt),
    )
    .await
    .map_err(|_| anyhow::anyhow!("timeout waiting for send_user_message"))?
    .map_err(|e| anyhow::anyhow!(e.to_string()))?;

    timeout(
        Duration::from_secs(45),
        registry.interrupt_conversation("codex", &cid),
    )
    .await
    .map_err(|_| anyhow::anyhow!("timeout waiting for interrupt_conversation"))?
    .map_err(|e| anyhow::anyhow!(e.to_string()))?;

    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = registry.terminate_conversation("codex", &cid).await;
    Ok(cid)
}

async fn ensure_session_contains_answer(cid: &str, expected: &str) -> Result<PathBuf> {
    for _ in 0..10 {
        if let Some(path) = find_session_file(cid) {
            if session_has_answer(&path, expected)? {
                return Ok(path);
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(anyhow::anyhow!("session file for {} not found", cid))
}

fn find_session_file(cid: &str) -> Option<PathBuf> {
    let home = codex_home()?;
    let sessions_root = home.join("sessions");
    if !sessions_root.exists() {
        return None;
    }
    let mut queue: VecDeque<PathBuf> = VecDeque::new();
    queue.push_back(sessions_root);
    while let Some(dir) = queue.pop_front() {
        let rd = std::fs::read_dir(&dir).ok()?;
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() {
                queue.push_back(path);
                continue;
            }
            if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                if name.contains(cid) {
                    return Some(path);
                }
            }
        }
    }
    None
}

fn codex_home() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("CODEX_HOME") {
        let path = PathBuf::from(home);
        if path.exists() {
            return Some(path);
        }
    }
    dirs::home_dir()
        .map(|d| d.join(".codex"))
        .filter(|p| p.exists())
}

fn session_has_answer(path: &PathBuf, expected: &str) -> Result<bool> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path)?;
    let reader = BufReader::new(file);
    for line in reader.lines().flatten() {
        if line.trim().is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(kind) = value.get("type").and_then(|v| v.as_str()) {
            match kind {
                "event_msg" => {
                    if let Some(payload) = value.get("payload") {
                        if let Some(msg_type) = payload.get("type").and_then(|v| v.as_str()) {
                            if msg_type == "agent_message" {
                                if let Some(text) = payload.get("message").and_then(|v| v.as_str())
                                {
                                    if text.contains(expected) {
                                        return Ok(true);
                                    }
                                }
                            }
                        }
                    }
                }
                "response_item" => {
                    if let Some(payload) = value.get("payload") {
                        if let Some(ptyp) = payload.get("type").and_then(|v| v.as_str()) {
                            if ptyp == "message" {
                                if let Some(content) =
                                    payload.get("content").and_then(|v| v.as_array())
                                {
                                    for item in content {
                                        if item.get("type").and_then(|v| v.as_str())
                                            == Some("output_text")
                                        {
                                            if let Some(text) =
                                                item.get("text").and_then(|v| v.as_str())
                                            {
                                                if text.contains(expected) {
                                                    return Ok(true);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    Ok(false)
}
