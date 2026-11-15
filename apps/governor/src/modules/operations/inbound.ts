import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ActionSubject } from "@brain/contracts";
import type { Store } from "../../application/store";
import { transitionState } from "../../domain/states";
import type { ChatProvider } from "../identity/index";
import { absoluteLink } from "./channels";

/**
 * The inbound chat webhook (ADR 0024): Slack slash commands or Teams/Slack automations reach Brain through ONE signed endpoint. It can
 * list what waits (`approvals`, `status`), deny a pending approval (`deny <id>`: it only takes authority away) and, for `approve <id>`,
 * answer with the link to that decision. `start <play>` starts a mission from a Play as the member the chat identity is linked to (ADR 0011
 * amendment): the work itself is started by the port the application gives, through the ordinary command funnel. It never approves: an approval needs a signed-in person and a fresh step-up, which a chat
 * message cannot give. Two signatures are accepted, both HMAC-SHA256 of the raw body with a timestamp inside a 5 minute window:
 * Brain's own (`x-brain-signature: sha256=<hex of "<timestamp>.<body>">`, `x-brain-timestamp`) and Slack's (`x-slack-signature: v0=...`).
 * A Teams outgoing webhook is accepted too, with its own token (`BRAIN_INBOUND_TEAMS_TOKEN`, see verifyTeamsSignature).
 */
export const INBOUND_WINDOW_MS = 5 * 60_000;

/** What `start` hands to the application: who spoke, which message it was, and the words after `start`. */
export interface ChatStartInput { readonly organizationId: string; readonly provider: ChatProvider; readonly chatUserId: string; readonly messageKey: string; readonly args: readonly string[] }
export interface ChatStartPort { start(input: ChatStartInput): Promise<string> }

export interface InboundReply { readonly status: number; readonly body: Record<string, unknown> }

const reply = (status: number, text: string): InboundReply => ({ status, body: { type: "message", response_type: "ephemeral", text } });

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Teams outgoing webhooks sign differently: `Authorization: HMAC <base64>`, the HMAC-SHA256 of the raw body keyed with the base64-DECODED
 * security token Teams showed when the webhook was created. There is no timestamp header, so the age comes from the activity's own
 * `timestamp` field, which is inside the signed bytes.
 */
export function verifyTeamsSignature(token: string, headers: Headers, rawBody: string, nowMs: number): string | undefined {
  const header = headers.get("authorization") ?? "";
  if (!/^HMAC /u.test(header)) return "the request is not signed";
  const key = Buffer.from(token, "base64");
  const expected = createHmac("sha256", key).update(Buffer.from(rawBody, "utf8")).digest("base64");
  if (!equal(header.slice(5).trim(), expected)) return "the signature does not match";
  let sentAt = Number.NaN;
  try { sentAt = Date.parse(String((JSON.parse(rawBody) as { timestamp?: unknown }).timestamp ?? "")); } catch { /* refused below */ }
  if (!Number.isFinite(sentAt) || Math.abs(nowMs - sentAt) > INBOUND_WINDOW_MS) return "the request is too old or has no timestamp";
  return undefined;
}

/** Checks the signature and the age of the request; returns the reason it was refused, or undefined. */
export function verifyInboundSignature(secret: string, headers: Headers, rawBody: string, nowMs: number): string | undefined {
  const slack = headers.get("x-slack-signature");
  const timestamp = Number(slack ? headers.get("x-slack-request-timestamp") : headers.get("x-brain-timestamp"));
  if (!Number.isFinite(timestamp) || Math.abs(nowMs - timestamp * 1000) > INBOUND_WINDOW_MS) return "the request is too old or has no timestamp";
  if (slack) return equal(slack, `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`) ? undefined : "the signature does not match";
  const brain = headers.get("x-brain-signature") ?? "";
  return equal(brain, `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`) ? undefined : "the signature does not match";
}

