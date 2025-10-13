/// Utility functions and shared code

/// Convert UUID to string format suitable for URLs
pub fn uuid_to_string(id: uuid::Uuid) -> String {
    id.to_string()
}

/// Parse UUID from string
pub fn string_to_uuid(s: &str) -> Result<uuid::Uuid, uuid::Error> {
    s.parse()
}