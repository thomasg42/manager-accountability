CREATE TABLE IF NOT EXISTS credentials (
  name TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One generic store for every record type (profiles, shifts, notes, audits,
-- messages, videos) so a new checklist type never needs a migration.
CREATE TABLE IF NOT EXISTS records (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS records_collection_updated_idx
  ON records(collection, updated_at DESC);

-- Task verification photos, base64 in-row (same approach as the receipt store
-- in gold-mobile-mechanic). Capped worker-side at ~900KB per image.
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL,
  data_base64 TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
