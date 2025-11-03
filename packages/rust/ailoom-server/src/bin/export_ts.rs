use std::path::Path;

use ailoom_server::ws::chat_events::{ChatError, ChatEvent, ChatHistoryEntry};
use anyhow::Result;
use ts_rs::TS;

fn main() -> Result<()> {
    let generated_dir =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/src/lib/codex-types/generated");
    std::fs::create_dir_all(&generated_dir)?;

    ChatHistoryEntry::export()?;
    ChatError::export()?;
    ChatEvent::export()?;

    println!(
        "[ts-export] Generated chat event types under {}",
        generated_dir.display()
    );
    Ok(())
}
