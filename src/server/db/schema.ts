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
  // 2: live work. Claude's working tasks (mirrored from Claude Code's task tools, or set by the main session's tasks
  // command), what each subagent is doing and where, and a per-project queue of the steps Claude plans to take next.
  `
  CREATE TABLE work_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL DEFAULT '',
    task_key TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed')),
    blocks TEXT NOT NULL DEFAULT '[]',
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (session_id, agent_id, task_key)
  );
  CREATE INDEX work_items_node ON work_items (node_id, position);
  CREATE INDEX work_items_project ON work_items (project_id);
  ALTER TABLE session_subagents ADD COLUMN description TEXT;
  ALTER TABLE session_subagents ADD COLUMN model TEXT;
  ALTER TABLE session_subagents ADD COLUMN node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL;
  ALTER TABLE session_subagents ADD COLUMN tool_use_id TEXT;
  ALTER TABLE session_subagents ADD COLUMN ended_at TEXT;
  CREATE TABLE subagent_dispatches (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    tool_use_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    model TEXT,
    node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
    -- NULL until a subagent takes this dispatch: at its SubagentStart (first in, first out), or earlier when the
    -- launch response names the agent (a background agent's launch can arrive before its start).
    agent_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, tool_use_id)
  );
  CREATE INDEX subagent_dispatches_fifo ON subagent_dispatches (session_id, agent_type, created_at);
  ALTER TABLE projects ADD COLUMN queue TEXT NOT NULL DEFAULT '[]';
  -- Only additions: a v1 build can still read and write this schema, so a rollback across this migration works.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
  // 3: type labels. Each step can carry one label from a fixed set (NODE_LABELS); NULL leaves it unlabelled.
  `
  ALTER TABLE nodes ADD COLUMN label TEXT CHECK (label IS NULL OR label IN ('ui','server','data','integration','ops','docs','fix','refactor','research'));
  -- Only a nullable column: v1 and v2 builds can still read and write this schema, so a rollback across it works.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
  // 4: session identity. A session's slot (its letter and hue: 0 is A) and a subagent's number within its session (the
  // 1 in a1). NULL for rows from before this migration. No unique index on (project_id, slot): a rolled-back v3 build
  // reviving a session would hit it, so the code keeps two live sessions of a project off one slot.
  `
  ALTER TABLE sessions ADD COLUMN slot INTEGER;
  ALTER TABLE session_subagents ADD COLUMN ordinal INTEGER;
  -- Only nullable columns: v1 to v3 builds can still read and write this schema, so a rollback across it works.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
  // 5: subagent purpose. The first sentence of the Agent prompt (at most 200 characters), carried from the dispatch to
  // the subagent row. NULL for rows from before this migration and for a dispatch whose prompt was blank.
  `
  ALTER TABLE subagent_dispatches ADD COLUMN purpose TEXT;
  ALTER TABLE session_subagents ADD COLUMN purpose TEXT;
  -- Only nullable columns: v1 to v4 builds can still read and write this schema, so a rollback across it works.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
  // 6: briefing due. 1 while a session owes its next prompt the full briefing: it joined a project through an enroll (a
  // new session, a repoint, an ended session) or came back into another letter. NULL otherwise, and for rows
  // from before this migration.
  `
  ALTER TABLE sessions ADD COLUMN briefing_due INTEGER;
  -- Only a nullable column: v1 to v5 builds can still read and write this schema, so a rollback across it works.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
  // 7: subagent lifecycle. start_focus_id: the session's focus when a subagent started (or the first focus it saw, when
  // it started before its session had one), where a subagent with no step of its own stays, kept apart from node_id,
  // which every pairing change rewrites. end_reason: why a subagent ended without a clean SubagentStop (END_REASONS);
  // NULL for a clean stop or while it runs. last_active_at: its last sign of life, for an end the transcript watcher
  // found. All NULL for rows from before this migration.
  `
  ALTER TABLE session_subagents ADD COLUMN start_focus_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL;
  ALTER TABLE session_subagents ADD COLUMN end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN ('limit','error','killed','silent','session'));
  ALTER TABLE session_subagents ADD COLUMN last_active_at TEXT;
  -- Only nullable columns: v1 to v6 builds can still read and write this schema, so a rollback across it works.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
];
