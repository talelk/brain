-- Fresh current-format reference schema, not a complete production database.
-- Better Auth tables are generated separately from the pinned plugin configuration.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 100;

CREATE TABLE schema_metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  schema_digest TEXT NOT NULL, initialized_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE organizations (
  id TEXT PRIMARY KEY, auth_organization_id TEXT NOT NULL UNIQUE,
  revocation_generation INTEGER NOT NULL DEFAULT 1 CHECK(revocation_generation > 0)
) STRICT;
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  slug TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','discovering','configured','verifying','active','suspended','exporting','archived','restore_pending','restore_blocked')),
  description TEXT NOT NULL DEFAULT '', owner_id TEXT, tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json)),
  autonomy_ceiling_json TEXT CHECK(autonomy_ceiling_json IS NULL OR json_valid(autonomy_ceiling_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  UNIQUE(organization_id, slug), UNIQUE(id, organization_id)
) STRICT;
CREATE TABLE git_connections (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('github','github-enterprise','gitlab','gitea')),
  base_url TEXT NOT NULL, encrypted_credentials TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','verified','failed')), detail TEXT,
  repositories_json TEXT NOT NULL CHECK(json_valid(repositories_json)),
  remote_refs_json TEXT NOT NULL CHECK(json_valid(remote_refs_json)),
  created_by TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  last_verified_at_ms INTEGER, UNIQUE(organization_id,name)
) STRICT;
CREATE TABLE repository_bindings (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES git_connections(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK(kind IN ('configuration','project')), repository_key TEXT NOT NULL,
  access TEXT NOT NULL CHECK(access IN ('read','write')),
  status TEXT NOT NULL CHECK(status IN ('pending','verified','failed')), detail TEXT,
  created_by TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  last_verified_at_ms INTEGER, UNIQUE(connection_id,workspace_id,kind,repository_key)
) STRICT;
CREATE INDEX repository_bindings_workspace ON repository_bindings(workspace_id,kind,status);
CREATE TABLE verification_requests (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES git_connections(id),
  state TEXT NOT NULL CHECK(state IN ('pending','complete','failed')),
  requested_at_ms INTEGER NOT NULL, completed_at_ms INTEGER
) STRICT;
CREATE INDEX verification_requests_pending ON verification_requests(state,requested_at_ms,id);
CREATE TABLE git_proposals (
  id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES repository_bindings(id),
  source_event_id TEXT NOT NULL, digest TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('configuration','project')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  state TEXT NOT NULL CHECK(state IN ('proposed','superseded','accepted','rejected')),
  created_at_ms INTEGER NOT NULL, UNIQUE(binding_id,source_event_id)
) STRICT;
CREATE TABLE config_drafts (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id), title TEXT NOT NULL, kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','valid','invalid','publishing','published','failed')),
  current_revision_id TEXT NOT NULL, binding_id TEXT REFERENCES repository_bindings(id),
  created_by TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX config_drafts_workspace ON config_drafts(organization_id,workspace_id,updated_at_ms,id);
CREATE TABLE config_draft_revisions (
  id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES config_drafts(id),
  revision INTEGER NOT NULL CHECK(revision > 0), digest TEXT NOT NULL,
  documents_json TEXT NOT NULL CHECK(json_valid(documents_json)),
  assets_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(assets_json)),
  source TEXT NOT NULL CHECK(source IN ('visual','yaml')), created_by TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  UNIQUE(draft_id,revision)
) STRICT;
CREATE TABLE validation_runs (
  id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES config_drafts(id),
  revision_id TEXT NOT NULL REFERENCES config_draft_revisions(id),
  kind TEXT NOT NULL CHECK(kind IN ('validate','test')), status TEXT NOT NULL CHECK(status IN ('passed','failed')),
  diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json)), created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE publication_requests (
  id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES config_drafts(id),
  revision_id TEXT NOT NULL REFERENCES config_draft_revisions(id), binding_id TEXT NOT NULL REFERENCES repository_bindings(id),
  state TEXT NOT NULL CHECK(state IN ('queued','compiled','failed')),
  commit_oid TEXT, release_digest TEXT, error TEXT,
  requested_by TEXT NOT NULL, requested_at_ms INTEGER NOT NULL, completed_at_ms INTEGER
) STRICT;
CREATE INDEX publication_requests_queue ON publication_requests(state,requested_at_ms,id);
CREATE TABLE config_releases (
  digest TEXT NOT NULL, organization_id TEXT NOT NULL REFERENCES organizations(id),
  source_revision TEXT NOT NULL, compiler_digest TEXT NOT NULL,
  source_documents_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_documents_json)),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)), created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(organization_id, digest)
) STRICT;
CREATE TABLE active_config (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
  release_digest TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  FOREIGN KEY(organization_id, release_digest) REFERENCES config_releases(organization_id, digest)
) STRICT;
CREATE TABLE runners (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  group_id TEXT NOT NULL, identity_key_digest TEXT NOT NULL,
  admin_state TEXT NOT NULL CHECK(admin_state IN ('enabled','draining','quarantined','disabled')),
  session_epoch INTEGER NOT NULL DEFAULT 0 CHECK(session_epoch >= 0),
  boot_nonce TEXT, health TEXT NOT NULL CHECK(health IN ('healthy','degraded','unhealthy')),
  last_heartbeat_ms INTEGER, heartbeat_seq INTEGER NOT NULL DEFAULT 0 CHECK(heartbeat_seq >= 0),
  heartbeat_digest TEXT, config_digest TEXT NOT NULL,
  cpu_capacity INTEGER NOT NULL CHECK(cpu_capacity >= 0), memory_capacity INTEGER NOT NULL CHECK(memory_capacity >= 0),
  disk_capacity INTEGER NOT NULL CHECK(disk_capacity >= 0), slot_capacity INTEGER NOT NULL CHECK(slot_capacity > 0),
  cpu_reserved INTEGER NOT NULL DEFAULT 0 CHECK(cpu_reserved >= 0 AND cpu_reserved <= cpu_capacity),
  memory_reserved INTEGER NOT NULL DEFAULT 0 CHECK(memory_reserved >= 0 AND memory_reserved <= memory_capacity),
  disk_reserved INTEGER NOT NULL DEFAULT 0 CHECK(disk_reserved >= 0 AND disk_reserved <= disk_capacity),
  slots_reserved INTEGER NOT NULL DEFAULT 0 CHECK(slots_reserved >= 0 AND slots_reserved <= slot_capacity),
  deregistered_at_ms INTEGER,
  engines_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(engines_json)),
  UNIQUE(id, organization_id)
) STRICT;
CREATE TABLE runner_capabilities (
  runner_id TEXT NOT NULL REFERENCES runners(id), capability TEXT NOT NULL,
  verified INTEGER NOT NULL CHECK(verified IN (0,1)), source TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY(runner_id, capability), CHECK(expires_at_ms > observed_at_ms)
) STRICT;
-- jobs.step_failures: attempts that failed on their own account (not platform interruptions), what a step's retry count is measured against.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  execution_key TEXT NOT NULL, workflow_run_id TEXT NOT NULL, step_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','offered','running','verifying','succeeded','partial','failed','cancelled','blocked','outcome_unknown')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0), config_digest TEXT NOT NULL,
  placement_json TEXT NOT NULL CHECK(json_valid(placement_json)), execution_digest TEXT NOT NULL,
  effect_class TEXT NOT NULL CHECK(effect_class IN ('read','write','privileged')),
  queue_reason TEXT, priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 3),
  created_at_ms INTEGER NOT NULL, ready_at_ms INTEGER NOT NULL, deadline_ms INTEGER NOT NULL,
  attempt_counter INTEGER NOT NULL DEFAULT 0 CHECK(attempt_counter >= 0),
  job_fence INTEGER NOT NULL DEFAULT 0 CHECK(job_fence >= 0),
  auto_retries INTEGER NOT NULL DEFAULT 0 CHECK(auto_retries >= 0),
  step_failures INTEGER NOT NULL DEFAULT 0 CHECK(step_failures >= 0),
  UNIQUE(organization_id, execution_key),
  FOREIGN KEY(workspace_id, organization_id) REFERENCES workspaces(id, organization_id),
  FOREIGN KEY(organization_id, config_digest) REFERENCES config_releases(organization_id, digest)
) STRICT;
CREATE INDEX jobs_ready ON jobs(state, ready_at_ms, priority, created_at_ms, id);
CREATE INDEX jobs_workspace ON jobs(workspace_id, created_at_ms, id);
-- jobs.list counts a workspace's runs (optionally by state): covering this lets the count read the index only instead of one table row per run.
CREATE INDEX jobs_scope_state ON jobs(organization_id, workspace_id, state);
CREATE INDEX jobs_scope_created ON jobs(organization_id, workspace_id, created_at_ms DESC, id DESC);
-- A run's jobs (job.get by run id, the run's engine events): without it each lookup scans every job of the organization.
CREATE INDEX jobs_run ON jobs(organization_id, workflow_run_id, created_at_ms);
-- job_attempts.deadline_ms: when the step's timeoutSeconds ends the attempt, set as it starts running; NULL when the step declares no timeout.
CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
  runner_id TEXT NOT NULL REFERENCES runners(id), runner_epoch INTEGER NOT NULL CHECK(runner_epoch > 0),
  attempt_no INTEGER NOT NULL CHECK(attempt_no > 0), lease_id TEXT NOT NULL UNIQUE,
  job_fence INTEGER NOT NULL CHECK(job_fence > 0),
  state TEXT NOT NULL CHECK(state IN ('offered','running','uploading','cancelling','verifying','succeeded','partial','failed','cancelled','declined','expired','outcome_unknown')),
  offer_expires_at_ms INTEGER NOT NULL, lease_expires_at_ms INTEGER NOT NULL,
  last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_event_seq >= 0),
  receipt_digest TEXT, cleanup_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_confirmed IN (0,1)),
  interruption TEXT DEFAULT NULL CHECK(interruption IS NULL OR interruption IN ('platform')),
  failure_reason TEXT DEFAULT NULL,
  deadline_ms INTEGER DEFAULT NULL,
  reported_engine TEXT DEFAULT NULL, reported_model TEXT DEFAULT NULL,
  UNIQUE(job_id, attempt_no), UNIQUE(job_id, job_fence)
) STRICT;
CREATE UNIQUE INDEX one_active_attempt ON job_attempts(job_id)
WHERE state IN ('offered','running','uploading','cancelling','verifying','outcome_unknown');
CREATE INDEX attempts_expiry ON job_attempts(state, lease_expires_at_ms);
CREATE INDEX attempts_deadline ON job_attempts(state, deadline_ms);
CREATE TABLE runner_claim_requests (
  runner_id TEXT NOT NULL REFERENCES runners(id), runner_epoch INTEGER NOT NULL CHECK(runner_epoch > 0),
  request_id TEXT NOT NULL, attempt_id TEXT REFERENCES job_attempts(id),
  request_digest TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(runner_id, runner_epoch, request_id)
) STRICT;
CREATE TABLE capacity_reservations (
  attempt_id TEXT PRIMARY KEY REFERENCES job_attempts(id), runner_id TEXT NOT NULL REFERENCES runners(id),
  cpu INTEGER NOT NULL CHECK(cpu > 0), memory INTEGER NOT NULL CHECK(memory > 0),
  disk INTEGER NOT NULL CHECK(disk > 0), slots INTEGER NOT NULL CHECK(slots > 0),
  released_at_ms INTEGER
) STRICT;
CREATE TABLE resource_fences (
  resource_key TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  counter INTEGER NOT NULL CHECK(counter > 0 AND counter <= 9007199254740991)
) STRICT;
CREATE TABLE resource_leases (
  resource_key TEXT PRIMARY KEY REFERENCES resource_fences(resource_key),
  attempt_id TEXT NOT NULL REFERENCES job_attempts(id), invocation_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK(fence > 0), expires_at_ms INTEGER NOT NULL,
  unresolved_effect INTEGER NOT NULL CHECK(unresolved_effect IN (0,1))
) STRICT;
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  requested_by TEXT NOT NULL, subject_digest TEXT NOT NULL,
  subject_json TEXT NOT NULL CHECK(json_valid(subject_json)),
  state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','expired','revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  expires_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(workspace_id, organization_id) REFERENCES workspaces(id, organization_id)
) STRICT;
CREATE INDEX approvals_pending ON approval_requests(organization_id,state,expires_at_ms);
CREATE INDEX approvals_scope_expiry ON approval_requests(organization_id,workspace_id,expires_at_ms);
CREATE TABLE approval_decisions (
  id TEXT PRIMARY KEY, approval_id TEXT NOT NULL REFERENCES approval_requests(id),
  expected_version INTEGER NOT NULL CHECK(expected_version > 0), actor_id TEXT NOT NULL,
  auth_evidence_ref TEXT NOT NULL, subject_digest TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approve','reject','request-changes','revoke')),
  note TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  UNIQUE(approval_id, expected_version)
) STRICT;
CREATE TABLE approval_consumptions (
  approval_id TEXT PRIMARY KEY REFERENCES approval_requests(id),
  invocation_id TEXT NOT NULL UNIQUE, attempt_id TEXT NOT NULL REFERENCES job_attempts(id),
  subject_digest TEXT NOT NULL, consumed_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE effect_permits (
  id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL UNIQUE,
  attempt_id TEXT NOT NULL REFERENCES job_attempts(id), subject_digest TEXT NOT NULL,
  approval_id TEXT REFERENCES approval_requests(id),
  state TEXT NOT NULL CHECK(state IN ('issued','started','applied','absent','conflicting','unknown','revoked')),
  revocation_generation INTEGER NOT NULL CHECK(revocation_generation > 0),
  expires_at_ms INTEGER NOT NULL, receipt_digest TEXT, created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE budget_reservations (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id), job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  period_key TEXT NOT NULL, micro_usd INTEGER NOT NULL CHECK(micro_usd >= 0),
  tokens INTEGER NOT NULL CHECK(tokens >= 0), settled_micro_usd INTEGER CHECK(settled_micro_usd >= 0)
) STRICT;
CREATE TABLE command_idempotency (
  organization_id TEXT NOT NULL REFERENCES organizations(id), actor_id TEXT NOT NULL,
  command_type TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL, command_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(organization_id, actor_id, command_type, idempotency_key)
) STRICT;
CREATE TABLE command_intents (
  command_id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)), state TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL REFERENCES organizations(id), workspace_id TEXT REFERENCES workspaces(id),
  aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, aggregate_seq INTEGER NOT NULL CHECK(aggregate_seq > 0),
  event_type TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_digest TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  UNIQUE(organization_id,aggregate_type,aggregate_id,aggregate_seq)
) STRICT;
CREATE TABLE outbox_deliveries (
  event_id TEXT NOT NULL REFERENCES events(event_id), destination TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','processing','delivered','parked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at_ms INTEGER NOT NULL, processing_until_ms INTEGER,
  delivered_at_ms INTEGER, last_error TEXT, PRIMARY KEY(event_id,destination)
) STRICT;
CREATE INDEX outbox_due ON outbox_deliveries(state,next_attempt_at_ms);
CREATE TABLE inbox (
  source_id TEXT NOT NULL, event_id TEXT NOT NULL, payload_digest TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL, PRIMARY KEY(source_id,event_id)
) STRICT;
CREATE TABLE wake_intents (
  wake_event_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  workflow_run_id TEXT NOT NULL, wait_generation INTEGER NOT NULL CHECK(wait_generation > 0),
  state TEXT NOT NULL CHECK(state IN ('pending','resuming','acknowledged','parked')),
  next_attempt_at_ms INTEGER NOT NULL, UNIQUE(workflow_run_id,wait_generation,wake_event_id)
) STRICT;
CREATE TABLE release_files (
  release_digest TEXT NOT NULL, tool_id TEXT NOT NULL, entrypoint TEXT NOT NULL,
  digest TEXT NOT NULL, bytes INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(release_digest, tool_id)
) STRICT;
CREATE INDEX release_files_digest ON release_files(digest);
CREATE TABLE schedule_fires (
  schedule_id TEXT NOT NULL, release_digest TEXT NOT NULL, scheduled_at_ms INTEGER NOT NULL,
  dispatch_id TEXT NOT NULL, PRIMARY KEY(schedule_id,release_digest,scheduled_at_ms)
) STRICT;

