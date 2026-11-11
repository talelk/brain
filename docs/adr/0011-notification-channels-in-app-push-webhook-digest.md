# 11. Notification channels: in-app and web push by default, webhook behind server configuration, a daily digest, no email

Date: 2026-11-11
Status: Accepted (issue #53)

**Verified first.** The research claim that no email or Slack delivery exists is true. A search of `apps/`, `packages/`, `scripts/` and `tests/` for smtp, nodemailer, slack and webhook finds only an unrelated UI string and a demo seed file. The only outbound channels were the in-app inbox (`attention_notifications`) and Web Push (RFC 8291/8292 on `node:crypto`, `operations/push.ts`).

**Channels.**
- In-app is the record and is always on. It cannot be switched off.
- Web push keeps today's behaviour by default (on for anyone who subscribed a browser).
- Webhook is off by default and only exists when the server is configured with `BRAIN_NOTIFY_WEBHOOK_URL` (https, or http on localhost). The destination is a server setting, never a per-user URL, so a person cannot make the Governor call an arbitrary address (no SSRF) and no secret is entered in a form. Optional `BRAIN_NOTIFY_WEBHOOK_SECRET` signs the body (`x-brain-signature: sha256=<hmac>`). The body is link-only: `{type, kind, text, link, count?}` where `text` is generic ("Brain: something needs you. Open <link>"), so Slack-compatible incoming webhooks work and nothing a person typed, no title, no token and no secret leaves the server. When unconfigured, delivery is a no-op and the preference is shown as unavailable.
- Email is **not built**. An SMTP client would be a new dependency and a credential to store, and the dependency baseline is closed. A webhook to any mail relay covers the need; revisit if an SMTP integration is ever configured through Integrations.

**Preferences.** One row per person (`notification_preferences`, control.db): push on/off, webhook on/off, digest on/off. Missing row means today's behaviour. They are read and written through `GET/POST /v1/notification-preferences` for the signed-in person only.

**Digest.** A person who turns the digest on stops receiving result-ready items immediately on their channels; the in-app inbox still shows them at once. Once a day, one message ("N results are ready", a link to Today) goes out on their enabled channels if anything non-urgent arrived since the last one. Only non-urgent items batch: result-ready is the sole non-blocking kind (ADR 0005). Nothing that needs a decision is ever held.

**Approvals.** Approval requests bypass the 15-minute per-mission throttle and the digest, exactly as before. A message carries a link only; following it lands on the existing sign-in and step-up after which the decision is made, so no approval happens from a message. A person who switched a channel off is not messaged on it, including for approvals; the in-app queue still shows them.
