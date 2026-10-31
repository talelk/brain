-- Fresh workspace reference. Required pack tables extend the current schema definition.
-- Never edit Mastra-owned tables; its default is a separate workspace.mastra.db.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 100;
CREATE TABLE workspace_identity (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), workspace_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  schema_digest TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE TABLE cards (
  id TEXT PRIMARY KEY, title TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('to-decide','todo','in-progress','verifying','done','blocked')),
  criteria_json TEXT NOT NULL CHECK(json_valid(criteria_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0), evidence_digest TEXT,
  created_at_ms INTEGER NOT NULL, CHECK(state != 'done' OR evidence_digest IS NOT NULL)
) STRICT;
CREATE TABLE objectives (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, intent TEXT NOT NULL,
  success_criteria_json TEXT NOT NULL CHECK(json_valid(success_criteria_json)),
  owner_id TEXT NOT NULL, active_plan_version_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE plan_versions (
  id TEXT PRIMARY KEY, objective_id TEXT NOT NULL REFERENCES objectives(id),
  revision INTEGER NOT NULL CHECK(revision > 0), digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('proposed','confirmed','superseded')),
  origin TEXT NOT NULL CHECK(origin IN ('manual','agent','template','capitalization')),
  created_by TEXT NOT NULL, summary TEXT, tasks_json TEXT NOT NULL CHECK(json_valid(tasks_json)),
  created_at_ms INTEGER NOT NULL, confirmed_at_ms INTEGER,
  UNIQUE(objective_id,revision)
) STRICT;
CREATE TABLE work_items (
  id TEXT PRIMARY KEY, objective_id TEXT NOT NULL REFERENCES objectives(id),
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id), plan_task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('backlog','ready','in-progress','blocked','review','done','abandoned')),
  criteria_json TEXT NOT NULL CHECK(json_valid(criteria_json)),
  assignment_json TEXT, workflow_id TEXT, next_action TEXT NOT NULL, blocked_reason TEXT,
  scheduled_at_ms INTEGER, evidence_digest TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  UNIQUE(plan_version_id,plan_task_id), CHECK(state != 'done' OR evidence_digest IS NOT NULL)
) STRICT;
CREATE INDEX work_items_board ON work_items(state,updated_at_ms,id);
CREATE INDEX work_items_objective ON work_items(objective_id,plan_version_id,plan_task_id);
CREATE TABLE work_item_dependencies (
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  depends_on_work_item_id TEXT NOT NULL REFERENCES work_items(id),
  PRIMARY KEY(work_item_id,depends_on_work_item_id),
  CHECK(work_item_id != depends_on_work_item_id)
) STRICT;
CREATE TABLE execution_links (
  work_item_id TEXT NOT NULL REFERENCES work_items(id), run_id TEXT NOT NULL,
  job_id TEXT, attempt_id TEXT, session_id TEXT, created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(work_item_id,run_id)
) STRICT;
CREATE TABLE automations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','paused')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('workflow','workItem')),
  target_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('cron','once','manual')),
  cron TEXT, timezone TEXT, scheduled_at_ms INTEGER,
  input_json TEXT CHECK(input_json IS NULL OR json_valid(input_json)),
  overlap TEXT NOT NULL CHECK(overlap IN ('skip','queue-one')),
  misfire TEXT NOT NULL CHECK(misfire IN ('skip','coalesce')),
  execution_mode TEXT NOT NULL CHECK(execution_mode IN ('managed','personal-host')),
  runner_id TEXT, offline_policy TEXT NOT NULL CHECK(offline_policy IN ('wait','fail')),
  created_by TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
  revision_created_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE automation_occurrences (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  planned_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','dispatched','skipped','failed')),
  dispatch_ref TEXT, detail TEXT, fired_at_ms INTEGER
) STRICT;
CREATE INDEX automation_occurrences_history ON automation_occurrences(automation_id, planned_at_ms, id);
CREATE TABLE planning_requests (
  objective_id TEXT PRIMARY KEY REFERENCES objectives(id), actor_id TEXT NOT NULL,
  run_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','ready','failed')),
  plan_version_id TEXT REFERENCES plan_versions(id), error TEXT,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE work_item_comments (
  id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(id),
  actor_id TEXT NOT NULL, body TEXT NOT NULL, correction_of TEXT REFERENCES work_item_comments(id),
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE card_comments (
  id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id), actor_id TEXT NOT NULL,
  body TEXT NOT NULL, correction_of TEXT REFERENCES card_comments(id), created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE decisions (
  id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id), actor_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('go','no','not-now','need-more-data')),
  note TEXT NOT NULL, created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY, execution_key TEXT NOT NULL UNIQUE, config_digest TEXT NOT NULL,
  workflow_digest TEXT NOT NULL, adapter_digest TEXT NOT NULL, engine_run_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('created','validated','ready','running','suspended','succeeded','partial','failed','cancelled','blocked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  wait_generation INTEGER NOT NULL DEFAULT 0 CHECK(wait_generation >= 0),
  input_digest TEXT NOT NULL, output_digest TEXT, created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE workflow_steps (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id), step_id TEXT NOT NULL,
  execution_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
  job_id TEXT, output_digest TEXT, version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  PRIMARY KEY(run_id,step_id)
) STRICT;
CREATE TABLE job_projection (
  job_id TEXT PRIMARY KEY, source_version INTEGER NOT NULL CHECK(source_version > 0),
  source_cursor INTEGER NOT NULL CHECK(source_cursor >= 0), state TEXT NOT NULL,
  queue_reason TEXT, updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, job_id TEXT, attempt_id TEXT,
  mode TEXT NOT NULL DEFAULT 'native' CHECK(mode IN ('native','managed')),
  work_item_id TEXT REFERENCES work_items(id), parent_session_id TEXT REFERENCES sessions(id), root_session_id TEXT,
  agent_id TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '',
  engine_id TEXT NOT NULL, adapter_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('starting','running','waiting','stopping','stopped','failed')),
  checkpoint_digest TEXT, checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR json_valid(checkpoint_json)),
  event_sequence INTEGER NOT NULL DEFAULT 0 CHECK(event_sequence >= 0),
  delegation_depth INTEGER NOT NULL DEFAULT 0 CHECK(delegation_depth BETWEEN 0 AND 3),
  budget_json TEXT NOT NULL DEFAULT '{"maxTokens":100000,"maxMicroUsd":0,"maxTurns":10}' CHECK(json_valid(budget_json)),
  scope_json TEXT NOT NULL DEFAULT '{"allowedPaths":[],"prohibitedPaths":[],"allowedTools":[]}' CHECK(json_valid(scope_json)),
  worktree_id TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at_ms INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX sessions_work_item ON sessions(work_item_id,updated_at_ms,id);
