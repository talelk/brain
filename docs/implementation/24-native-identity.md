# Native identity, step-up and client implementation

The full objective remains **finalize all the implementation**. This document records implemented identity behavior and precise limits; it does not certify the remaining platform.

## Ownership and entry points

| File/module | Responsibility |
|---|---|
| `modules/identity/options.ts` | Exact Better Auth 1.7.14 plugin/options contract: organization, bearer, TOTP, admin and passkeys; invite-only sign-up and existing-user-only OIDC provisioning |
| `modules/identity/auth.ts` | Public vendor API adapter, current session/membership checks, protected factor fingerprints, recovery and accepted-invitation projection |
| `modules/identity/administration.ts` | Narrow typed vendor user/session/invitation operations and vendor-role synchronization |
| `modules/identity/bootstrap.ts` | One-use local setup authority, durable pending setup, native account/organization and explicit owner roles |
| `modules/identity/security.ts` | Current strong-human-session assertions, separate from transport claims |
| `modules/governance/step-up.ts` | Exact subject/session/factor/generation binding, bounded attempts, native TOTP verification and one-use evidence |
| `application/authz.ts` | Current native-human or scoped machine actor resolution and Brain roles/memberships |
| `application/organization-admin.ts` | Tenant-safe organization commands/queries, idempotent lifecycle operations, principal/user mapping and token-free session DTOs |
| `http/app.ts`, `http/body.ts` | Shared HTTP entry points, privileged vendor-route denial, origin protection, strict bounded JSON and body admission |
| `apps/web/src/ui/components/Authentication.tsx` | NewUI sign-in/setup, invited sign-up/verification/acceptance, passkey sign-in and authenticator recovery |
| `apps/web/src/ui/components/OrganizationAdmin.tsx` | Native People, user detail, Invitations, Access and Authentication Policy administration |
| `apps/cli/src/{client,credentials,prompt}.ts` | Thin native credential client, masked prompts and private origin-scoped session files |

These are internal Governor modules, not services. Better Auth owns credential/factor storage; Brain owns authorization decisions and verification evidence. The former parallel human `brain_sessions` and plaintext `totp_secrets` authorities have been removed. A test-only RFC 6238 generator remains in `tests/support/totp.ts` as an independent oracle; production verification never calls it.

## Current contracts

`BootstrapRequest`, `BootstrapResponse`, `SetupStatus` and `IdentityView` are canonical JSON Schema/generated DTOs. `/v1/setup/status` discloses initialization flags only. `/v1/identity` returns the currently verified actor, display name, authorized workspace choices and authenticator/recovery flags. It never returns a vendor session ID, factor digest or secret. `organization.bootstrapped` is a registered typed event.

`POST /v1/setup` requires `Authorization: Setup <credential>`. Governor creates the random credential in owner-only `setup.token` in its data directory. Read it on the trusted host, enter it in the setup UI, or let the CLI read it from an explicit private file. It is never a default password or an unauthenticated arbitrary-user session minting endpoint. Exact trusted origin checks also apply. Native account creation and organization ownership are followed by one short Brain-authority transaction. A persisted pending intent binds retries to the original email/organization; a retry authenticates the account rather than duplicating it. Once any organization exists, or a restore marker exists, setup is closed.

Human cookies and CLI bearer sessions are verified using Better Auth with cookie caching disabled. Brain binds evidence to the actual opaque vendor **session ID**, not just a user ID, and rechecks organization membership, disabled-principal state, current Brain roles and revocation generation. Explicit invalid bearer credentials cannot fall back to an ambient cookie. Workspace access additionally requires a matching active Brain membership. Agent/workflow/kiosk credentials use separate `machine_sessions` lookup digests and retain their actor kinds; they cannot become humans or satisfy step-up. All runner routes reject browser cookies.

## Organization administration, invitations and passkeys

The `OrganizationAdminCommand` family covers invitation create/cancel/retry, organization-role grant/revoke, member suspend/reactivate and current-organization session revocation. Typed queries expose directory, member detail, invitations, redacted security events and effective non-secret authentication policy. Mutations require identity scopes, a reason, idempotency and the current organization authorization generation. Callers can grant only roles they hold; last-admin removal and self-suspension are refused. Workspace grants require an active current-organization principal and matching Better Auth membership; arbitrary principal creation is closed.

Better Auth's global admin role is only an internal vendor capability. Browser access to `/api/auth/admin/*` and privileged organization mutation routes is denied. Global impersonation, hard deletion, administrator-set passwords and cross-tenant listing are not exposed. Brain principal IDs and Better Auth user IDs are mapped through `auth_subject_id`, so shared users retain tenant isolation. Suspending a member disables only the current Brain organization and revokes only sessions associated with it.

Password sign-up requires an active invitation; unknown OIDC users cannot implicitly provision. Invitations use the durable `auth_email_outbox`, with pending/failed/cancelled/delivered states and retry intents, not an assertion that SMTP succeeded. Acceptance requires a verified email and an explicit action. The invitation page checks the credential session directly until acceptance projects the Brain principal. Pending vendor intents support safe same-command retry without awaiting a network call inside a SQLite transaction.

