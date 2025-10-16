use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn cmd_out(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() { return None; }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    let pkg_ver = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".into());
    // 可通过环境变量覆盖（例如 CI 注入 release-vX.Y.Z）
    let app_ver = std::env::var("AILOOM_VERSION").unwrap_or_else(|_| pkg_ver.clone());

    let git_tag = cmd_out("git", &["describe", "--tags", "--always", "--dirty"]).unwrap_or_else(|| "unknown".into());
    let git_sha = cmd_out("git", &["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".into());

    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let build_ts = format!("{}", ts);

    println!("cargo:rustc-env=APP_VERSION={}", app_ver);
    println!("cargo:rustc-env=APP_GIT_TAG={}", git_tag);
    println!("cargo:rustc-env=APP_GIT_SHA={}", git_sha);
    println!("cargo:rustc-env=APP_BUILD_TS={}", build_ts);
}

