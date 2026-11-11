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
CREATE TABLE missions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, intent TEXT NOT NULL,
  success_criteria_json TEXT NOT NULL CHECK(json_valid(success_criteria_json)),
  owner_id TEXT NOT NULL, active_plan_version_id TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','verifying','closed')),
  pause_reason TEXT CHECK(pause_reason IS NULL OR pause_reason IN ('human','budget')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('achieved','ended','cancelled')),
  brief_version INTEGER NOT NULL DEFAULT 1 CHECK(brief_version > 0),
  parking_threshold INTEGER NOT NULL DEFAULT 3 CHECK(parking_threshold BETWEEN 1 AND 10),
  auto_start INTEGER NOT NULL DEFAULT 1 CHECK(auto_start IN (0,1)),
  play_id TEXT, play_release_digest TEXT, started_by_occurrence TEXT UNIQUE,
  coordinator_member_id TEXT, coordinator_workflow TEXT,
  final_allowance_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK(final_allowance_micro_usd >= 0),
  budget_micro_usd INTEGER CHECK(budget_micro_usd IS NULL OR budget_micro_usd >= 0),
  budget_wall_ms INTEGER CHECK(budget_wall_ms IS NULL OR budget_wall_ms >= 0),
  member_cap INTEGER NOT NULL DEFAULT 3 CHECK(member_cap BETWEEN 1 AND 50),
  attempt_reserve_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK(attempt_reserve_micro_usd >= 0),
  budget_tokens INTEGER DEFAULT NULL CHECK(budget_tokens IS NULL OR budget_tokens >= 0),
  attempt_reserve_tokens INTEGER NOT NULL DEFAULT 0 CHECK(attempt_reserve_tokens >= 0),
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK(active_ms >= 0), active_since_ms INTEGER,
  policy_json TEXT NOT NULL DEFAULT '{"preset":"standard","operations":["conflictTask.create","decision.accept","member.addExistingRole","task.add","task.change","task.reassign","task.remove"],"version":1}' CHECK(json_valid(policy_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  CHECK((state = 'closed') = (outcome IS NOT NULL)), CHECK(state = 'paused' OR pause_reason IS NULL)
) STRICT;
CREATE TABLE mission_seen (
  principal_id TEXT NOT NULL, mission_id TEXT NOT NULL REFERENCES missions(id),
  cursor INTEGER NOT NULL CHECK(cursor >= 0), seen_at_ms INTEGER NOT NULL,
  PRIMARY KEY(principal_id, mission_id)
) STRICT;
CREATE TABLE mission_watchers (
  principal_id TEXT NOT NULL, mission_id TEXT NOT NULL REFERENCES missions(id), created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(principal_id, mission_id)
) STRICT;
CREATE TABLE attention_notifications (
  principal_id TEXT NOT NULL, item_id TEXT NOT NULL, mission_id TEXT, title TEXT NOT NULL,
  pushed INTEGER NOT NULL DEFAULT 0 CHECK(pushed IN (0,1)), sent_at_ms INTEGER NOT NULL,
  PRIMARY KEY(principal_id, item_id)
) STRICT;
CREATE INDEX attention_notifications_recent ON attention_notifications(principal_id, mission_id, sent_at_ms);
CREATE TABLE mission_subjects (
  mission_id TEXT NOT NULL REFERENCES missions(id), pack TEXT NOT NULL CHECK(pack IN ('support','sre')),
  kind TEXT NOT NULL CHECK(kind IN ('ticket','incident')), subject_id TEXT NOT NULL,
  PRIMARY KEY(mission_id, kind, subject_id)
) STRICT;
CREATE INDEX mission_subjects_subject ON mission_subjects(kind, subject_id);
CREATE TABLE mission_wakes (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), reason TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '', created_at_ms INTEGER NOT NULL, consumed_by_run TEXT, last_error TEXT
) STRICT;
CREATE INDEX mission_wakes_pending ON mission_wakes(mission_id, consumed_by_run);
CREATE TABLE mission_runs (
  run_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id),
  purpose TEXT NOT NULL CHECK(purpose IN ('coordinator')), created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE mission_spend (
  attempt_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), run_id TEXT NOT NULL,
  reserved_micro_usd INTEGER NOT NULL CHECK(reserved_micro_usd >= 0),
  settled_micro_usd INTEGER CHECK(settled_micro_usd IS NULL OR settled_micro_usd >= 0),
  reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reserved_tokens >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  accounting TEXT DEFAULT NULL CHECK(accounting IS NULL OR accounting IN ('final-total','incremental')), estimated INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL, settled_at_ms INTEGER
) STRICT;
CREATE INDEX mission_spend_run ON mission_spend(run_id);
CREATE INDEX mission_spend_settled ON mission_spend(settled_at_ms);
CREATE TABLE workspace_spend_cap (
  id INTEGER PRIMARY KEY CHECK(id = 1), daily_micro_usd INTEGER CHECK(daily_micro_usd IS NULL OR daily_micro_usd >= 0),
  weekly_micro_usd INTEGER CHECK(weekly_micro_usd IS NULL OR weekly_micro_usd >= 0), updated_by TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX mission_spend_open ON mission_spend(mission_id, settled_at_ms);
CREATE TABLE mission_brief_versions (
  mission_id TEXT NOT NULL REFERENCES missions(id), version INTEGER NOT NULL CHECK(version > 0),
  intent TEXT NOT NULL, constraints_json TEXT NOT NULL CHECK(json_valid(constraints_json)),
  change TEXT NOT NULL CHECK(change IN ('created','edited','decision','superseded')),
  rebased_from INTEGER, created_by TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(mission_id, version)
) STRICT;
CREATE TABLE accepted_decisions (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), statement TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('human','handoff','verdict','knowledge')), source_ref TEXT,
  accepted_by TEXT NOT NULL, introduced_version INTEGER NOT NULL, superseded_by TEXT REFERENCES accepted_decisions(id),
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX accepted_decisions_mission ON accepted_decisions(mission_id, introduced_version);
CREATE TABLE mission_outputs (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), name TEXT NOT NULL,
  continues_output_id TEXT REFERENCES mission_outputs(id), created_at_ms INTEGER NOT NULL,
  UNIQUE(mission_id, name)
) STRICT;
CREATE TABLE output_versions (
  id TEXT PRIMARY KEY, output_id TEXT NOT NULL REFERENCES mission_outputs(id), work_item_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('draft','final')),
  verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)), created_at_ms INTEGER NOT NULL,
  CHECK(verified = 0 OR state = 'final')
) STRICT;
CREATE TABLE work_item_inputs (
  work_item_id TEXT NOT NULL, run_id TEXT NOT NULL, output_version_id TEXT NOT NULL REFERENCES output_versions(id),
  artifact_digest TEXT NOT NULL, PRIMARY KEY(work_item_id, run_id, output_version_id)
) STRICT;
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), work_item_id TEXT NOT NULL REFERENCES work_items(id),
  version INTEGER NOT NULL CHECK(version > 0), notes_json TEXT NOT NULL CHECK(json_valid(notes_json)),
  facts_json TEXT CHECK(facts_json IS NULL OR json_valid(facts_json)), submitted_by TEXT NOT NULL,
  superseded_by TEXT REFERENCES handoffs(id), created_at_ms INTEGER NOT NULL,
  UNIQUE(work_item_id, version)
) STRICT;
CREATE TABLE mission_evidence_bundles (
  digest TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id),
  state TEXT NOT NULL CHECK(state IN ('submitted','verified','rejected','incomplete')),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)), findings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(findings_json)),
  verdict_by TEXT, created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE mission_bundle_checks (
  bundle_digest TEXT NOT NULL REFERENCES mission_evidence_bundles(digest), criterion_id TEXT NOT NULL,
  evaluator TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('passed','failed','incomplete')),
  evidence_digest TEXT NOT NULL, advisory INTEGER NOT NULL CHECK(advisory IN (0,1)), created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(bundle_digest, criterion_id, evaluator)
) STRICT;
CREATE TABLE mission_messages (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id),
  recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('mission','member')), recipient_member_id TEXT,
  work_item_id TEXT, sender_id TEXT NOT NULL, body TEXT NOT NULL,
  delivery TEXT NOT NULL DEFAULT 'pending' CHECK(delivery IN ('pending','delivered-live','delivered-at-session-start','superseded')),
  correction_of TEXT REFERENCES mission_messages(id), created_at_ms INTEGER NOT NULL,
  CHECK((recipient_kind = 'member') = (recipient_member_id IS NOT NULL))
) STRICT;
CREATE TABLE plan_versions (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id),
  revision INTEGER NOT NULL CHECK(revision > 0), digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('proposed','confirmed','superseded','rejected')),
  origin TEXT NOT NULL CHECK(origin IN ('manual','agent','template','capitalization')),
  created_by TEXT NOT NULL, summary TEXT, tasks_json TEXT NOT NULL CHECK(json_valid(tasks_json)),
  team_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(team_json)),
  created_at_ms INTEGER NOT NULL, confirmed_at_ms INTEGER,
  UNIQUE(mission_id,revision)
) STRICT;
CREATE TABLE work_items (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id),
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id), plan_task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('backlog','ready','in-progress','blocked','review','done','abandoned')),
  criteria_json TEXT NOT NULL CHECK(json_valid(criteria_json)),
  assignment_json TEXT, workflow_id TEXT, next_action TEXT NOT NULL, blocked_reason TEXT,
  scheduled_at_ms INTEGER, evidence_digest TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts >= 0),
  parked INTEGER NOT NULL DEFAULT 0 CHECK(parked IN (0,1)), parked_diagnostic TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  UNIQUE(plan_version_id,plan_task_id), CHECK(state != 'done' OR evidence_digest IS NOT NULL)
) STRICT;
CREATE INDEX work_items_board ON work_items(state,updated_at_ms,id);
CREATE INDEX work_items_mission ON work_items(mission_id,plan_version_id,plan_task_id);
CREATE TABLE work_item_dependencies (
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  depends_on_work_item_id TEXT NOT NULL REFERENCES work_items(id),
  PRIMARY KEY(work_item_id,depends_on_work_item_id),
  CHECK(work_item_id != depends_on_work_item_id)
) STRICT;
CREATE TABLE execution_links (
  mission_id TEXT NOT NULL REFERENCES missions(id),
  work_item_id TEXT NOT NULL REFERENCES work_items(id), run_id TEXT NOT NULL,
  job_id TEXT, attempt_id TEXT, session_id TEXT, created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(work_item_id,run_id)
) STRICT;
CREATE TABLE automations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','paused','retired')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('workflow','workItem','play')),
  target_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('cron','once','manual','subject')), subject_kind TEXT CHECK(subject_kind IS NULL OR subject_kind IN ('ticket','incident')),
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
  dispatch_ref TEXT, detail TEXT, fired_at_ms INTEGER,
  subject_json TEXT CHECK(subject_json IS NULL OR json_valid(subject_json))
) STRICT;
CREATE INDEX automation_occurrences_history ON automation_occurrences(automation_id, planned_at_ms, id);
CREATE TABLE planning_requests (
  mission_id TEXT PRIMARY KEY REFERENCES missions(id), actor_id TEXT NOT NULL,
  run_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','ready','failed')),
  plan_version_id TEXT REFERENCES plan_versions(id), error TEXT,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE work_item_comments (
  id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(id),
  actor_id TEXT NOT NULL, body TEXT NOT NULL, correction_of TEXT REFERENCES work_item_comments(id),
  created_at_ms INTEGER NOT NULL
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
  engine_features TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(engine_features)),
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
  resource_kind TEXT NOT NULL CHECK(resource_kind IN ('workItem','mission','session','run')),
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
  title TEXT NOT NULL DEFAULT '', mission_id TEXT DEFAULT NULL, producer_id TEXT DEFAULT NULL,
  provenance_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(provenance_json)),
  reviewed_by TEXT DEFAULT NULL, self_reviewed INTEGER NOT NULL DEFAULT 0 CHECK(self_reviewed IN (0,1)),
  reviewed_at_ms INTEGER DEFAULT NULL, rejection_reason TEXT DEFAULT NULL, content_digest TEXT DEFAULT NULL,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;