Passkeys use the pinned `@better-auth/passkey` 1.7.14 plugin and official Solid client. Loopback uses the valid `localhost` relying-party domain. Users can register, rename, delete and sign in with passkeys; passkeys do not replace TOTP-bound effect-approval evidence. Self-session APIs use session IDs and never return session tokens to browser JavaScript. Rate limits use the generated SQLite `rateLimit` table and explicitly configured trusted proxies only. Redacted `auth_security_events` retain path/user/organization/timestamp only.

## Strong verification and recovery

The logged-in-user TOTP endpoint is verified against Better Auth **1.7.14**'s installed implementation and real tests. `verifyTOTP` returns `{token,user}` in this cohort, not the `{status:true}` shape suggested by some documentation examples. During initial enrollment, the plugin rotates the cookie/session but may return the previous token in its JSON body. Clients therefore consume the actual newly issued cookie or bearer plugin `set-auth-token` header. `trustDevice` is always false for the selected flows.

Challenges bind a human, session digest, exact approval subject, factor fingerprint and authorization generation. Each expires in at most five minutes, allows at most five verification attempts and is admitted under a bounded pending-challenge limit. Verification reserves an attempt before awaiting the vendor API, then checks current authority again before a conditional transaction creates one evidence record. Concurrent success cannot produce two proofs. Session revocation or factor/membership changes during verification fail closed. Evidence is private, expires after five minutes, and can be consumed by one matching decision idempotently.

Recovery-code sign-in restores account access but blocks the existing authenticator from issuing effect-approval evidence. Brain records only the protected factor fingerprint, not the backup code. Web requires password-confirmed authenticator replacement and fresh enrollment/code verification before approval capability returns. Ordinary account recovery is never a human action approval.

## Fresh schema and restart

`apps/governor/schema/auth.sql` is generated by the pinned vendor's public schema-generation API against an empty in-memory database:

```sh
rtk proxy pnpm --filter @brain/governor auth:schema
rtk proxy pnpm --filter @brain/governor auth:schema --check
```

Only initial current-format SQL is generated/applied. Existing differing schemas are preserved and refused; no historical conversion is performed. The generator includes the vendor's indexes and foreign keys. Brain's separate auth metadata/recovery records bind the selected current format. Private authority keys survive normal restarts. Restore revokes both native sessions and machine credentials and leaves workspace execution suspended, as described in doc 10.

## Web and CLI

Web uses NewUI `AuthLayout`, `AuthCard`, `Select`, `AppShell` and ordinary controls. Human credentials remain in HttpOnly cookies; browser persistence contains only an optional theme preference. Enrollment URI, recovery codes, passwords, OTPs, notes and protected responses remain in authorized memory only. Workspace changes, sign-out and access revocation clear protected views. Older responses cannot overwrite a new workspace. Approval review performs step-up before capturing/submitting the final decision and retains uncertain request identity across ordinary refresh/navigation in that workspace; it does not optimistically approve an effect.

One theme controller owns NewUI's `data-theme` attribute; `UIProvider` supplies the writing direction. Web typechecking is now part of FAST/build, rather than being excluded. The selected source-published NewUI cohort requires `DOM.Iterable` and does not support the extra `exactOptionalPropertyTypes` flag; Web uses `strict:true` with that flag disabled, while server/contracts/runner/CLI keep it enabled. This limitation is explicit, not a passing vendor strictness assertion. The current UI still needs the remaining five-area routes and screen oracles.

```sh
# Password is prompted without echo; for noninteractive use supply BRAIN_PASSWORD.
rtk proxy pnpm --filter @brain/cli start setup --local --email owner@example.test --name Brain --org my-team --setup-token-file /srv/brain/data/setup.token
rtk proxy pnpm --filter @brain/cli start login --email owner@example.test
rtk proxy pnpm --filter @brain/cli start logout
```

Noninteractive identity inputs are `BRAIN_EMAIL`, `BRAIN_PASSWORD`, `BRAIN_TOTP` and optionally `BRAIN_SETUP_TOKEN`. Keep them out of logs. CLI session records are owner-only, atomically written and bound to one Governor origin. Remote Governor access requires HTTPS. Sign-in/setup output reports authentication and organization only, never the session credential. `BRAIN_TOKEN` remains an explicit current native/machine bearer override, not another credential authority.

## Evidence and remaining work

Native HTTP tests cover actual signup/sign-in, cookie and bearer verification, membership/disablement, TOTP enrollment, session replacement, recovery/reset, bounded attempts, concurrent proof creation, revocation during vendor verification and exact decision replay. CLI tests use the real Governor handlers and shared commands. Recovery tests exercise native sessions as well as old approvals/leases. Request tests cover byte/depth/node limits, cancellation/admission, invalid UTF-8, duplicate keys and prototype-shaped JSON.

Focused HTTP suites now additionally cover organization/user administration, invitation delivery/cancel/retry, real verification links, role invariants, idempotency, two-tenant session isolation, token-free self-session revocation, persistent rate limiting and redacted security events (`tests/security/organization-admin.test.ts`, `tests/security/auth-rate-limit.test.ts`, `tests/security/identity.test.ts`). `tests/browser/identity-administration.spec.ts` exercises the complete invitation/access flow and real WebAuthn registration/sign-in with an emulated authenticator across all 390/768/1440 light/dark projects; all 12 focused scenarios passed. These results do not certify unrelated platform gates, external email delivery, live customer systems or independent release acceptance.
