use anyhow::Result;
use db::models::Entity;
use std::path::Path;
use ts_rs::TS;

/// Generate TypeScript types from Rust structs
fn main() -> Result<()> {
    println!("🔧 Generating TypeScript types...");
    
    // Ensure the shared directory exists
    let shared_dir = Path::new("shared");
    if !shared_dir.exists() {
        std::fs::create_dir_all(shared_dir)?;
    }
    
    // Generate types for Entity
    Entity::export_all_to("shared/")?;
    
    println!("✅ TypeScript types generated in shared/types.ts");
    Ok(())
}