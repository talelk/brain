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
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  UNIQUE(organization_id, slug), UNIQUE(id, organization_id)
) STRICT;
CREATE TABLE config_releases (
  digest TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  source_revision TEXT NOT NULL, compiler_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)), created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE active_config (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
  release_digest TEXT NOT NULL REFERENCES config_releases(digest),
  version INTEGER NOT NULL CHECK(version > 0)
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
  UNIQUE(id, organization_id)
) STRICT;
CREATE TABLE runner_capabilities (
  runner_id TEXT NOT NULL REFERENCES runners(id), capability TEXT NOT NULL,
  verified INTEGER NOT NULL CHECK(verified IN (0,1)), source TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY(runner_id, capability), CHECK(expires_at_ms > observed_at_ms)
) STRICT;
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  execution_key TEXT NOT NULL, workflow_run_id TEXT NOT NULL, step_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','offered','running','verifying','succeeded','partial','failed','cancelled','blocked','outcome_unknown')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0), config_digest TEXT NOT NULL REFERENCES config_releases(digest),
  placement_json TEXT NOT NULL CHECK(json_valid(placement_json)), execution_digest TEXT NOT NULL,
  effect_class TEXT NOT NULL CHECK(effect_class IN ('read','write','privileged')),
  queue_reason TEXT, priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 3),
  created_at_ms INTEGER NOT NULL, ready_at_ms INTEGER NOT NULL, deadline_ms INTEGER NOT NULL,
  attempt_counter INTEGER NOT NULL DEFAULT 0 CHECK(attempt_counter >= 0),
  job_fence INTEGER NOT NULL DEFAULT 0 CHECK(job_fence >= 0),
  UNIQUE(organization_id, execution_key),
  FOREIGN KEY(workspace_id, organization_id) REFERENCES workspaces(id, organization_id)
) STRICT;
CREATE INDEX jobs_ready ON jobs(state, ready_at_ms, priority, created_at_ms, id);
CREATE INDEX jobs_workspace ON jobs(workspace_id, created_at_ms, id);
CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
  runner_id TEXT NOT NULL REFERENCES runners(id), runner_epoch INTEGER NOT NULL CHECK(runner_epoch > 0),
  attempt_no INTEGER NOT NULL CHECK(attempt_no > 0), lease_id TEXT NOT NULL UNIQUE,
  job_fence INTEGER NOT NULL CHECK(job_fence > 0),
  state TEXT NOT NULL CHECK(state IN ('offered','running','uploading','cancelling','verifying','succeeded','partial','failed','cancelled','declined','expired','outcome_unknown')),
  offer_expires_at_ms INTEGER NOT NULL, lease_expires_at_ms INTEGER NOT NULL,
  last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_event_seq >= 0),
  receipt_digest TEXT, cleanup_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_confirmed IN (0,1)),
  UNIQUE(job_id, attempt_no), UNIQUE(job_id, job_fence)
) STRICT;
CREATE UNIQUE INDEX one_active_attempt ON job_attempts(job_id)
WHERE state IN ('offered','running','uploading','cancelling','verifying','outcome_unknown');
CREATE INDEX attempts_expiry ON job_attempts(state, lease_expires_at_ms);
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
CREATE TABLE machine_sessions (
  token_digest TEXT PRIMARY KEY, principal_id TEXT NOT NULL, organization_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER, created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(principal_id,organization_id) REFERENCES principals(id,organization_id)
) STRICT;
CREATE INDEX machine_sessions_expiry ON machine_sessions(expires_at_ms);
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
