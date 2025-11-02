use ailoom_server::ws::hub::Hub;

#[test]
fn last_event_ts_for_conversation_basic() {
    let hub = Hub::new(8);
    // 空会话：无 ts
    assert!(hub.last_event_ts_for_conversation("nope").is_none());
    // 填入一个事件
    hub.broadcast(
        "chat.message.delta".into(),
        serde_json::json!({"conversationId":"cid-x","delta":"hi"}),
    );
    assert!(hub.last_event_ts_for_conversation("cid-x").is_some());
}
