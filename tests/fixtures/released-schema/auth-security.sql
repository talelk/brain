-- Brain-owned auth security tables, applied with the vendor-generated auth.sql.
-- The auth schema digest binds both files; regenerate auth.sql and edit this
-- file together, never one alone.
CREATE TABLE brain_auth_recovery (user_id TEXT PRIMARY KEY, factor_digest TEXT NOT NULL, recovered_at_ms INTEGER NOT NULL) STRICT;
CREATE TABLE brain_initial_password (user_id TEXT PRIMARY KEY, password_hash TEXT NOT NULL) STRICT;
CREATE TABLE auth_email_outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('verify-email','organization-invitation','password-reset')), email TEXT NOT NULL, url TEXT NOT NULL, organization_id TEXT, state TEXT NOT NULL CHECK(state IN ('pending','delivered','failed','cancelled')), attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT;
CREATE TABLE auth_security_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, user_id TEXT, auth_organization_id TEXT, occurred_at_ms INTEGER NOT NULL) STRICT;
CREATE TABLE auth_schema_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), digest TEXT NOT NULL) STRICT;
