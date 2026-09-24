-- Documents. `path` is the identity; `name` (from frontmatter) is unique too.
CREATE TABLE docs (
  path        TEXT PRIMARY KEY,   -- /areas/razorit.md
  name        TEXT NOT NULL,      -- frontmatter name, unique
  description TEXT,
  aliases     TEXT,               -- JSON array
  content     TEXT NOT NULL,      -- full markdown incl. frontmatter
  version     INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX docs_name ON docs(name);

-- External-content FTS index over docs, kept in sync by the triggers below.
-- If it ever drifts, `npm run tokens -- rebuild` restores it.
CREATE VIRTUAL TABLE docs_fts USING fts5(
  path UNINDEXED, name, description, content,
  content=docs, content_rowid=rowid,
  tokenize='porter unicode61'
);

CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, path, name, description, content)
  VALUES (new.rowid, new.path, new.name, new.description, new.content);
END;

CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, path, name, description, content)
  VALUES ('delete', old.rowid, old.path, old.name, old.description, old.content);
END;

CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, path, name, description, content)
  VALUES ('delete', old.rowid, old.path, old.name, old.description, old.content);
  INSERT INTO docs_fts(rowid, path, name, description, content)
  VALUES (new.rowid, new.path, new.name, new.description, new.content);
END;

-- Per-client bearer tokens. Only SHA-256 hashes are stored.
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

-- Failed-auth counter per client IP, fixed window.
CREATE TABLE auth_failures (
  ip           TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,  -- unix seconds
  count        INTEGER NOT NULL
);