interface ParsedCommand { text: string; user: string; eventId: string; provider: ChatProvider; chatUserId: string }

/** Which chat product spoke follows from how the request was signed; the sender's stable id is what an administrator links. */
function parseCommand(headers: Headers, rawBody: string): ParsedCommand {
  const provider: ChatProvider = /^HMAC /u.test(headers.get("authorization") ?? "") ? "teams" : headers.get("x-slack-signature") ? "slack" : "brain";
  const type = headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(rawBody);
    return { text: (form.get("text") ?? "").trim(), user: form.get("user_name") ?? form.get("user_id") ?? "someone", eventId: form.get("trigger_id") ?? "", provider, chatUserId: form.get("user_id") ?? form.get("user_name") ?? "" };
  }
  try {
    const body = JSON.parse(rawBody) as { text?: unknown; user?: unknown; id?: unknown; from?: { name?: unknown; id?: unknown; aadObjectId?: unknown } };
    // A Teams activity says who sent it in `from` and wraps the bot mention in <at> tags and HTML around the words.
    const text = typeof body.text === "string" ? body.text.replace(/<at>.*?<\/at>/giu, " ").replace(/<[^>]*>/gu, " ").replaceAll("&nbsp;", " ").replace(/\s+/gu, " ").trim() : "";
    const user = typeof body.user === "string" ? body.user : typeof body.from?.name === "string" ? body.from.name : "someone";
    const teamsId = [body.from?.aadObjectId, body.from?.id].find((value): value is string => typeof value === "string" && value !== "");
    return { text, user, eventId: typeof body.id === "string" ? body.id : "", provider, chatUserId: provider === "teams" ? teamsId ?? "" : typeof body.user === "string" ? body.user : "" };
  } catch { return { text: "", user: "someone", eventId: "", provider, chatUserId: "" }; }
}

interface PendingRow { id: string; workspace_id: string; subject_json: string; version: number; subject_digest: string; expires_at_ms: number }

function organizationOf(store: Store, env: NodeJS.ProcessEnv): string | undefined {
  const named = env["BRAIN_INBOUND_WEBHOOK_ORG"];
  if (named) return named;
  const rows = store.control.prepare("SELECT id FROM organizations LIMIT 2").all() as Array<{ id: string }>;
  return rows.length === 1 ? rows[0]!.id : undefined;
}

