/** Ordered migrations. Never edit a shipped entry: append a new one. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    playbook TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    root_node_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    branch_pattern TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX bindings_unique ON bindings (lower(path), branch_pattern);
  CREATE TABLE nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
    position REAL NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('goal','phase','task','question')),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','active','done','blocked','dropped')),
    assignee TEXT NOT NULL DEFAULT 'claude' CHECK (assignee IN ('claude','me')),
    outcome TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX nodes_project ON nodes (project_id);
  CREATE INDEX nodes_parent ON nodes (parent_id, position);
  CREATE TABLE resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('doc','test-suite','runbook','roadmap','diagram','link','other')),
    title TEXT NOT NULL,
    content TEXT,
    path TEXT,
    url TEXT,
    session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (content IS NOT NULL OR path IS NOT NULL OR url IS NOT NULL)
  );
  CREATE INDEX resources_node ON resources (node_id);
  CREATE INDEX resources_project ON resources (project_id);
  CREATE TABLE log_entries (
    id INTEGER PRIMARY KEY,
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    session_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX log_node ON log_entries (node_id);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    title TEXT,
    cwd TEXT,
    branch TEXT,
    transcript_path TEXT,
    state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('working','idle','permission','ended')),
    focus_node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
    prompts_since_update INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX sessions_project ON sessions (project_id);
  CREATE TABLE session_subagents (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    started_at TEXT NOT NULL,
    PRIMARY KEY (session_id, agent_id)
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    project_id INTEGER,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX events_project ON events (project_id, id);
  `,
];
