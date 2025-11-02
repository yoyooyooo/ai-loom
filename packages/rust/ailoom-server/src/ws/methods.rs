use crate::services::verification::verify_annotations_for_file;
use crate::{paths::map_and_filter_annotations, state::AppState};
use ailoom_fs::{read_file_chunk, FsConfig};
use serde_json::{json, Value};

fn err(code: &str, msg: &str) -> anyhow::Error {
    anyhow::anyhow!(format!("{}:{}", code, msg))
}

pub async fn call(method: &str, params: &Value, state: &AppState) -> Result<Value, anyhow::Error> {
    match method {
        "tree.get" => {
            let dir = params.get("dir").and_then(|v| v.as_str()).unwrap_or(".");
            list_dir_json(&state.fs, dir)
        }
        "file.getChunk" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| err("INVALID_PATH", "path required"))?;
            let start = params
                .get("startLine")
                .and_then(|v| v.as_u64())
                .unwrap_or(1) as usize;
            let max = params
                .get("maxLines")
                .and_then(|v| v.as_u64())
                .unwrap_or(2000) as usize;
            match read_file_chunk(&state.fs, path, start, max) {
                Ok(chunk) => Ok(serde_json::to_value(chunk).unwrap()),
                Err(e) => {
                    let msg = e.to_string();
                    if msg == "NON_TEXT" {
                        Err(err("NON_TEXT", "non-text file"))
                    } else {
                        Err(err("INVALID_PATH", &msg))
                    }
                }
            }
        }
        "file.getFull" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| err("INVALID_PATH", "path required"))?;
            match ailoom_fs::read_file_full(&state.fs, path) {
                Ok(ff) => Ok(
                    json!({"path": ff.path, "language": ff.language, "size": ff.size, "content": ff.content, "digest": ff.digest}),
                ),
                Err(e) => {
                    let msg = e.to_string();
                    if msg == "NON_TEXT" {
                        Err(err("NON_TEXT", "non-text file"))
                    } else if msg == "OVER_LIMIT" {
                        Err(err("MESSAGE_TOO_LARGE", "payload too large"))
                    } else {
                        Err(err("INVALID_PATH", &msg))
                    }
                }
            }
        }
        "annotations.list" => {
            let anns = state
                .store
                .list_annotations()
                .await
                .map_err(|e| err("INTERNAL", &e.to_string()))?;
            Ok(serde_json::to_value(map_and_filter_annotations(state, anns)).unwrap())
        }
        "file.save" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| err("INVALID_PATH", "path required"))?;
            let content = params
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or_else(|| err("INVALID_PARAMS", "content required"))?;
            let base_digest = params.get("baseDigest").and_then(|v| v.as_str());
            match ailoom_fs::write_file(&state.fs, path, content, base_digest) {
                Ok(new_digest) => {
                    // 写后广播 file.changed
                    if let Some(hub) = state.ws_hub.clone() {
                        // 开发场景可选：立即发送一次瞬时通知，兜底前端“保存后立即刷新”体验（不入 ring，不影响 resume）
                        if std::env::var("AILOOM_WS_EAGER_SAVE_ECHO").unwrap_or_else(|_| "0".into())
                            == "1"
                        {
                            hub.broadcast_ephemeral("file.changed".into(), json!({"path": path, "kind": "modified", "digest": new_digest.clone(), "source": "save-eager"}));
                        }
                        hub.broadcast(
                            "file.changed".into(),
                            json!({"path": path, "kind": "modified", "digest": new_digest.clone()}),
                        );
                        hub.inc_file_changed();
                    }
                    // 异步校验结束后广播 annotations.verify.done
                    let st = state.clone();
                    let p = path.to_string();
                    let hub2 = state.ws_hub.clone();
                    tokio::spawn(async move {
                        if let Ok(res) = verify_annotations_for_file(
                            &st,
                            &p,
                            Some(40),
                            Some(5 * 1024 * 1024),
                            true,
                        )
                        .await
                        {
                            if let Some(h) = hub2 {
                                h.broadcast(
                                    "annotations.verify.done".into(),
                                    serde_json::to_value(res).unwrap_or(json!({})),
                                );
                            }
                        }
                    });
                    Ok(json!({"ok": true, "digest": new_digest}))
                }
                Err(ailoom_fs::WriteError::Conflict { current_digest }) => {
                    Err(err("CONFLICT", &current_digest))
                }
                Err(ailoom_fs::WriteError::Io(e)) => Err(err("INTERNAL", &e.to_string())),
            }
        }
        "events.resume" => {
            let after = params
                .get("after")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok())
                .or_else(|| params.get("after").and_then(|v| v.as_u64()))
                .unwrap_or(0u64);
            let tail = params.get("tail").and_then(|v| v.as_u64()).unwrap_or(0u64) as usize;
            let topic = params.get("topic").and_then(|v| v.as_str());
            let filter = params.get("filter").and_then(|v| v.as_object());
            let filter_conversation_id = filter
                .and_then(|obj| obj.get("conversationId"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let filter_provider_id = filter
                .and_then(|obj| obj.get("providerId").or_else(|| obj.get("provider")))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if let Some(hub) = state.ws_hub.clone() {
                let conv_id_ref = filter_conversation_id.as_deref();
                let provider_id_ref = filter_provider_id.as_deref();
                if matches!(topic, Some("chat")) {
                    if tail > 0 && after == 0 {
                        let events = hub.tail_chat(conv_id_ref, provider_id_ref, tail);
                        let list: Vec<Value> = events
                            .into_iter()
                            .map(
                                |e| json!({"jsonrpc":"2.0","method": e.method, "params": e.params}),
                            )
                            .collect();
                        Ok(json!({"events": list, "truncated": false}))
                    } else {
                        let (events, truncated) =
                            hub.resume_after_chat(after, conv_id_ref, provider_id_ref);
                        let list: Vec<Value> = events
                            .into_iter()
                            .map(
                                |e| json!({"jsonrpc":"2.0","method": e.method, "params": e.params}),
                            )
                            .collect();
                        Ok(json!({"events": list, "truncated": truncated}))
                    }
                } else {
                    if tail > 0 && after == 0 {
                        let events = hub.tail(tail);
                        let list: Vec<Value> = events
                            .into_iter()
                            .map(
                                |e| json!({"jsonrpc":"2.0","method": e.method, "params": e.params}),
                            )
                            .collect();
                        Ok(json!({"events": list, "truncated": false}))
                    } else {
                        let (events, truncated) = hub.resume_after(after);
                        let list: Vec<Value> = events
                            .into_iter()
                            .map(
                                |e| json!({"jsonrpc":"2.0","method": e.method, "params": e.params}),
                            )
                            .collect();
                        Ok(json!({"events": list, "truncated": truncated}))
                    }
                }
            } else {
                Err(err("NOT_SUPPORTED", "hub missing"))
            }
        }
        "session.info" => {
            let mut features = vec!["jsonrpc", "subscriptions"];
            // watcher feature flag
            if std::env::var("AILOOM_FSWATCH_ENABLED").unwrap_or_else(|_| "0".into()) == "1" {
                features.push("fswatch");
            }
            let limits = json!({
              "maxMessageBytes": 6*1024*1024,
              "requestTimeoutMs": 15000
            });
            let stats = if let Some(hub) = state.ws_hub.clone() {
                json!(hub.stats_snapshot())
            } else {
                json!({})
            };
            Ok(json!({
              "serverVersion": env!("APP_VERSION"),
              "features": features,
              "limits": limits,
              "stats": stats,
            }))
        }
        _ => Err(err("METHOD_NOT_FOUND", method)),
    }
}

