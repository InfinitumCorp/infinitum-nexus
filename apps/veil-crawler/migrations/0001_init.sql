-- VEILBot: crawl queue and VEIL's own search index (D1 / SQLite).

-- One row per website: robots.txt, politeness clock, counters, opt-out.
CREATE TABLE IF NOT EXISTS hosts (
  host TEXT PRIMARY KEY,
  robots TEXT,                       -- parsed robots.txt as JSON
  robots_at INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0, -- earliest time (ms) VEILBot may contact this host again
  pages INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0  -- 1 = opted out or blocked: never crawled, never shown
);

-- URLs to crawl. state: 0 queued, 1 crawled, 2 skipped (robots, not HTML, error).
CREATE TABLE IF NOT EXISTS frontier (
  url TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  depth INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  state INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS frontier_queue ON frontier (host, state, depth, added_at);

-- Indexed pages. id is the rowid of pages_fts.
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  lang TEXT,
  trackers INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL,                -- SHA-256 of the text, to skip exact duplicates
  crawled_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pages_host ON pages (host);
CREATE INDEX IF NOT EXISTS pages_hash ON pages (hash);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5 (
  title, description, body,
  tokenize = 'unicode61 remove_diacritics 2'
);
