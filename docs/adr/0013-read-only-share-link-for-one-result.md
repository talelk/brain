# 13. A result can be shared through a read-only, expiring, revocable link

Date: 2026-11-11
Status: Accepted (issue #60)

Stakeholders need to read one result without a workspace account. Nothing in the authorization model grants an external viewer anything, so this decision adds the smallest possible grant and writes it into `contracts/v1/authorization-matrix.json` (`specialEndpoints`: `share.create`, `share.list`, `share.revoke`, `share.view`) before code.

**Token.** 32 random bytes (base64url), shown once at creation. Only its keyed digest (`store.tokenDigest("result-share", token)`) is stored, in `control.db` (`result_shares`), so the public route can find the workspace without a session. The token is a bearer secret for one page; it is never accepted anywhere else, and no session, cookie or Authorization header is read on the public route.

**Scope.** One link names one output version that is final and verified. A later version of the same output is not exposed. Only readable text is shareable (`text/plain`, `text/markdown`, `text/csv`, `application/json`); a `confidential` or `restricted` artifact is refused (`POLICY_DENIED`). The page returns the output's name, "Version N", the verified mark, dates and the text (cut at 1 MB, and says so). It shows no mission, plan, team, run, evidence, cost or workspace data, and offers no action.

**Who and how long.** A person with `mission:write` creates it (agents and workflows cannot). It lasts 7 days by default, 1 hour to 30 days at most, up to 10 live links per result. The creator or a workspace admin can revoke it at once. Revoking twice is a no-op.

**Checked at view time, not creation time.** Not revoked, not expired, workspace active, the creator still has workspace membership, the version is still shareable. Otherwise 404 (unknown) or 410 (`expired` or `revoked`) with no detail. A link therefore never outlives its creator's access.

**Audit.** `share.created` and `share.revoked` are workspace events; each view increments a counter and last-viewed time on the link and writes a `share.viewed` event at most once per minute per link, so a hostile reader cannot flood the log. No visitor address or user agent is stored.

**Response hardening.** `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`, and the shared page renders the text through the safe Markdown renderer (never HTML).

Rejected: a signed stateless token (cannot be revoked or counted); a per-recipient account (the whole point is no account); sharing a whole mission (grants far more than asked).
