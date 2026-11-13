-- VEILBot v2: popular sites first (Tranco rank), cheap scheduling, cached counters.

-- Tranco list position of the site's registrable domain (1 = most popular); NULL = not ranked.
ALTER TABLE hosts ADD COLUMN rank INTEGER;
CREATE INDEX IF NOT EXISTS hosts_rank ON hosts (rank) WHERE rank IS NOT NULL;
CREATE INDEX IF NOT EXISTS hosts_next ON hosts (next_at);

-- Small key/value store: counters that are too costly to recount every minute.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  at INTEGER NOT NULL
);