fn list_dir_json(fs: &FsConfig, dir: &str) -> Result<Value, anyhow::Error> {
    match ailoom_fs::list_dir(fs, dir) {
        Ok(entries) => Ok(serde_json::to_value(entries).unwrap()),
        Err(e) => Err(err("INVALID_PATH", &e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use ailoom_store::Store;
    use std::path::PathBuf;

    fn tempdir() -> PathBuf {
        let p =
            std::env::temp_dir().join(format!("ailoom_ws_test_methods_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[tokio::test]
    async fn events_resume_chat_filters_by_provider() {
        let root = tempdir();
        let fs_cfg = FsConfig::new(root.clone());
        let db = root.join("ailoom.db");
        let store = Store::connect_path(&db, &root.to_string_lossy())
            .await
            .unwrap();
        let hub = crate::ws::hub::Hub::new(64);
        // broadcast mixed providers
        hub.broadcast(
            "chat.message.delta".into(),
            json!({"conversationId":"cid-pp","provider":"codex","delta":"x"}),
        );
        hub.broadcast(
            "chat.message.delta".into(),
            json!({"conversationId":"cid-pp","provider":"other","delta":"y"}),
        );

        let state = AppState {
            fs: fs_cfg,
            store,
            root: root.clone(),
            workspace_root: root,
            ws_hub: Some(hub),
            runtime_registry: crate::services::executors::registry::RuntimeRegistry::new(),
        };

        // request only codex provider
        let params = json!({
            "after": 0,
            "topic": "chat",
            "filter": {"conversationId": "cid-pp", "providerId": "codex"}
        });
        let res = call("events.resume", &params, &state).await.unwrap();
        let events = res
            .get("events")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(events.len(), 1);
        let first = events.first().unwrap();
        assert_eq!(
            first.get("method").and_then(|v| v.as_str()),
            Some("chat.message.delta")
        );
        let p = first.get("params").and_then(|v| v.as_object()).unwrap();
        assert_eq!(p.get("delta").and_then(|v| v.as_str()), Some("x"));
        assert_eq!(p.get("provider").and_then(|v| v.as_str()), Some("codex"));
    }
}
