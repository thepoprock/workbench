// Ordered, append-only. Never edit a shipped migration — add a new one.
// Timestamps are epoch milliseconds. IDs are UUIDs (text).
export const migrations: string[] = [
  // 1 — core schema (SPEC §4)
  `
  CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    root_path   TEXT,
    default_harness_id TEXT,
    tags        TEXT NOT NULL DEFAULT '[]',
    created_at  INTEGER NOT NULL,
    archived    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE harnesses (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL CHECK (type IN ('claude-code','agent-sdk','local-model','shell','custom')),
    name        TEXT NOT NULL,
    config      TEXT NOT NULL DEFAULT '{}',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    project_id  TEXT REFERENCES projects(id),
    harness_id  TEXT REFERENCES harnesses(id),
    kind        TEXT NOT NULL CHECK (kind IN ('terminal','agent')),
    status      TEXT NOT NULL,
    cwd         TEXT,
    title       TEXT,
    external_id TEXT,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    tokens_in   INTEGER NOT NULL DEFAULT 0,
    tokens_out  INTEGER NOT NULL DEFAULT 0,
    cost_usd    REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX sessions_project ON sessions(project_id, started_at);

  -- Append-only source of truth. History, changelog and errors are views over it.
  CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    project_id  TEXT,
    session_id  TEXT,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL DEFAULT '{}',
    text        TEXT
  );
  CREATE INDEX events_session ON events(session_id, id);
  CREATE INDEX events_project ON events(project_id, ts);
  CREATE INDEX events_kind ON events(kind, ts);

  CREATE VIRTUAL TABLE events_fts USING fts5(text, content='events', content_rowid='id');
  CREATE TRIGGER events_ai AFTER INSERT ON events WHEN new.text IS NOT NULL BEGIN
    INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text);
  END;

  -- Terminal output lives in files; this indexes them for "load earlier".
  CREATE TABLE scrollback_chunks (
    session_id  TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    file        TEXT NOT NULL,
    byte_start  INTEGER NOT NULL,
    byte_end    INTEGER NOT NULL,
    ts_start    INTEGER NOT NULL,
    ts_end      INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
  );

  CREATE TABLE errors (
    id          TEXT PRIMARY KEY,
    project_id  TEXT,
    fingerprint TEXT NOT NULL,
    title       TEXT NOT NULL,
    source      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','ignored')),
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    count       INTEGER NOT NULL DEFAULT 1,
    fix_commit  TEXT,
    UNIQUE (project_id, fingerprint)
  );
  CREATE TABLE error_events (
    error_id    TEXT NOT NULL REFERENCES errors(id),
    event_id    INTEGER NOT NULL REFERENCES events(id),
    PRIMARY KEY (error_id, event_id)
  );

  CREATE TABLE ideas (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    stage       TEXT NOT NULL DEFAULT 'idea' CHECK (stage IN ('idea','spec','plan','promoted')),
    project_id  TEXT REFERENCES projects(id),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE change_entries (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id),
    ts          INTEGER NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('git','session','manual')),
    summary     TEXT NOT NULL,
    refs        TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX change_entries_project ON change_entries(project_id, ts);

  CREATE TABLE layouts (
    id          TEXT PRIMARY KEY,
    project_id  TEXT REFERENCES projects(id),
    name        TEXT NOT NULL,
    dock        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE notes (
    id          TEXT PRIMARY KEY,
    project_id  TEXT REFERENCES projects(id),
    body        TEXT NOT NULL,
    pinned      INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  `,

  // 2 — terminal exit codes
  `ALTER TABLE sessions ADD COLUMN exit_code INTEGER;`,

  // 3 — history search: terminal output and Claude transcripts
  `
  -- ANSI-stripped text of each closed scrollback chunk.
  CREATE VIRTUAL TABLE scrollback_fts USING fts5(text, session_id UNINDEXED, seq UNINDEXED);

  -- Incremental transcript indexing: how far into each .jsonl we have read.
  CREATE TABLE transcript_files (
    path        TEXT PRIMARY KEY,
    transcript_id TEXT NOT NULL,
    cwd         TEXT,
    title       TEXT,
    offset      INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE transcript_fts USING fts5(text, transcript_id UNINDEXED, role UNINDEXED, ts UNINDEXED);
  `,

  // 4 — ideas live in their own folder (IDEA.md, SPEC.md, PLAN.md); one Claude session each
  `
  ALTER TABLE ideas ADD COLUMN folder TEXT;
  ALTER TABLE ideas ADD COLUMN session_id TEXT;
  ALTER TABLE ideas ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
  `,

  // 5 — changelog entries are upserted by a stable key (git:<sha>, session:<id>)
  `
  ALTER TABLE change_entries ADD COLUMN ref_key TEXT;
  CREATE UNIQUE INDEX change_entries_key ON change_entries(project_id, ref_key);
  `,
];
