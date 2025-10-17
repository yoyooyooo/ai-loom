use serde_json::json;

pub fn error(code: &str, message: &str) -> serde_json::Value {
  json!({ "error": { "code": code, "message": message } })
}