-- Brain-owned current authorization schema. Better Auth retains its own tables.
CREATE TABLE principals (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL CHECK(kind IN ('human','agent','workflow','runner','kiosk')),
  auth_subject_id TEXT NOT NULL, disabled_at_ms INTEGER,
  UNIQUE(organization_id,kind,auth_subject_id), UNIQUE(id,organization_id)
) STRICT;
-- A session credential (ADR 0032): minted for one running attempt and valid only while that attempt holds its fence.
CREATE TABLE machine_sessions (
  token_digest TEXT PRIMARY KEY, principal_id TEXT NOT NULL, organization_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER, created_at_ms INTEGER NOT NULL,
  attempt_id TEXT DEFAULT NULL, job_fence INTEGER DEFAULT NULL,
  FOREIGN KEY(principal_id,organization_id) REFERENCES principals(id,organization_id)
) STRICT;
CREATE INDEX machine_sessions_expiry ON machine_sessions(expires_at_ms);
CREATE INDEX machine_sessions_attempt ON machine_sessions(attempt_id);
-- The machine principal of a mission team member (ADR 0032): bound to one workspace and mission, acting for the mission owner.
CREATE TABLE agent_principals (
  principal_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL,
  member_id TEXT, acting_for TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(principal_id,organization_id) REFERENCES principals(id,organization_id),
  FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
) STRICT;
CREATE TABLE setup_intent (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), organization_id TEXT NOT NULL,
  email TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','ready'))
) STRICT;
CREATE TABLE organization_authorizations (
  organization_id TEXT NOT NULL REFERENCES organizations(id), principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('organization-admin','security-admin','tool-publisher')),
  granted_by TEXT NOT NULL, granted_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER,
  PRIMARY KEY(organization_id,principal_id,role),
  FOREIGN KEY(principal_id,organization_id) REFERENCES principals(id,organization_id)
) STRICT;
CREATE TABLE workspace_memberships (
  workspace_id TEXT NOT NULL, organization_id TEXT NOT NULL, principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('viewer','operator','workspace-lead','approver')),
  version INTEGER NOT NULL CHECK(version>0), granted_by TEXT NOT NULL,
  granted_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER,
  PRIMARY KEY(workspace_id,principal_id,role),
  FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id),
  FOREIGN KEY(principal_id,organization_id) REFERENCES principals(id,organization_id)
) STRICT;
CREATE INDEX memberships_active ON workspace_memberships(principal_id,workspace_id,revoked_at_ms);
CREATE TABLE delegated_grants (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, parent_id TEXT REFERENCES delegated_grants(id),
  root_actor_id TEXT NOT NULL, run_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),
  policy_digest TEXT NOT NULL, depth INTEGER NOT NULL CHECK(depth BETWEEN 0 AND 2),
  expires_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER,
  FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id),
  FOREIGN KEY(principal_id,organization_id) REFERENCES principals(id,organization_id)
) STRICT;
CREATE TABLE revocation_records (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  generation INTEGER NOT NULL CHECK(generation>0),
  subject_type TEXT NOT NULL CHECK(subject_type IN ('principal','grant','runner','session','policy','approval')),
  subject_id TEXT NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL, UNIQUE(organization_id,generation)
) STRICT;
CREATE TABLE enrollment_tokens (
  token_digest TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  group_id TEXT NOT NULL, expires_at_ms INTEGER NOT NULL,
  created_by TEXT NOT NULL, consumed_at_ms INTEGER, runner_id TEXT REFERENCES runners(id)
) STRICT;
CREATE TABLE runner_identity_credentials (
  runner_id TEXT PRIMARY KEY REFERENCES runners(id), public_key_spki_pem TEXT NOT NULL,
  credential_digest TEXT NOT NULL UNIQUE, expires_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER
) STRICT;
CREATE TABLE runner_challenges (
  id TEXT PRIMARY KEY, runner_id TEXT NOT NULL REFERENCES runners(id),
  nonce TEXT NOT NULL UNIQUE, expires_at_ms INTEGER NOT NULL, consumed_at_ms INTEGER
) STRICT;
CREATE TABLE runner_sessions (
  token_digest TEXT PRIMARY KEY, runner_id TEXT NOT NULL REFERENCES runners(id),
  runner_epoch INTEGER NOT NULL CHECK(runner_epoch>0), expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER, created_at_ms INTEGER NOT NULL, UNIQUE(runner_id,runner_epoch)
) STRICT;
CREATE TABLE step_up_challenges (
  id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, auth_session_digest TEXT NOT NULL,
  approval_id TEXT NOT NULL REFERENCES approval_requests(id), subject_digest TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  verified_at_ms INTEGER, factor_digest TEXT, auth_generation INTEGER NOT NULL
) STRICT;
CREATE TABLE step_up_evidence (
  id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL UNIQUE REFERENCES step_up_challenges(id),
  actor_id TEXT NOT NULL, auth_session_digest TEXT NOT NULL, subject_digest TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('session','totp')), expires_at_ms INTEGER NOT NULL,
  decision_id TEXT UNIQUE REFERENCES approval_decisions(id), revoked_at_ms INTEGER,
  auth_session_id TEXT NOT NULL, auth_user_id TEXT NOT NULL, factor_digest TEXT, auth_generation INTEGER NOT NULL
) STRICT;
-- A fresh authentication for one administrative command (ADR 0047), bound to the person's session, the command, its workspace and the digest of its exact
-- payload. Verifying it makes it evidence; the one command it names spends it.
CREATE TABLE command_step_ups (
  id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, auth_session_digest TEXT NOT NULL,
  command_type TEXT NOT NULL, workspace_id TEXT NOT NULL, subject_digest TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  verified_at_ms INTEGER, method TEXT CHECK(method IS NULL OR method IN ('session','totp')),
  auth_session_id TEXT NOT NULL, auth_user_id TEXT NOT NULL, factor_digest TEXT, auth_generation INTEGER NOT NULL, consumed_at_ms INTEGER, revoked_at_ms INTEGER
) STRICT;
CREATE TABLE permit_credentials (
  permit_id TEXT PRIMARY KEY REFERENCES effect_permits(id), token_digest TEXT NOT NULL UNIQUE,
  token_nonce TEXT NOT NULL, key_id TEXT NOT NULL,
  audience TEXT NOT NULL, request_digest TEXT NOT NULL, revoked_at_ms INTEGER
) STRICT;
CREATE TABLE effect_attempt_observations (
  invocation_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0),
  permit_id TEXT NOT NULL REFERENCES effect_permits(id),
  phase TEXT NOT NULL CHECK(phase IN ('started','applied','absent','conflicting','unknown')),
  evidence_digest TEXT NOT NULL, observed_at_ms INTEGER NOT NULL,
  PRIMARY KEY(invocation_id,sequence)
) STRICT;
CREATE TABLE reconciliation_requests (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
  command_id TEXT NOT NULL UNIQUE, expected_version INTEGER NOT NULL CHECK(expected_version>0),
  state TEXT NOT NULL CHECK(state IN ('pending','observing','resolved','blocked')),
  outcome TEXT CHECK(outcome IN ('applied','absent','conflicting','unknown')),
  evidence_digest TEXT, next_observation_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX one_open_reconciliation ON reconciliation_requests(job_id)
WHERE state IN ('pending','observing');
CREATE TABLE artifact_uploads (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  initiated_by TEXT NOT NULL,
  attempt_id TEXT REFERENCES job_attempts(id), expected_digest TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL CHECK(expected_bytes>=0),
  received_bytes INTEGER NOT NULL DEFAULT 0 CHECK(received_bytes>=0 AND received_bytes<=expected_bytes),
  state TEXT NOT NULL CHECK(state IN ('open','verifying','complete','rejected','expired')),
  expires_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
) STRICT;
CREATE TABLE artifact_associations (
  artifact_id TEXT NOT NULL, organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  digest TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
  classification TEXT NOT NULL CHECK(classification IN ('public','internal','confidential','restricted')),
  verified_at_ms INTEGER NOT NULL,
  PRIMARY KEY(organization_id,workspace_id,artifact_id),
  FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
) STRICT;
CREATE INDEX artifact_association_digest ON artifact_associations(digest);
CREATE TABLE audit_checkpoints (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  through_cursor INTEGER NOT NULL CHECK(through_cursor>=0), chain_digest TEXT NOT NULL,
  signature TEXT NOT NULL, key_id TEXT NOT NULL, off_host_receipt_digest TEXT,
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE notification_subscriptions (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  principal_id TEXT NOT NULL, endpoint_digest TEXT NOT NULL,
  encrypted_endpoint_json TEXT NOT NULL, revoked_at_ms INTEGER,
  FOREIGN KEY(principal_id,organization_id) REFERENCES principals(id,organization_id)
) STRICT;
CREATE TABLE notification_deliveries (
  event_id TEXT NOT NULL REFERENCES events(event_id),
  subscription_id TEXT NOT NULL REFERENCES notification_subscriptions(id),
  state TEXT NOT NULL CHECK(state IN ('pending','delivered','failed','revoked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0), next_attempt_at_ms INTEGER NOT NULL,
  PRIMARY KEY(event_id,subscription_id)
) STRICT;

-- Unified Execution Stream: one projected read model over control.events,
-- workspace.events and attempt_events. Derived data — the three source logs
-- remain the authority and the projection is rebuildable from watermarks.
-- Large payloads stay in attempt_events/CAS; rows carry bounded summaries and
-- pointer references only.
CREATE TABLE execution_stream (
  stream_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL, workspace_id TEXT,
  source TEXT NOT NULL CHECK(source IN ('control','workspace','attempt')),
  emitter TEXT NOT NULL CHECK(emitter IN ('agent','tool','runner','governor','evaluator','connector','system')),
  aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, aggregate_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT CHECK(severity IN ('debug','info','warning','error','critical')),
  occurred_at_ms INTEGER NOT NULL,
  ts_approximate INTEGER NOT NULL DEFAULT 0 CHECK(ts_approximate IN (0,1)),
  run_id TEXT, job_id TEXT, attempt_id TEXT, session_id TEXT, work_item_id TEXT,
  invocation_id TEXT, proposal_id TEXT,
  summary_json TEXT NOT NULL CHECK(json_valid(summary_json) AND length(summary_json) <= 4096),
  payload_ref_json TEXT NOT NULL CHECK(json_valid(payload_ref_json))
) STRICT;
CREATE INDEX stream_scope ON execution_stream(organization_id, workspace_id, stream_seq);
CREATE INDEX stream_corr ON execution_stream(session_id, stream_seq);
CREATE INDEX stream_job ON execution_stream(job_id, stream_seq);
-- Standalone-content FTS (document_fts precedent): execution_stream has no
-- 'text' column, so an external-content FTS5 table could not map columns.
CREATE VIRTUAL TABLE execution_stream_fts USING fts5(text, stream_seq UNINDEXED, tokenize='unicode61');
CREATE TABLE stream_watermarks (
  source TEXT NOT NULL, key TEXT NOT NULL, cursor INTEGER NOT NULL,
  PRIMARY KEY(source,key)
) STRICT;
-- Job payload sidecar, attempt event journal and accepted outputs: control-plane
-- job state that outlives any single handler call.
CREATE TABLE job_payloads (job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL) STRICT;
CREATE TABLE attempt_events (attempt_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(attempt_id, seq)) STRICT;
CREATE TABLE job_outputs (job_id TEXT PRIMARY KEY, output_json TEXT NOT NULL) STRICT;
-- Tool calls of agent attempts, written once when their events are first stored, so the tool catalog counts calls without scanning event history.
CREATE TABLE tool_calls (
  attempt_id TEXT NOT NULL, proposal_id TEXT NOT NULL, organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL, tool_id TEXT NOT NULL,
  proposed_at TEXT NOT NULL DEFAULT '', failed INTEGER NOT NULL DEFAULT 0 CHECK(failed IN (0,1)), finished_at TEXT,
  failure_message TEXT DEFAULT NULL,
  PRIMARY KEY(attempt_id, proposal_id)
) STRICT;
CREATE INDEX tool_calls_tool ON tool_calls(organization_id, workspace_id, tool_id);
-- Parked work gets one automatic retry per activated release: a release changes what agents may do and use, so earlier failures say little about the next attempt. This table is what bounds it.
CREATE TABLE parked_auto_retries (
  work_item_id TEXT NOT NULL, release_digest TEXT NOT NULL, organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, retried_at_ms INTEGER NOT NULL,
  PRIMARY KEY(work_item_id, release_digest)
) STRICT;
-- The workspace's default way of working (ADR 0022): a workflow and the tools its tasks must observe; the planner may override per task.
CREATE TABLE workspace_way_of_working (
  workspace_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
  required_tools_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(required_tools_json)), updated_by TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;
-- Model routes per workspace (ADR 0052, builds on ADR 0023): an ordered list of hosted models for the evaluator, the second attempt and the advisory judge.
-- A route names its key by reference (`key_ref`), never the key: the caller resolves it from its own environment. Prices are micro-USD per million tokens.
CREATE TABLE workspace_model_routes (
  workspace_id TEXT NOT NULL, route_id TEXT NOT NULL, organization_id TEXT NOT NULL, position INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), vendor TEXT NOT NULL, key_ref TEXT NOT NULL, model TEXT NOT NULL, base_url TEXT NOT NULL,
  cost_tier TEXT NOT NULL CHECK(cost_tier IN ('low','standard','premium')),
  input_micro_usd_per_mtok INTEGER NOT NULL CHECK(input_micro_usd_per_mtok >= 1), output_micro_usd_per_mtok INTEGER NOT NULL CHECK(output_micro_usd_per_mtok >= 1),
  updated_by TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, route_id)
) STRICT;
-- A route whose account ran out of quota or rate is left out of every offer until the provider's retry-after has passed: never a blind retry on the same route.
CREATE TABLE model_route_cooldowns (
  workspace_id TEXT NOT NULL, route_id TEXT NOT NULL, until_ms INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(workspace_id, route_id)
) STRICT;
-- Which route served each attempt, and the routes it moved past on a quota failure (`outcome` served | quota | failed), in the order they were tried.
CREATE TABLE attempt_model_routes (
  attempt_id TEXT NOT NULL, position INTEGER NOT NULL, route_id TEXT NOT NULL, workspace_id TEXT NOT NULL, model TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('served','quota','failed')), recorded_at_ms INTEGER NOT NULL,
  PRIMARY KEY(attempt_id, position)
) STRICT;
-- Latest result of each periodic check (model endpoint, hosted model per workspace, disk): Health reads these rows; a check that goes bad is also alerted once.
CREATE TABLE service_probes (
  id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('healthy','degraded','unavailable','disabled')), detail TEXT NOT NULL DEFAULT '',
  checked_at_ms INTEGER NOT NULL, alerted_status TEXT NOT NULL DEFAULT 'healthy'
) STRICT;
-- Platform dispatch state: draining stops new attempts from being offered (deploys that do not interrupt work); running attempts finish.
CREATE TABLE platform_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), draining INTEGER NOT NULL DEFAULT 0 CHECK(draining IN (0,1)), changed_by TEXT NOT NULL DEFAULT '', changed_at_ms INTEGER NOT NULL DEFAULT 0
) STRICT;
-- Test runs of one tool: a one-step workflow (tool-test:<id>) a person started to try a tool with their own input. Tagged apart from real calls, which tool_calls counts.
CREATE TABLE tool_test_runs (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, tool_id TEXT NOT NULL,
  release_digest TEXT NOT NULL, run_id TEXT NOT NULL, input_json TEXT NOT NULL DEFAULT '{}',
  requested_by TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'try' CHECK(kind IN ('try','selftest'))
) STRICT;
CREATE INDEX tool_test_runs_tool ON tool_test_runs(organization_id, workspace_id, tool_id, created_at_ms);
CREATE INDEX tool_test_runs_run ON tool_test_runs(run_id);
-- Local scoped memory assets behind the MemoryStore gateway port.
CREATE TABLE memory_assets (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, workspace_id TEXT,
 source_id TEXT NOT NULL, body TEXT NOT NULL, acl_generation INTEGER NOT NULL,
 source_type TEXT NOT NULL DEFAULT 'wiki' CHECK(source_type IN ('chat','skill','wiki','codegraph','knowledge')),
 status TEXT NOT NULL DEFAULT 'unverified' CHECK(status IN ('reviewed','unverified')),
 title TEXT NOT NULL DEFAULT '', self_reviewed INTEGER NOT NULL DEFAULT 0 CHECK(self_reviewed IN (0,1)),
 revoked INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX memory_assets_source ON memory_assets(organization_id, COALESCE(workspace_id,''), source_id) WHERE revoked=0;
CREATE VIRTUAL TABLE memory_fts USING fts5(asset_id UNINDEXED,title,body,tokenize='unicode61 remove_diacritics 2');
-- Read-only share links for one result (ADR 0013). Only the keyed digest of the bearer token is stored.
CREATE TABLE result_shares (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), workspace_id TEXT NOT NULL,
  version_id TEXT NOT NULL, mission_id TEXT NOT NULL, token_digest TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER, revoked_by TEXT, views INTEGER NOT NULL DEFAULT 0,
  last_viewed_at_ms INTEGER, created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX result_shares_version ON result_shares(organization_id, workspace_id, version_id, created_at_ms);
-- Per-person notification channels (ADR 0011). A missing row means the default: push on, webhook off, digest off. In-app is always on.
CREATE TABLE notification_preferences (
  organization_id TEXT NOT NULL REFERENCES organizations(id), principal_id TEXT NOT NULL,
  push INTEGER NOT NULL DEFAULT 1 CHECK(push IN (0,1)), webhook INTEGER NOT NULL DEFAULT 0 CHECK(webhook IN (0,1)),
  digest INTEGER NOT NULL DEFAULT 0 CHECK(digest IN (0,1)), digest_last_ms INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL,
  email INTEGER NOT NULL DEFAULT 0 CHECK(email IN (0,1)),
  PRIMARY KEY(organization_id, principal_id)
) STRICT;
-- One row per email attempt (ADR 0011 amendment): sent or failed with a plain reason, never the address or the message.
CREATE TABLE email_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, principal_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('sent','failed')), reason TEXT NOT NULL DEFAULT '', at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX email_deliveries_person ON email_deliveries(organization_id, principal_id, at_ms);

