# Native identity, step-up and client implementation

The full objective remains **finalize all the implementation**. This document records implemented identity behavior and precise limits; it does not certify the remaining platform.

## Ownership and entry points

| File/module | Responsibility |
|---|---|
| `modules/identity/options.ts` | Exact Better Auth plugin/options contract: organization, bearer sessions and TOTP; no public organization creation/deletion |
| `modules/identity/auth.ts` | Public vendor API adapter, current session/membership checks, protected factor fingerprints and recovery handling |
| `modules/identity/bootstrap.ts` | One-use local setup authority, durable pending setup, native account/organization and explicit owner roles |
| `modules/identity/security.ts` | Current strong-human-session assertions, separate from transport claims |
| `modules/governance/step-up.ts` | Exact subject/session/factor/generation binding, bounded attempts, native TOTP verification and one-use evidence |
| `application/authz.ts` | Current native-human or scoped machine actor resolution and Brain roles/memberships |
| `http/app.ts`, `http/body.ts` | Shared HTTP entry points, origin protection, strict bounded JSON and body admission |
| `apps/web/src/ui/components/Authentication.tsx` | NewUI sign-in/setup, authenticator enrollment and account recovery |
| `apps/cli/src/{client,credentials,prompt}.ts` | Thin native credential client, masked prompts and private origin-scoped session files |

These are internal Governor modules, not services. Better Auth owns credential/factor storage; Brain owns authorization decisions and verification evidence. The former parallel human `brain_sessions` and plaintext `totp_secrets` authorities have been removed. A test-only RFC 6238 generator remains in `tests/support/totp.ts` as an independent oracle; production verification never calls it.

## Current contracts

`BootstrapRequest`, `BootstrapResponse`, `SetupStatus` and `IdentityView` are canonical JSON Schema/generated DTOs. `/v1/setup/status` discloses initialization flags only. `/v1/identity` returns the currently verified actor, display name, authorized workspace choices and authenticator/recovery flags. It never returns a vendor session ID, factor digest or secret. `organization.bootstrapped` is a registered typed event.

`POST /v1/setup` requires `Authorization: Setup <credential>`. Governor creates the random credential in owner-only `setup.token` in its data directory. Read it on the trusted host, enter it in the setup UI, or let the CLI read it from an explicit private file. It is never a default password or an unauthenticated arbitrary-user session minting endpoint. Exact trusted origin checks also apply. Native account creation and organization ownership are followed by one short Brain-authority transaction. A persisted pending intent binds retries to the original email/organization; a retry authenticates the account rather than duplicating it. Once any organization exists, or a restore marker exists, setup is closed.

Human cookies and CLI bearer sessions are verified using Better Auth with cookie caching disabled. Brain binds evidence to the actual opaque vendor **session ID**, not just a user ID, and rechecks organization membership, disabled-principal state, current Brain roles and revocation generation. Explicit invalid bearer credentials cannot fall back to an ambient cookie. Workspace access additionally requires a matching active Brain membership. Agent/workflow/kiosk credentials use separate `machine_sessions` lookup digests and retain their actor kinds; they cannot become humans or satisfy step-up. All runner routes reject browser cookies.

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

The Playwright authentication fixture owns an isolated Governor and declares 390/768/1440 light/dark projects. No snapshot is silently regenerated. This environment cannot launch Chromium successfully or bind localhost, and cannot access the Docker socket, so browser/kernel/live integration acceptance is **unverified**, not passed. Required remaining identity work includes complete native organization/member administration and invitation/account-management UX, full identity/recovery browser coverage, and current approver authority checks at permit time. The full evidence/Mastra/runner/UI/memory/restore/performance scope in doc 23 remains active.
