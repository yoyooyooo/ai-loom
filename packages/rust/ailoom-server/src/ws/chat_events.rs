use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize)]
pub struct ChatHistoryEntry {
    pub role: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ChatEvent {
    TurnStarted,
    MessageDelta {
        delta: String,
    },
    MessageCompleted {
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    MessageFailed {
        error: ChatError,
    },
    MessageAborted,

    SessionNew {
        conversation_id: String,
    },
    SessionResumed {
        conversation_id: String,
    },
    SessionHistory {
        conversation_id: String,
        messages: Vec<ChatHistoryEntry>,
    },

    ReasoningDelta {
        delta: String,
    },
    ReasoningEnd {
        text: String,
    },

    ToolExecBegin {
        #[serde(skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        command: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
    },
    ToolExecOutput {
        #[serde(skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        stream: String,
        text: String,
    },
    ToolExecEnd {
        #[serde(skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stdout: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stderr: Option<String>,
    },

    ToolPatchBegin {
        #[serde(skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        files: usize,
        auto_approved: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        first_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        adds: Option<usize>,
        #[serde(skip_serializing_if = "Option::is_none")]
        dels: Option<usize>,
        /// 可选：每文件变更（受开关与限流）
        #[serde(skip_serializing_if = "Option::is_none")]
        changes: Option<Value>,
    },
    ToolPatchEnd {
        #[serde(skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        stdout: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stderr: Option<String>,
    },

    ToolMcpBegin {
        call_id: String,
        server: String,
        tool: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        arguments: Option<Value>,
    },
    ToolMcpEnd {
        call_id: String,
        server: String,
        tool: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        arguments: Option<Value>,
        result: Value,
    },

    InfoUserMessage {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        kind: Option<Value>,
    },
    TurnComplete,
}

#[derive(Debug, Serialize, Clone)]
pub struct ChatError {
    pub message: String,
}

impl ChatEvent {
    pub fn into_method_params(self) -> (String, Value) {
        match self {
            ChatEvent::TurnStarted => ("chat.turn.started".into(), Value::Null),
            ChatEvent::MessageDelta { delta } => {
                ("chat.message.delta".into(), json!({"delta": delta}))
            }
            ChatEvent::MessageCompleted { text } => {
                if let Some(t) = text {
                    ("chat.message.completed".into(), json!({"text": t}))
                } else {
                    (
                        "chat.message.completed".into(),
                        Value::Object(serde_json::Map::new()),
                    )
                }
            }
            ChatEvent::MessageFailed { error } => {
                ("chat.message.failed".into(), json!({"error": error}))
            }
            ChatEvent::MessageAborted => ("chat.message.aborted".into(), Value::Null),

            ChatEvent::SessionNew { conversation_id } => (
                "chat.session.new".into(),
                json!({"conversationId": conversation_id}),
            ),
            ChatEvent::SessionResumed { conversation_id } => (
                "chat.session.resumed".into(),
                json!({"conversationId": conversation_id}),
            ),
            ChatEvent::SessionHistory {
                conversation_id,
                messages,
            } => (
                "chat.session.history".into(),
                json!({"conversationId": conversation_id, "messages": messages}),
            ),

            ChatEvent::ReasoningDelta { delta } => {
                ("chat.reasoning.delta".into(), json!({"delta": delta}))
            }
            ChatEvent::ReasoningEnd { text } => {
                ("chat.reasoning.end".into(), json!({"text": text}))
            }

            ChatEvent::ToolExecBegin {
                cwd,
                command,
                call_id,
            } => (
                "chat.tool.exec.begin".into(),
                json!({"cwd": cwd, "command": command, "callId": call_id}),
            ),
            ChatEvent::ToolExecOutput {
                call_id,
                stream,
                text,
            } => (
                "chat.tool.exec.output".into(),
                json!({"callId": call_id, "stream": stream, "text": text}),
            ),
            ChatEvent::ToolExecEnd {
                call_id,
                exit_code,
                duration_ms,
                stdout,
                stderr,
            } => (
                "chat.tool.exec.end".into(),
                json!({"callId": call_id, "exitCode": exit_code, "durationMs": duration_ms, "stdout": stdout, "stderr": stderr}),
            ),

            ChatEvent::ToolPatchBegin {
                call_id,
                files,
                auto_approved,
                first_path,
                adds,
                dels,
                changes,
            } => (
                "chat.tool.patch.begin".into(),
                json!({"callId": call_id, "files": files, "autoApproved": auto_approved, "firstPath": first_path, "adds": adds, "dels": dels, "changes": changes}),
            ),
            ChatEvent::ToolPatchEnd {
                call_id,
                success,
                stdout,
                stderr,
            } => (
                "chat.tool.patch.end".into(),
                json!({"callId": call_id, "success": success, "stdout": stdout, "stderr": stderr}),
            ),

            ChatEvent::ToolMcpBegin {
                call_id,
                server,
                tool,
                arguments,
            } => (
                "chat.tool.mcp.begin".into(),
                json!({"callId": call_id, "server": server, "tool": tool, "arguments": arguments}),
            ),
            ChatEvent::ToolMcpEnd {
                call_id,
                server,
                tool,
                arguments,
                result,
            } => (
                "chat.tool.mcp.end".into(),
                json!({"callId": call_id, "server": server, "tool": tool, "arguments": arguments, "result": result}),
            ),

            ChatEvent::InfoUserMessage { text, kind } => (
                "chat.info.user_message".into(),
                json!({"text": text, "kind": kind}),
            ),
            ChatEvent::TurnComplete => ("chat.turn.complete".into(), Value::Null),
        }
    }
}

pub fn event(ev: ChatEvent) -> (String, Value) {
    ev.into_method_params()
}
