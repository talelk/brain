-- Brain's data (docs/architecture.md section 3). Applied once to an empty database, after auth/auth.sql; there are no migrations.
-- Times are milliseconds since 1970 (`*_at_ms`), money is micro-USD, JSON columns end in `_json`.

CREATE TABLE instance (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE instance_admins (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  created_at_ms INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  -- The digest of the last valid snapshot; a row of `snapshots`.
  active_snapshot TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'member', 'admin')),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX members_user ON members(user_id);

-- One row per snapshot a workspace has had active. The manifest is the CAS entry `digest`; `commit_sha` is the commit that last produced it.
CREATE TABLE snapshots (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  digest TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, digest)
) STRICT, WITHOUT ROWID;

-- `value` is nonce (12) || tag (16) || AES-256-GCM ciphertext, bound to the workspace and the name.
CREATE TABLE secrets (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  value BLOB NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, name)
) STRICT, WITHOUT ROWID;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  parent_id TEXT REFERENCES tasks(id),
  -- The top task of the tree; its own id for a root.
  root_id TEXT NOT NULL,
  -- The order among the sub-tasks of one parent.
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  -- Null for a task that only groups sub-tasks.
  agent TEXT,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'ready', 'running', 'needs_you', 'done', 'failed', 'stopped')),
  snapshot_digest TEXT NOT NULL,
  -- Origin: the Play and its inputs (on the root), the step, and for a copy of a `for_each` step its item.
  play TEXT,
  inputs_json TEXT,
  step_id TEXT,
  item_index INTEGER,
  item_json TEXT,
  -- Step settings.
  for_each TEXT,
  when_expr TEXT,
  review_by TEXT,
  max_rounds INTEGER NOT NULL DEFAULT 2,
  target_score REAL,
  approve INTEGER NOT NULL DEFAULT 0,
  candidates_json TEXT,
  judge TEXT,
  round INTEGER NOT NULL DEFAULT 1,
  result TEXT,
  output_json TEXT,
  -- Why the task needs a person (a TaskNeed), when state is needs_you.
  needs_json TEXT,
  -- A user id, `agent:<attempt id>` or `trigger:<play>`.
  created_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  version INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX tasks_workspace_state ON tasks(workspace_id, state);
CREATE INDEX tasks_workspace_created ON tasks(workspace_id, created_at_ms);
CREATE INDEX tasks_parent ON tasks(parent_id, position);
CREATE INDEX tasks_root ON tasks(root_id);

CREATE TABLE task_deps (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  waits_for TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, waits_for)
) STRICT, WITHOUT ROWID;
CREATE INDEX task_deps_waits_for ON task_deps(waits_for);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  root_id TEXT NOT NULL REFERENCES tasks(id),
  -- An agent name with its attempt, or a user id.
  author TEXT NOT NULL,
  attempt_id TEXT,
  text TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX notes_root ON notes(root_id, id);

CREATE TABLE runners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'removed')),
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  engines_json TEXT NOT NULL DEFAULT '[]',
  slots INTEGER NOT NULL DEFAULT 0,
  free_slots INTEGER NOT NULL DEFAULT 0,
  version TEXT NOT NULL DEFAULT '',
  last_seen_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  removed_at_ms INTEGER
) STRICT;

-- One-use enrolment tokens and the session tokens `hello` hands out; only a keyed digest of a token is kept.
CREATE TABLE runner_tokens (
  token_digest TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('enroll', 'session')),
  runner_id TEXT REFERENCES runners(id),
  name TEXT,
  created_by TEXT,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  used_at_ms INTEGER
) STRICT, WITHOUT ROWID;
CREATE INDEX runner_tokens_runner ON runner_tokens(runner_id);

CREATE TABLE runner_challenges (
  id TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL REFERENCES runners(id),
  nonce TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  used_at_ms INTEGER
) STRICT, WITHOUT ROWID;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('work', 'plan', 'check', 'judge', 'act')),
  agent TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'offered', 'running', 'succeeded', 'failed', 'held', 'stopped')),
  -- The round of the task this attempt belongs to, and its place among the candidates of that round.
  round INTEGER NOT NULL DEFAULT 1,
  candidate INTEGER,
  runner_id TEXT REFERENCES runners(id),
  engine TEXT,
  -- Moves every time the attempt is offered again; a request with an older fence is refused.
  fence INTEGER NOT NULL DEFAULT 0,
  offer_expires_at_ms INTEGER,
  lease_expires_at_ms INTEGER,
  -- Infrastructure retries: how many so far, and when the attempt may be claimed again.
  tries INTEGER NOT NULL DEFAULT 0,
  available_at_ms INTEGER NOT NULL,
  -- What the attempt is given beyond its task: findings to answer, the result under check, the approved call of an `act`.
  payload_json TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  output_json TEXT,
  failure_json TEXT,
  receipt_json TEXT,
  receipt_signature TEXT,
  -- The patch this attempt left (a CAS digest) and the commit of each project it was made on.
  working_copy TEXT,
  base_commits_json TEXT,
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  finished_at_ms INTEGER
) STRICT;
CREATE INDEX attempts_queue ON attempts(state, available_at_ms, created_at_ms);
CREATE INDEX attempts_task ON attempts(task_id, created_at_ms);
CREATE INDEX attempts_workspace_state ON attempts(workspace_id, state);
CREATE INDEX attempts_runner ON attempts(runner_id, state);