CREATE INDEX sessions_parent ON sessions(parent_session_id,state,id);
CREATE TABLE delegations (
  id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL REFERENCES sessions(id),
  child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id), work_item_id TEXT NOT NULL REFERENCES work_items(id),
  state TEXT NOT NULL CHECK(state IN ('active','accepted','rejected')),
  reviewer_id TEXT, evidence_digest TEXT, created_at_ms INTEGER NOT NULL, reviewed_at_ms INTEGER
) STRICT;
CREATE INDEX delegations_parent ON delegations(parent_session_id,state,id);
CREATE TABLE work_item_messages (
  id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(id),
  session_id TEXT REFERENCES sessions(id), sender_id TEXT NOT NULL,
  sender_kind TEXT NOT NULL CHECK(sender_kind IN ('human','agent','workflow')),
  body TEXT NOT NULL, correction_of TEXT REFERENCES work_item_messages(id), created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX work_item_messages_item ON work_item_messages(work_item_id,created_at_ms,id);
CREATE TABLE documents (
  id TEXT PRIMARY KEY, title TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  current_version_id TEXT NOT NULL, created_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE document_versions (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
  revision INTEGER NOT NULL CHECK(revision > 0), digest TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0), media_type TEXT NOT NULL, file_name TEXT NOT NULL,
  extraction_status TEXT NOT NULL CHECK(extraction_status IN ('ready','unsupported','failed')),
  extracted_text TEXT, created_by TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  UNIQUE(document_id,revision)
) STRICT;
CREATE INDEX document_versions_current ON document_versions(document_id,revision DESC);
CREATE TABLE resource_associations (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
  resource_kind TEXT NOT NULL CHECK(resource_kind IN ('workItem','objective','session','run')),
  resource_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  UNIQUE(document_id,resource_kind,resource_id)
) STRICT;
CREATE INDEX resource_associations_target ON resource_associations(resource_kind,resource_id,document_id);
CREATE VIRTUAL TABLE document_fts USING fts5(document_id UNINDEXED,version_id UNINDEXED,title,content,tokenize='unicode61');
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, digest TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0),
  media_type TEXT NOT NULL, classification TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('uploading','verified','quarantined','deleted')),
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX artifacts_digest ON artifacts(digest,state);
CREATE TABLE evidence_bundles (
  digest TEXT PRIMARY KEY, bundle_id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('assembling','submitted','verified','rejected','incomplete')),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)), created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE verification_verdicts (
  id TEXT PRIMARY KEY, bundle_digest TEXT NOT NULL REFERENCES evidence_bundles(digest),
  evaluator_attempt_id TEXT NOT NULL, evaluator_digest TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('verified','rejected','incomplete')),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)), created_at_ms INTEGER NOT NULL,
  finalized_at_ms INTEGER,
  UNIQUE(bundle_digest,evaluator_attempt_id)
) STRICT;
CREATE TABLE connector_cursors (
  connector_id TEXT PRIMARY KEY, cursor_json TEXT NOT NULL CHECK(json_valid(cursor_json)),
  source_watermark TEXT, version INTEGER NOT NULL CHECK(version > 0), updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE operation_observations (
  root_run_id TEXT NOT NULL, signature TEXT NOT NULL, evidence_digest TEXT NOT NULL,
  operation_id TEXT NOT NULL, parameter_shape_json TEXT NOT NULL CHECK(json_valid(parameter_shape_json)),
  effect_class TEXT NOT NULL CHECK(effect_class IN ('read','write','privileged')), package_digest TEXT NOT NULL,
  verified_success INTEGER NOT NULL CHECK(verified_success IN (0,1)), created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(root_run_id,signature)
) STRICT;
CREATE INDEX operation_observations_signature ON operation_observations(signature,verified_success);
CREATE TABLE knowledge_assets (
  id TEXT PRIMARY KEY, signature TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('extracted','reviewed','published','revoked')),
  classification TEXT NOT NULL CHECK(classification IN ('public','internal','confidential','restricted')),
  content TEXT NOT NULL, source_count INTEGER NOT NULL CHECK(source_count >= 1),
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE tool_candidates (
  id TEXT PRIMARY KEY, signature TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('quarantined','reviewed','rejected','published')),
  source_count INTEGER NOT NULL CHECK(source_count >= 3), package_digest TEXT NOT NULL,
  operation_id TEXT NOT NULL, effect_class TEXT NOT NULL CHECK(effect_class IN ('read','write','privileged')),
  test_status TEXT NOT NULL CHECK(test_status IN ('passed','failed')), definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  created_by TEXT NOT NULL, reviewer_id TEXT, reviewed_at_ms INTEGER, published_at_ms INTEGER, created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE capitalization_runs (
  id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
  requested_by TEXT NOT NULL, observed_count INTEGER NOT NULL DEFAULT 0, extracted_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER, completed_at_ms INTEGER
) STRICT;
CREATE INDEX capitalization_runs_pending ON capitalization_runs(state,created_at_ms);
CREATE TABLE memory_publications (
  id TEXT PRIMARY KEY, content_digest TEXT NOT NULL, target_scope_json TEXT NOT NULL CHECK(json_valid(target_scope_json)),
  state TEXT NOT NULL CHECK(state IN ('candidate','reviewed','publishing','published','revoked','failed')),
  remote_asset_id TEXT, created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE inbox (
  source_id TEXT NOT NULL, event_id TEXT NOT NULL, payload_digest TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL, PRIMARY KEY(source_id,event_id)
) STRICT;
CREATE TABLE events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
  aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, aggregate_seq INTEGER NOT NULL CHECK(aggregate_seq > 0),
  event_type TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_digest TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  UNIQUE(aggregate_type,aggregate_id,aggregate_seq)
) STRICT;
CREATE TABLE outbox_deliveries (
  event_id TEXT NOT NULL REFERENCES events(event_id), destination TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','processing','delivered','parked')),
  next_attempt_at_ms INTEGER NOT NULL, processing_until_ms INTEGER,
  delivered_at_ms INTEGER, PRIMARY KEY(event_id,destination)
) STRICT;
-- A trigger cannot verify external evidence. Application acceptance additionally checks
-- bundle/verdict authority and immutable hashes before moving a card to done.

CREATE TABLE tickets (
  id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, remote_id TEXT NOT NULL,
  state TEXT NOT NULL, title TEXT NOT NULL, body_digest TEXT NOT NULL,
  source_version TEXT NOT NULL, observed_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  created_at_ms INTEGER NOT NULL DEFAULT 0,
  UNIQUE(connector_id,remote_id)
) STRICT;
CREATE TABLE support_drafts (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id),
  version INTEGER NOT NULL CHECK(version>0), content_digest TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL, evidence_digest TEXT NOT NULL,
  author_principal_id TEXT NOT NULL, approval_id TEXT, created_at_ms INTEGER NOT NULL,
  UNIQUE(ticket_id,version)
) STRICT;
CREATE TABLE sla_intervals (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id),
  event_id TEXT NOT NULL UNIQUE, responsibility TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER,
  calendar_digest TEXT NOT NULL, correction_of TEXT REFERENCES sla_intervals(id),
  CHECK(ended_at_ms IS NULL OR ended_at_ms>=started_at_ms)
) STRICT;
CREATE TABLE incidents (
  id TEXT PRIMARY KEY, target_key TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', 
  state TEXT NOT NULL CHECK(state IN ('open','investigating','mitigated','resolved')),
  version INTEGER NOT NULL CHECK(version>0), opened_at_ms INTEGER NOT NULL, resolved_at_ms INTEGER
) STRICT;
CREATE TABLE observations (
  id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, target_key TEXT NOT NULL,
  incident_id TEXT REFERENCES incidents(id), observation_digest TEXT NOT NULL,
  source_event_id TEXT NOT NULL, observed_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
  UNIQUE(connector_id,source_event_id), CHECK(expires_at_ms>observed_at_ms)
) STRICT;
CREATE INDEX observations_target_freshness ON observations(target_key,expires_at_ms);
CREATE TABLE remediation_proposals (
  id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id),
  kind TEXT NOT NULL, detail TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('proposed','approved','rejected')),
  approval_id TEXT, created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE delivery_dossiers (
  id TEXT PRIMARY KEY, source_revision TEXT NOT NULL, manifest_digest TEXT NOT NULL,
  rubric_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('draft','evaluating','verified','rejected')),
  version INTEGER NOT NULL CHECK(version>0), created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE rubric_results (
  dossier_id TEXT NOT NULL REFERENCES delivery_dossiers(id), criterion_id TEXT NOT NULL,
  evaluator_attempt_id TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('passed','failed','incomplete')),
  evidence_digest TEXT NOT NULL, PRIMARY KEY(dossier_id,criterion_id,evaluator_attempt_id)
) STRICT;
CREATE TABLE domain_operation_receipts (
  invocation_id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, target_key TEXT NOT NULL,
  operation TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('applied','absent','conflicting','unknown')),
  receipt_digest TEXT NOT NULL, observed_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE connector_inbox (
  connector_id TEXT NOT NULL, remote_event_id TEXT NOT NULL, payload_digest TEXT NOT NULL,
  source_version TEXT NOT NULL, received_at_ms INTEGER NOT NULL, applied_at_ms INTEGER,
  PRIMARY KEY(connector_id,remote_event_id)
) STRICT;

-- Human task preparation and conversation are durable UX state, never execution authority.
CREATE TABLE task_drafts (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, workflow_id TEXT NOT NULL, workflow_json TEXT NOT NULL,
 config_digest TEXT NOT NULL, input_json TEXT NOT NULL, origin_json TEXT, title TEXT NOT NULL,
 command_id TEXT NOT NULL UNIQUE, conversation_id TEXT, state TEXT NOT NULL CHECK(state IN ('review','started')),
 run_id TEXT, created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX task_drafts_origin ON task_drafts(json_extract(origin_json,'$.kind'),json_extract(origin_json,'$.id'));
CREATE TABLE conversations (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL) STRICT;
CREATE TABLE conversation_messages (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL,
 text TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','done','failed')), run_id TEXT,
 draft_id TEXT REFERENCES task_drafts(id), created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX conversation_messages_thread ON conversation_messages(conversation_id,created_at_ms,id);
