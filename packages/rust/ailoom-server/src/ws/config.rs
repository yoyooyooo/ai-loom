#[derive(Debug, Clone)]
pub struct WsConfig {
  pub send_timeout_ms: u64,
  pub force_recover: bool,
  pub force_recover_ms: u64,
  pub supervisor_enabled: bool,
  pub recover_close_first: bool,
  pub pump_ms: u64,
}

impl WsConfig {
  pub fn from_env() -> Self {
    let send_timeout_ms = std::env::var("AILOOM_BROADCAST_SEND_TIMEOUT_MS").ok()
      .and_then(|s| s.parse::<u64>().ok()).unwrap_or(1000);
    let force_recover = std::env::var("AILOOM_WS_FORCE_RECOVER").unwrap_or_else(|_| "0".into()) == "1";
    let force_recover_ms = std::env::var("AILOOM_WS_FORCE_RECOVER_MS").ok()
      .and_then(|s| s.parse::<u64>().ok()).unwrap_or(1000);
    let supervisor_enabled = std::env::var("AILOOM_WS_SUPERVISOR").unwrap_or_else(|_| "1".into()) == "1";
    let recover_close_first = std::env::var("AILOOM_WS_RECOVER_CLOSE_FIRST").unwrap_or_else(|_| "1".into()) == "1";
    let pump_ms = std::env::var("AILOOM_WS_PUMP_MS").ok()
      .and_then(|s| s.parse::<u64>().ok()).unwrap_or(200);
    Self { send_timeout_ms, force_recover, force_recover_ms, supervisor_enabled, recover_close_first, pump_ms }
  }
}

