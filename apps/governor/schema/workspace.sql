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
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
  engine_id TEXT NOT NULL, adapter_digest TEXT NOT NULL, state TEXT NOT NULL,
  checkpoint_digest TEXT, event_sequence INTEGER NOT NULL DEFAULT 0 CHECK(event_sequence >= 0),
  updated_at_ms INTEGER NOT NULL DEFAULT 0
) STRICT;
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
  verified_success INTEGER NOT NULL CHECK(verified_success IN (0,1)), created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(root_run_id,signature)
) STRICT;
CREATE TABLE tool_candidates (
  id TEXT PRIMARY KEY, signature TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('quarantined','reviewing','rejected','published')),
  source_count INTEGER NOT NULL CHECK(source_count >= 3), package_digest TEXT, created_at_ms INTEGER NOT NULL
) STRICT;
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