/** Handles one inbound request. `rawBody` is the exact text that was signed. */
export async function handleInbound(store: Store, headers: Headers, rawBody: string, env: NodeJS.ProcessEnv = process.env, port?: ChatStartPort): Promise<InboundReply> {
  const secret = env["BRAIN_INBOUND_WEBHOOK_SECRET"];
  const teamsToken = env["BRAIN_INBOUND_TEAMS_TOKEN"];
  const usable = (value: string | undefined): value is string => !!value && value.length >= 16;
  if (!usable(secret) && !usable(teamsToken)) return { status: 503, body: { error: "the inbound chat webhook is not configured on this server" } };
  // A request names its scheme by its headers; each scheme is checked only against its own secret, and one that is not set up is refused.
  const teams = /^HMAC /u.test(headers.get("authorization") ?? "");
  const refused = teams ? (usable(teamsToken) ? verifyTeamsSignature(teamsToken, headers, rawBody, store.now()) : "Teams signatures are not set up on this server")
    : (usable(secret) ? verifyInboundSignature(secret, headers, rawBody, store.now()) : "this request's signature scheme is not set up on this server");
  if (refused) return { status: 401, body: { error: refused } };
  const organizationId = organizationOf(store, env);
  if (!organizationId) return { status: 503, body: { error: "name the organization with BRAIN_INBOUND_WEBHOOK_ORG" } };
  const { text, user, eventId, provider, chatUserId } = parseCommand(headers, rawBody);
  const [command = "", ...rest] = text.split(/\s+/u);
  // A signed request is handled once: a retry of the same event (or the same signature) is acknowledged, not repeated.
  const key = eventId || createHash("sha256").update(headers.get("x-slack-signature") ?? headers.get("x-brain-signature") ?? headers.get("authorization") ?? rawBody).digest("hex");
  const first = store.control.prepare("INSERT OR IGNORE INTO inbound_hook_events(remote_event_id, received_at_ms) VALUES (?,?)").run(key.slice(0, 200), store.now());
  // A repeated `start` goes on to the command funnel, which answers a message it already started with the same mission (idempotent per message).
  if (first.changes !== 1 && command.toLowerCase() !== "start") return reply(200, "Already handled.");
  store.control.prepare("DELETE FROM inbound_hook_events WHERE received_at_ms<?").run(store.now() - 24 * 3600_000);

  const pending = (): PendingRow[] => store.control.prepare("SELECT id, workspace_id, subject_json, version, subject_digest, expires_at_ms FROM approval_requests WHERE organization_id=? AND state='pending' AND expires_at_ms>? ORDER BY created_at_ms DESC LIMIT 10").all(organizationId, store.now()) as PendingRow[];
  const describe = (row: PendingRow): string => {
    const summary = (JSON.parse(row.subject_json) as ActionSubject).effectBounds?.["summary"];
    return `${typeof summary === "string" ? summary : "An action waits for a decision"}: ${absoluteLink(`/approvals/${row.id}`)}`;
  };
  switch (command.toLowerCase()) {
    case "approvals": case "pending": {
      const rows = pending();
      return reply(200, rows.length === 0 ? "Nothing waits for your decision." : `${rows.length} waiting:\n${rows.map(describe).join("\n")}`);
    }
    case "status": {
      const waiting = pending().length;
      return reply(200, `Brain is up. ${waiting === 0 ? "Nothing waits for a decision." : `${waiting} approval${waiting === 1 ? "" : "s"} wait for a decision: ${absoluteLink("/approvals")}`}`);
    }
    case "approve": {
      const id = rest[0] ?? "";
      const row = pending().find((candidate) => candidate.id === id);
      return reply(200, row ? `Approving needs you signed in. Decide here: ${absoluteLink(`/approvals/${row.id}`)}` : "No pending approval has that id. Send \"approvals\" to list them.");
    }
    case "deny": {
      const id = rest[0] ?? "";
      const row = pending().find((candidate) => candidate.id === id);
      if (!row) return reply(200, "No pending approval has that id. Send \"approvals\" to list them.");
      // Refusing only takes authority away, so a signed message may do it; the decision is recorded as made through chat.
      store.inTx(store.control, () => {
        store.control.prepare("INSERT INTO approval_decisions(id, approval_id, expected_version, actor_id, auth_evidence_ref, subject_digest, decision, note, created_at_ms) VALUES (?,?,?,?,?,?,'reject',?,?)")
          .run(store.id("dec"), row.id, row.version, `chat:${user}`.slice(0, 120), "signed-chat-webhook", row.subject_digest, `denied from chat by ${user}`.slice(0, 200), store.now());
        transitionState(store.control, "approval", row.id, "rejected", { bumpVersion: true, and: { version: row.version } });
        store.emit(store.control, { organizationId, workspaceId: row.workspace_id, aggregateType: "approval", aggregateId: row.id, eventType: "approval.rejected", payload: { approvalId: row.id, via: "chat" } });
      });
      return reply(200, "Denied. Nothing was changed.");
    }
    case "start": {
      if (!port) return reply(200, "Starting work from chat is not available on this server.");
      return reply(200, await port.start({ organizationId, provider, chatUserId, messageKey: key, args: rest }));
    }
    default:
      return reply(200, "Send \"approvals\" to list what waits, \"deny <id>\" to refuse one, \"approve <id>\" for the link to decide it, or \"start <play>\" to start a mission from a Play. Approving and confirming a plan always happen in Brain, signed in.");
  }
}
