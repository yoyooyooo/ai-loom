-- Create the main entities table
-- Replace 'entities' with your actual entity name

CREATE TABLE entities (
    id BLOB PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

-- Create index for faster queries
CREATE INDEX idx_entities_created_at ON entities(created_at);
CREATE INDEX idx_entities_name ON entities(name);

-- Example of a second entity table (optional)
-- CREATE TABLE entity_items (
--     id BLOB PRIMARY KEY NOT NULL,
--     entity_id BLOB NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
--     title TEXT NOT NULL,
--     completed BOOLEAN NOT NULL DEFAULT FALSE,
--     created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
--     updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
-- );

-- CREATE INDEX idx_entity_items_entity_id ON entity_items(entity_id);
-- CREATE INDEX idx_entity_items_completed ON entity_items(completed);