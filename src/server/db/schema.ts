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
  // 4: session identity. A session's slot (its place in sort ties: 0 first) and a subagent's number within its session (the
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
  // new session, a repoint, an ended session) or, in a scoped project, the scribe moved its focus. NULL otherwise, and for rows
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
  // found. sessions.revived_at: when an ended session last came back, where its current life starts: what the watcher
  // ended before that stays as the session's end left it (ENDED_THIS_LIFE_SQL). All NULL for rows from before this
  // migration.
  `
  ALTER TABLE session_subagents ADD COLUMN start_focus_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL;
  ALTER TABLE session_subagents ADD COLUMN end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN ('limit','error','killed','silent','session'));
  ALTER TABLE session_subagents ADD COLUMN last_active_at TEXT;
  ALTER TABLE sessions ADD COLUMN revived_at TEXT;
  -- Only nullable columns: v1 to v6 builds can still read and write this schema, so a rollback across it works.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
  // 8: soft delete. When the project was deleted; NULL while it is not. A deleted project is always archived too, so a
  // build from before this migration shows it as an archived one: its bindings stay inert and enroll refuses it. It is
  // hidden everywhere, restorable for 30 days (DELETED_RETENTION_MS), then purged.
  `
  ALTER TABLE projects ADD COLUMN deleted_at TEXT;
  -- Only a nullable column: v1 to v7 builds can still read and write this schema, so a rollback across it works.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
  // 9: background commands, and when a resumed subagent's current run started (#228, design r79 section 2). A command is
  // a Bash, PowerShell or Monitor run in the background that a session or one of its subagents started.
  `
  CREATE TABLE session_commands (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    tool_use_id TEXT,
    agent_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK (kind IN ('shell','monitor')),
    persistent INTEGER NOT NULL DEFAULT 0,
    description TEXT,
    command_head TEXT,
    node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed','failed','killed','session','unknown')),
    exit_code INTEGER,
    PRIMARY KEY (session_id, task_id)
  );
  CREATE INDEX session_commands_live ON session_commands (session_id, ended_at);
  ALTER TABLE session_subagents ADD COLUMN run_started_at TEXT;
  -- A new table and a nullable column: v1 to v8 builds can still read and write this schema, so a rollback across it works.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
  // 10: asks, roles, scoped briefings and resource purposes (stage 1, spec 2026-10-12-board-and-asks-design.md section 1).
  // asks.kind, sessions.role, projects.briefing_mode and resources.purpose carry no CHECK, unlike the older enums: each
  // is expected to grow in stage 2, and SQLite cannot change a CHECK without rebuilding the table. Code validates them.
  // The open needs-you steps that already are asks become asks: a question node's title, or a body's "Needs you:" line.
  `
  CREATE TABLE asks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    raised_at TEXT NOT NULL,
    cleared_at TEXT,
    cleared_by TEXT,
    answer TEXT NOT NULL DEFAULT '',
    answer_delivered_at TEXT
  );
  CREATE INDEX asks_open ON asks (project_id, cleared_at, raised_at);
  CREATE INDEX asks_node ON asks (node_id, raised_at);
  CREATE UNIQUE INDEX asks_open_once ON asks (node_id, kind, text) WHERE cleared_at IS NULL;
  ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'worker';
  ALTER TABLE projects ADD COLUMN briefing_mode TEXT NOT NULL DEFAULT 'full';
  ALTER TABLE resources ADD COLUMN purpose TEXT;
  INSERT INTO asks (project_id, node_id, kind, text, raised_at)
    SELECT project_id, id, 'question', title, updated_at FROM nodes
    WHERE assignee = 'me' AND status IN ('todo', 'active', 'blocked') AND kind = 'question';
  INSERT INTO asks (project_id, node_id, kind, text, raised_at)
    SELECT project_id, id, 'permission', trim(substr(t, i + 1, instr(substr(t, i + 1), char(10)) - 1)), updated_at
    FROM (
      SELECT project_id, id, updated_at, t, instr(t, char(10) || 'Needs you:') AS i
      FROM (
        SELECT project_id, id, updated_at, char(10) || replace(body, char(13), '') || char(10) AS t FROM nodes
        WHERE assignee = 'me' AND status IN ('todo', 'active', 'blocked') AND kind != 'question'
      )
    )
    WHERE i > 0;
  -- A new table and defaulted or nullable columns: v1 to v9 builds can still read and write this schema.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
  // 11: the Board's task box (#422). board_state: the TaskState the reconcile last stored for the step; state_since: when
  // it last changed; hue: the task hue (0-6) held while the step is in a coloured state. All NULL until the reconcile
  // first runs for a step, and for the root, groups and dropped steps. Written only by the reconcile inside each write.
  `
  ALTER TABLE nodes ADD COLUMN board_state TEXT;
  ALTER TABLE nodes ADD COLUMN state_since TEXT;
  ALTER TABLE nodes ADD COLUMN hue INTEGER;
  -- Only nullable columns: v1 to v10 builds can still read and write this schema, so a rollback across it works.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
  // 12: the step's driver (spec 2026-10-15-keep-the-thread-design.md section 1.1): the one session that works an active
  // step. NULL when no session drives it, and cleared when the step goes done or dropped. An active step takes the
  // non-ended session focused on it that was seen last (the higher id on a tie); the project root never gets one.
  `
  ALTER TABLE nodes ADD COLUMN driver_session_id TEXT;
  UPDATE nodes SET driver_session_id = (SELECT s.id FROM sessions s WHERE s.focus_node_id = nodes.id AND s.state != 'ended' ORDER BY s.last_seen_at DESC, s.id DESC LIMIT 1) WHERE status = 'active' AND nodes.parent_id IS NOT NULL;
  -- Only a nullable column: v1 to v11 builds can still read and write this schema, so a rollback across it works.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
  // 13: parked steps (spec 2026-10-17-parked-steps-and-loose-tasks-design.md). The status CHECK gains 'parked', which
  // SQLite cannot change in place, so this rebuilds nodes (the first rebuild: see REBUILDS). parked_reason: why a parked
  // step is set aside; parked_where: where its work lives (a branch, worktree or commit); both '' unless parked.
  // parked_at: when it was parked; NULL unless parked. The runner applies it with foreign keys off, or dropping nodes
  // would cascade-delete every row that points at it; parent_id names nodes, so it resolves to the renamed table.
  `
  CREATE TABLE nodes_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
    position REAL NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('goal','phase','task','question')),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','active','done','blocked','dropped','parked')),
    assignee TEXT NOT NULL DEFAULT 'claude' CHECK (assignee IN ('claude','me')),
    outcome TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    label TEXT CHECK (label IS NULL OR label IN ('ui','server','data','integration','ops','docs','fix','refactor','research')),
    board_state TEXT,
    state_since TEXT,
    hue INTEGER,
    driver_session_id TEXT,
    parked_reason TEXT NOT NULL DEFAULT '',
    parked_where TEXT NOT NULL DEFAULT '',
    parked_at TEXT
  );
  INSERT INTO nodes_new (id, project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at, completed_at, label, board_state, state_since, hue, driver_session_id)
    SELECT id, project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at, completed_at, label, board_state, state_since, hue, driver_session_id FROM nodes;
  -- Carry the AUTOINCREMENT high-water mark over: DROP TABLE deletes nodes' sqlite_sequence row, and the copy alone would
  -- restart it at the highest surviving id, so a deleted step's id (still named by old events and queue entries) would
  -- come back on a new step.
  INSERT INTO sqlite_sequence (name, seq) SELECT 'nodes_new', seq FROM sqlite_sequence WHERE name = 'nodes' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'nodes_new');
  UPDATE sqlite_sequence SET seq = max(seq, coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'nodes'), 0)) WHERE name = 'nodes_new';
  DROP TABLE nodes;
  ALTER TABLE nodes_new RENAME TO nodes;
  CREATE INDEX nodes_project ON nodes (project_id);
  CREATE INDEX nodes_parent ON nodes (parent_id, position);
  -- A widened CHECK and defaulted or nullable columns: v1 to v12 builds can still read and write this schema, so a
  -- rollback across it works.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
  // 14: when the session last got a real prompt (#522): a UserPromptSubmit that was not a background-task notice. NULL until
  // its next one.
  `
  ALTER TABLE sessions ADD COLUMN last_prompt_at TEXT;
  -- Only a nullable column: v1 to v13 builds can still read and write this schema, so a rollback across it works.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
  // 15: a page's last confirmation (#528, spec 2026-10-20-library-and-docs-design.md "Freshness"): the owning repo's HEAD
  // and the time, set at registration and by Still accurate. NULL on every other resource.
  `
  ALTER TABLE resources ADD COLUMN confirmed_sha TEXT;
  ALTER TABLE resources ADD COLUMN confirmed_at TEXT;
  -- Only nullable columns: v1 to v14 builds can still read and write this schema, so a rollback across it works.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
  // 16: the title channel (#535): whether a project only nudges a session about its title prefix or also sends it back
  // at Stop, and the full title the session's last Stop block demanded. NULL until its first one.
  `
  ALTER TABLE projects ADD COLUMN title_channel TEXT NOT NULL DEFAULT 'nudge';
  ALTER TABLE sessions ADD COLUMN title_asked TEXT;
  -- A defaulted column and a nullable one: v1 to v15 builds can still read and write this schema, so a rollback across it
  -- works.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
  // 17: the ranked Backlog (#541, spec 2026-10-20-ranked-backlog-design.md section 2). rank_band: the step's band, soon or
  // someday; NULL is unranked (Needs Triage). There is no next band: Next up is the queue. rank: a fractional place within
  // the band, project-wide; NULL inside a band sorts after the ranked steps, in tree order. Every open task or question
  // below the root starts in Soon with no rank (R8), so day one shows today's tree order. updated_at is left alone.
  `
  ALTER TABLE nodes ADD COLUMN rank_band TEXT CHECK (rank_band IS NULL OR rank_band IN ('soon','someday'));
  ALTER TABLE nodes ADD COLUMN rank REAL;
  UPDATE nodes SET rank_band = 'soon'
    WHERE parent_id IS NOT NULL AND status IN ('todo','active','blocked') AND kind IN ('task','question');
  -- Only nullable columns: v1 to v16 builds can still read and write this schema, so a rollback across it works.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
  // 18: What, Why and origin on steps (#536, spec 2026-10-20-inprogress-redesign-design.md section 5). what: what the step
  // implements, written for Aiden; why: why it is worth doing; both '' until set. origin: whose idea it was, me (Aiden's
  // own), asked (work he asked for) or proposed (a session's follow-up). Backfill: me for every id a window node.created
  // event names in data.ids, else asked. Events are pruned after 30 days, so an older window-filed step reads asked.
  // updated_at is left alone.
  `
  ALTER TABLE nodes ADD COLUMN what TEXT NOT NULL DEFAULT '';
  ALTER TABLE nodes ADD COLUMN why TEXT NOT NULL DEFAULT '';
  ALTER TABLE nodes ADD COLUMN origin TEXT NOT NULL DEFAULT 'asked' CHECK (origin IN ('me','asked','proposed'));
  UPDATE nodes SET origin = 'me' WHERE id IN (
    SELECT CAST(j.value AS INTEGER)
    FROM events e, json_each(CASE WHEN json_valid(e.data) THEN e.data ELSE '{}' END, '$.ids') j
    WHERE e.type = 'node.created' AND e.actor = 'window' AND j.type = 'integer'
      -- Array elements only, as the digest reads ids: json_each on a scalar ids yields the scalar itself, keyed NULL.
      AND typeof(j.key) = 'integer'
  );
  -- Defaulted columns: v1 to v17 builds can still read and write this schema, so a rollback across it works.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
];

/**
 * The 0-based indexes into MIGRATIONS that rebuild a table. The runner applies each with foreign keys off (outside
 * its transaction, where SQLite honours the pragma), checks foreign_key_check before committing, and turns them back on.
 */
export const REBUILDS: ReadonlySet<number> = new Set([12]);