CREATE TABLE attempt_events (
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  seq INTEGER NOT NULL,
  at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body_json TEXT NOT NULL,
  PRIMARY KEY (attempt_id, seq)
) STRICT, WITHOUT ROWID;

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  tool TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('write', 'privileged')),
  subject_json TEXT NOT NULL,
  subject_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'expired')),
  -- 1 when a standing approval of brain.toml covered the call.
  standing INTEGER NOT NULL DEFAULT 0,
  expires_at_ms INTEGER,
  decided_by TEXT,
  decided_at_ms INTEGER,
  reason TEXT,
  created_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX approvals_workspace_state ON approvals(workspace_id, state, created_at_ms);
CREATE INDEX approvals_task ON approvals(task_id);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  tool TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('read', 'write', 'privileged')),
  input_json TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  output_json TEXT,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'succeeded', 'failed', 'held', 'rejected')),
  approval_id TEXT REFERENCES approvals(id),
  created_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER
) STRICT;
CREATE INDEX tool_calls_attempt ON tool_calls(attempt_id, created_at_ms);
CREATE INDEX tool_calls_task ON tool_calls(task_id, created_at_ms);

CREATE TABLE standing_uses (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  tool TEXT NOT NULL,
  -- YYYY-MM-DD, UTC.
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, tool, day)
) STRICT, WITHOUT ROWID;

CREATE TABLE checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  round INTEGER NOT NULL,
  by_kind TEXT NOT NULL CHECK (by_kind IN ('agent', 'person')),
  -- An agent name or a user id.
  by_id TEXT NOT NULL,
  attempt_id TEXT REFERENCES attempts(id),
  pass INTEGER NOT NULL,
  score REAL,
  findings TEXT NOT NULL DEFAULT '',
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX checks_task ON checks(task_id, id);

CREATE TABLE usage (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent TEXT NOT NULL,
  model TEXT,
  -- YYYY-MM-DD, UTC: the day the cost counts against the workspace's daily cap.
  day TEXT NOT NULL,
  reserved_micro_usd INTEGER NOT NULL DEFAULT 0,
  -- What the model gateway has measured so far, from the answers of the models it forwarded to.
  metered_micro_usd INTEGER NOT NULL DEFAULT 0,
  -- Null until the attempt ends; then the reservation no longer counts.
  settled_micro_usd INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  settled_at_ms INTEGER
) STRICT, WITHOUT ROWID;
CREATE INDEX usage_workspace_day ON usage(workspace_id, day);
CREATE INDEX usage_task ON usage(task_id);

CREATE TABLE artifacts (
  digest TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- What a CAS entry belongs to. Bytes are served to a member of `workspace_id`.
CREATE TABLE artifact_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  digest TEXT NOT NULL REFERENCES artifacts(digest),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT REFERENCES tasks(id),
  attempt_id TEXT REFERENCES attempts(id),
  name TEXT NOT NULL,
  -- `patch`, `output`, `log`, ...
  kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX artifact_links_digest ON artifact_links(digest);
CREATE INDEX artifact_links_task ON artifact_links(task_id);
CREATE INDEX artifact_links_attempt ON artifact_links(attempt_id);

-- The audit chain. `seq` has no gaps; every row links to the one before it.
CREATE TABLE events (
  seq INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  workspace_id TEXT,
  subject TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('person', 'agent', 'runner', 'system')),
  actor_id TEXT NOT NULL,
  actor_attempt_id TEXT,
  created_at_ms INTEGER NOT NULL,
  prev_digest TEXT NOT NULL,
  chain_digest TEXT NOT NULL
) STRICT;
CREATE INDEX events_workspace ON events(workspace_id, seq);
CREATE INDEX events_subject ON events(subject, seq);

-- `public_key` is the SPKI DER in base64; the private half is a file under <data>/audit.
CREATE TABLE audit_keys (
  key_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  retired_at_ms INTEGER
) STRICT, WITHOUT ROWID;

CREATE TABLE audit_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  through_seq INTEGER NOT NULL,
  chain_digest TEXT NOT NULL,
  key_id TEXT NOT NULL REFERENCES audit_keys(key_id),
  signature TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE triggers (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  play TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('schedule', 'webhook')),
  -- The cron expression, or the webhook event (`github.<event>`).
  spec TEXT NOT NULL,
  next_run_at_ms INTEGER,
  last_run_at_ms INTEGER,
  -- The root task of the last occurrence; the next one is skipped while it is still running.
  last_task_id TEXT REFERENCES tasks(id),
  PRIMARY KEY (workspace_id, play)
) STRICT, WITHOUT ROWID;
CREATE INDEX triggers_due ON triggers(kind, next_run_at_ms);

CREATE TABLE webhook_deliveries (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  delivery_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, delivery_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE pull_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT REFERENCES attempts(id),
  project TEXT NOT NULL,
  branch TEXT NOT NULL,
  url TEXT NOT NULL,
  number INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX pull_requests_task ON pull_requests(task_id);

-- Search over the memory entries of each workspace's active snapshot.
CREATE VIRTUAL TABLE memory_index USING fts5(workspace_id UNINDEXED, name UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE memory_proposals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id),
  attempt_id TEXT REFERENCES attempts(id),
  -- The agent that proposed it.
  proposed_by TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'rejected')),
  decided_by TEXT,
  decided_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX memory_proposals_workspace ON memory_proposals(workspace_id, state, created_at_ms);

-- A command repeated with the same key answers what it answered the first time. `request_digest` is keyed, so it does not reveal the input.
CREATE TABLE idempotency (
  actor_id TEXT NOT NULL,
  key TEXT NOT NULL,
  command TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (actor_id, key)
) STRICT, WITHOUT ROWID;
