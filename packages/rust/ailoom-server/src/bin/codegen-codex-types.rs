use anyhow::{anyhow, Context, Result};
use codex_app_server_protocol::{generate_json, generate_ts};
use std::env;
use std::path::{Path, PathBuf};

fn parse_args() -> Result<(PathBuf, PathBuf, Option<PathBuf>)> {
    let mut ts_out = PathBuf::from("packages/web/src/lib/codex-types");
    let mut json_out = PathBuf::from("docs/specs/codex");
    let mut prettier: Option<PathBuf> = None;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--ts-out" => {
                let value = args
                    .next()
                    .ok_or_else(|| anyhow!("missing value for --ts-out"))?;
                ts_out = PathBuf::from(value);
            }
            "--json-out" => {
                let value = args
                    .next()
                    .ok_or_else(|| anyhow!("missing value for --json-out"))?;
                json_out = PathBuf::from(value);
            }
            "--prettier" => {
                let value = args
                    .next()
                    .ok_or_else(|| anyhow!("missing value for --prettier"))?;
                prettier = Some(PathBuf::from(value));
            }
            other => {
                return Err(anyhow!("unrecognised argument: {}", other));
            }
        }
    }

    if prettier.is_none() {
        let default_prettier = PathBuf::from("packages/web/node_modules/.bin/prettier");
        if default_prettier.exists() {
            prettier = Some(default_prettier);
        }
    }

    Ok((ts_out, json_out, prettier))
}

fn recreate_dir(path: &Path) -> Result<()> {
    if path.exists() {
        std::fs::remove_dir_all(path)
            .with_context(|| format!("failed to clean {}", path.display()))?;
    }
    std::fs::create_dir_all(path)
        .with_context(|| format!("failed to create {}", path.display()))?;
    Ok(())
}

fn main() -> Result<()> {
    let (ts_out, json_out, prettier) = parse_args()?;

    recreate_dir(&ts_out)?;
    recreate_dir(&json_out)?;

    generate_ts(&ts_out, prettier.as_deref()).context("generate ts")?;
    generate_json(&json_out).context("generate json")?;

    println!(
        "Generated Codex types:\n  TS   -> {}\n  JSON -> {}",
        ts_out.display(),
        json_out.display()
    );

    Ok(())
}
