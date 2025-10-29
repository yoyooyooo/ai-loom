use codex_protocol::config_types::SandboxMode;
use codex_protocol::protocol::SandboxPolicy;

use super::types::{
    ResumeConfigResponse, ResumeOverridePayload, ResumeOverrides, ResumeSandboxConfig,
    RolloutConfigSnapshot,
};

pub fn build_resume_config(
    snapshot: &RolloutConfigSnapshot,
) -> (ResumeOverrides, ResumeConfigResponse) {
    let mut overrides = ResumeOverrides::default();
    let mut response = ResumeConfigResponse::default();

    if let Some(turn) = snapshot.turn.as_ref() {
        overrides.model = turn.model.clone();
        overrides.approval_policy = turn.approval_policy;
        overrides.sandbox_policy = turn.sandbox_policy.clone();
        overrides.sandbox_mode = turn.sandbox_policy.clone().map(|policy| match policy {
            SandboxPolicy::DangerFullAccess => SandboxMode::DangerFullAccess,
            SandboxPolicy::ReadOnly => SandboxMode::ReadOnly,
            SandboxPolicy::WorkspaceWrite { .. } => SandboxMode::WorkspaceWrite,
        });
        overrides.cwd = turn.cwd.clone();

        response.model = turn.model.clone();
        response.approval_policy = turn.approval_policy.map(|p| p.to_string());
        response.cwd = turn.cwd.as_ref().map(|p| p.to_string_lossy().to_string());
        response.effort = turn.effort.clone();
        response.summary = turn.summary.clone();

        if let Some(policy) = turn.sandbox_policy.clone() {
            let sandbox_response = match policy {
                SandboxPolicy::DangerFullAccess => ResumeSandboxConfig {
                    mode: "danger-full-access".into(),
                    ..Default::default()
                },
                SandboxPolicy::ReadOnly => ResumeSandboxConfig {
                    mode: "read-only".into(),
                    ..Default::default()
                },
                SandboxPolicy::WorkspaceWrite {
                    writable_roots,
                    network_access,
                    exclude_tmpdir_env_var,
                    exclude_slash_tmp,
                } => {
                    if !writable_roots.is_empty() {
                        overrides.config_map.insert(
                            "sandbox_workspace_write.writable_roots".into(),
                            serde_json::Value::Array(
                                writable_roots
                                    .iter()
                                    .map(|p| {
                                        serde_json::Value::String(p.to_string_lossy().to_string())
                                    })
                                    .collect(),
                            ),
                        );
                    }
                    overrides.config_map.insert(
                        "sandbox_workspace_write.network_access".into(),
                        serde_json::Value::Bool(network_access),
                    );
                    overrides.config_map.insert(
                        "sandbox_workspace_write.exclude_tmpdir_env_var".into(),
                        serde_json::Value::Bool(exclude_tmpdir_env_var),
                    );
                    overrides.config_map.insert(
                        "sandbox_workspace_write.exclude_slash_tmp".into(),
                        serde_json::Value::Bool(exclude_slash_tmp),
                    );

                    ResumeSandboxConfig {
                        mode: "workspace-write".into(),
                        network_access: Some(network_access),
                        exclude_tmpdir_env_var: Some(exclude_tmpdir_env_var),
                        exclude_slash_tmp: Some(exclude_slash_tmp),
                        writable_roots: if writable_roots.is_empty() {
                            None
                        } else {
                            Some(
                                writable_roots
                                    .iter()
                                    .map(|p| p.to_string_lossy().to_string())
                                    .collect(),
                            )
                        },
                    }
                }
            };
            response.sandbox = Some(sandbox_response);
        }
    }

    if let Some(env) = snapshot.environment.as_ref() {
        if overrides.approval_policy.is_none() {
            overrides.approval_policy = env.approval_policy;
        }
        if response.approval_policy.is_none() {
            response.approval_policy = env.approval_policy.map(|p| p.to_string());
        }
        if overrides.sandbox_mode.is_none() {
            overrides.sandbox_mode = env.sandbox_mode;
        }
        if overrides.cwd.is_none() {
            overrides.cwd = env.cwd.clone();
        }

        match (response.sandbox.as_mut(), env.sandbox_mode) {
            (Some(existing), _) => {
                if existing.network_access.is_none() {
                    existing.network_access = env.network_access;
                }
                if existing.writable_roots.is_none() && !env.writable_roots.is_empty() {
                    existing.writable_roots = Some(
                        env.writable_roots
                            .iter()
                            .map(|p| p.to_string_lossy().to_string())
                            .collect(),
                    );
                }
            }
            (None, Some(mode)) => {
                response.sandbox = Some(ResumeSandboxConfig {
                    mode: mode.to_string(),
                    network_access: env.network_access,
                    exclude_tmpdir_env_var: None,
                    exclude_slash_tmp: None,
                    writable_roots: if env.writable_roots.is_empty() {
                        None
                    } else {
                        Some(
                            env.writable_roots
                                .iter()
                                .map(|p| p.to_string_lossy().to_string())
                                .collect(),
                        )
                    },
                });
            }
            _ => {}
        }

        if overrides
            .config_map
            .get("sandbox_workspace_write.network_access")
            .is_none()
        {
            if let Some(network) = env.network_access {
                overrides.config_map.insert(
                    "sandbox_workspace_write.network_access".into(),
                    serde_json::Value::Bool(network),
                );
            }
        }
        if overrides
            .config_map
            .get("sandbox_workspace_write.writable_roots")
            .is_none()
        {
            if !env.writable_roots.is_empty() {
                overrides.config_map.insert(
                    "sandbox_workspace_write.writable_roots".into(),
                    serde_json::Value::Array(
                        env.writable_roots
                            .iter()
                            .map(|p| serde_json::Value::String(p.to_string_lossy().to_string()))
                            .collect(),
                    ),
                );
            }
        }

        let env_json = serde_json::json!({
            "cwd": env.cwd.as_ref().map(|p| p.to_string_lossy().to_string()),
            "approvalPolicy": env.approval_policy.map(|p| p.to_string()),
            "sandboxMode": env.sandbox_mode.map(|m| m.to_string()),
            "networkAccess": env.network_access,
            "writableRoots": if env.writable_roots.is_empty() {
                None
            } else {
                Some(
                    env.writable_roots
                        .iter()
                        .map(|p| p.to_string_lossy().to_string())
                        .collect::<Vec<_>>(),
                )
            },
            "shell": env.shell.clone(),
        });
        response.environment = Some(env_json);
    }

    let overrides_payload = ResumeOverridePayload {
        model: overrides.model.clone(),
        approval_policy: overrides
            .approval_policy
            .as_ref()
            .map(|policy| policy.to_string()),
        sandbox_mode: overrides.sandbox_mode.as_ref().map(|mode| mode.to_string()),
        config: if overrides.config_map.is_empty() {
            None
        } else {
            Some(overrides.config_map.clone())
        },
    };
    if overrides_payload.model.is_some()
        || overrides_payload.approval_policy.is_some()
        || overrides_payload.sandbox_mode.is_some()
        || overrides_payload.config.is_some()
    {
        response.overrides = Some(overrides_payload);
    }

    (overrides, response)
}