-- Effect tools and permits per call (ADR 0024). The owner's allow-list of what an effect tool may touch in this workspace, and how long a
-- person has to answer an approval; an empty list means the tool refuses every call. egress_hosts_json: the hosts a sandboxed
-- tool of this workspace may reach through the egress proxy (ADR 0037); empty means no network.
CREATE TABLE workspace_effect_policy (
  workspace_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
  containers_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(containers_json)),
  services_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(services_json)),
  approval_minutes INTEGER NOT NULL DEFAULT 30 CHECK(approval_minutes BETWEEN 1 AND 1440),
  egress_hosts_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(egress_hosts_json)),
  updated_by TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;
-- How many jobs of one workspace may wait for a runner before a person's new work is refused (ADR 0040). No row means the default.
CREATE TABLE workspace_queue_limit (
  workspace_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
  max_queued INTEGER NOT NULL CHECK(max_queued BETWEEN 1 AND 10000),
  updated_by TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;
-- A runner group set aside for some workspaces (ADR 0024). A group with a row takes jobs of its listed workspaces only; host tools
-- (host.*) run only on a group marked host_tools. A group with no row is open to every workspace and has no host tools.
CREATE TABLE runner_groups (
  group_id TEXT NOT NULL, organization_id TEXT NOT NULL,
  host_tools INTEGER NOT NULL DEFAULT 0 CHECK(host_tools IN (0,1)),
  workspaces_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(workspaces_json)),
  updated_by TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(organization_id, group_id)
) STRICT;
-- One row per effect call an agent proposed: the exact call its approval names, so a permit is bound to it and to nothing else.
-- ADR 0028: a proposal ends the proposing attempt. The call is held as an act job (blocked until the approval is decided) and the proposing
-- job waits, blocked, until every call it proposed is settled. outcome: applied, absent, unknown, declined, expired, revoked, cancelled.
CREATE TABLE effect_calls (
  attempt_id TEXT NOT NULL REFERENCES job_attempts(id), proposal_id TEXT NOT NULL,
  organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, approval_id TEXT NOT NULL REFERENCES approval_requests(id),
  tool_id TEXT NOT NULL, input_digest TEXT NOT NULL, resource_key TEXT NOT NULL DEFAULT '', created_at_ms INTEGER NOT NULL,
  parent_job_id TEXT NOT NULL DEFAULT '', act_job_id TEXT NOT NULL DEFAULT '', outcome TEXT DEFAULT NULL, settled_at_ms INTEGER DEFAULT NULL,
  PRIMARY KEY(attempt_id, proposal_id)
) STRICT;
CREATE UNIQUE INDEX effect_calls_approval ON effect_calls(approval_id);
CREATE INDEX effect_calls_parent ON effect_calls(parent_job_id, tool_id, input_digest);
CREATE INDEX effect_calls_act ON effect_calls(act_job_id);
CREATE INDEX effect_calls_open ON effect_calls(created_at_ms) WHERE settled_at_ms IS NULL;
-- Inbound chat webhook requests already handled (ADR 0024): a retried signed request is acknowledged, never repeated.
CREATE TABLE inbound_hook_events (
  remote_event_id TEXT PRIMARY KEY, received_at_ms INTEGER NOT NULL
) STRICT;
-- Single sign-on (ADR 0026): one OpenID Connect provider per Governor. The secret is only a reference, never a value.
CREATE TABLE identity_provider (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), organization_id TEXT NOT NULL REFERENCES organizations(id),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), issuer TEXT NOT NULL, client_id TEXT NOT NULL, secret_ref TEXT NOT NULL,
  auto_provision INTEGER NOT NULL CHECK(auto_provision IN (0,1)),
  default_role TEXT CHECK(default_role IN ('viewer','operator','workspace-lead','approver')),
  group_claim TEXT NOT NULL, group_roles_json TEXT NOT NULL CHECK(json_valid(group_roles_json)),
  workspace_ids_json TEXT NOT NULL CHECK(json_valid(workspace_ids_json)), allowed_domains_json TEXT NOT NULL CHECK(json_valid(allowed_domains_json)),
  updated_by TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE identity_provisionings (
  user_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), email TEXT NOT NULL,
  roles_json TEXT NOT NULL CHECK(json_valid(roles_json)), workspace_ids_json TEXT NOT NULL CHECK(json_valid(workspace_ids_json)), provisioned_at_ms INTEGER NOT NULL
) STRICT;