-- Reuse (#66): what Brain can offer a new mission. Rows are written when the source becomes
-- reusable and re-checked against the live source on every read. The FTS table ranks by BM25.
CREATE TABLE reuse_items (
  item_ref TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('mission','output','knowledge','play','handoff')),
  mission_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL, source_digest TEXT,
  verified_at_ms INTEGER NOT NULL, indexed_at_ms INTEGER NOT NULL
) STRICT;
CREATE VIRTUAL TABLE reuse_fts USING fts5(item_ref UNINDEXED,title,body,tokenize='unicode61 remove_diacritics 2');
-- Attach records: the only source of "used N times" and of the Reused line (#68, #70).
CREATE TABLE reuse_attachments (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), item_ref TEXT NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL, last_verified_ms INTEGER NOT NULL, provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
  self_reviewed INTEGER NOT NULL DEFAULT 0 CHECK(self_reviewed IN (0,1)), used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0,1)),
  decision TEXT NOT NULL CHECK(decision IN ('kept','dropped')), decided_by TEXT NOT NULL, decided_at_ms INTEGER NOT NULL,
  UNIQUE(mission_id,item_ref)
) STRICT;
CREATE INDEX reuse_attachments_item ON reuse_attachments(item_ref,decision);
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
  requested_by TEXT NOT NULL, mission_id TEXT, observed_count INTEGER NOT NULL DEFAULT 0, extracted_count INTEGER NOT NULL DEFAULT 0,
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
-- Session control intents recorded at intake; the runner heartbeat drains them.
CREATE TABLE session_controls (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL
) STRICT;
-- Workflow engine state: dispatch input, step outputs, child links, durable waits.
CREATE TABLE run_inputs (
 run_id TEXT PRIMARY KEY, input_json TEXT NOT NULL, workflow_json TEXT NOT NULL,
 actor_id TEXT NOT NULL, runner_id TEXT
) STRICT;
CREATE TABLE step_outputs (
 run_id TEXT NOT NULL, step_id TEXT NOT NULL, output_json TEXT NOT NULL,
 PRIMARY KEY(run_id, step_id)
) STRICT;
CREATE TABLE engine_links (
 child_run_id TEXT PRIMARY KEY, parent_run_id TEXT NOT NULL, parent_step_id TEXT NOT NULL,
 parent_workspace_id TEXT NOT NULL
) STRICT;
CREATE TABLE engine_resumes (
 run_id TEXT NOT NULL, step_id TEXT NOT NULL, output_json TEXT NOT NULL, ok INTEGER NOT NULL,
 created_at_ms INTEGER NOT NULL, PRIMARY KEY(run_id, step_id)
) STRICT;
-- Connector observation intake: accepted facts and parked id-collisions.
CREATE TABLE source_observations (
 source_id TEXT NOT NULL, external_id TEXT NOT NULL, cursor TEXT NOT NULL,
 payload_digest TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL, PRIMARY KEY(source_id, external_id)
) STRICT;
CREATE TABLE parked_observations (
 source_id TEXT NOT NULL, external_id TEXT NOT NULL, payload_digest TEXT NOT NULL,
 payload_json TEXT NOT NULL, reason TEXT NOT NULL, created_at_ms INTEGER NOT NULL
) STRICT;
-- Command funnel effect marker (ADR 0002): written in the same transaction as
-- a workspace command's effect, so a retry after a crash reuses the result.
CREATE TABLE command_effects (
 command_id TEXT PRIMARY KEY, result_json TEXT NOT NULL CHECK(json_valid(result_json)),
 created_at_ms INTEGER NOT NULL
) STRICT;
