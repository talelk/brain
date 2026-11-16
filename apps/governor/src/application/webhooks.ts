import { createHash } from "node:crypto";
import type { WebhookKind } from "@brain/contracts";
import { DECOY_SECRET, parseDelivery, verifyBrainSignature, verifyGithubSignature, verifyGitlabToken, WEBHOOK_MAX_BYTES, type HookEvent, type WebhookEndpoints } from "../modules/integrations/index";
import { observePullRequest } from "../modules/missions/index";
import type { Store } from "./store";

/**
 * Signed webhooks that record subjects (ADR 0077). A delivery is checked in this order and no later step runs if an earlier one fails:
 * size, then the endpoint and its provider's signature over the raw bytes, then parsing, then the replay check, then the effect, which is
 * written in the same workspace transaction as the record that the delivery was handled. A delivery can start a mission only through an
 * existing subject trigger (whose plan then waits for a person); it has no way to confirm a plan, approve an effect or record a verdict.
 */
export interface WebhookReply { readonly status: number; readonly body: Record<string, unknown> }
export interface SubjectPort { fire(organizationId: string, workspaceId: string, subject: { pack: "support" | "sre"; kind: "ticket" | "incident"; id: string }): number }

const REFUSED: WebhookReply = { status: 401, body: { error: "the request was not accepted" } };
const KEEP_DELIVERIES_MS = 30 * 24 * 3600_000;

type Db = ReturnType<Store["workspaceDb"]>;
type Subject = { pack: "support" | "sre"; kind: "ticket" | "incident"; id: string };
interface Applied { status: "applied" | "ignored"; detail: string; fire: Subject[] }

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Gives the ticket (support) or incident (sre) a delivery names a record and tells whether it is new; only a new, open one may start work. */
function upsertSubject(store: Store, db: Db, kind: WebhookKind, event: Extract<HookEvent, { type: "subject" }>): { subject: Subject; created: boolean; open: boolean } {
  const now = store.now();
  if (event.subject === "incident") {
    const id = `inc-hook-${sha(`${kind}\u0000${event.remoteId}`).slice(0, 24)}`;
    const prior = db.prepare("SELECT state FROM incidents WHERE id=?").get(id) as { state: string } | undefined;
    const state = event.action === "closed" ? "resolved" : event.action === "labeled" ? prior?.state ?? "open" : "open";
    if (!prior) db.prepare("INSERT INTO incidents(id,target_key,severity,title,state,version,opened_at_ms,resolved_at_ms) VALUES (?,?,?,?,?,1,?,?)").run(id, `external:${event.remoteId}`.slice(0, 256), event.severity ?? "warning", event.title, state, now, state === "resolved" ? now : null);
    else db.prepare("UPDATE incidents SET title=?, severity=?, state=?, resolved_at_ms=?, version=version+1 WHERE id=?").run(event.title, event.severity ?? "warning", state, state === "resolved" ? now : null, id);
    return { subject: { pack: "sre", kind: "incident", id }, created: !prior, open: state !== "resolved" };
  }
  return upsertTicket(store, db, `hook-${kind}`, event.remoteId, event.title, event.action === "closed" ? "closed" : "open", event.labels, event.action === "labeled");
}

function priorityOf(labels: readonly string[]): "low" | "normal" | "high" | "urgent" {
  const names = labels.map((label) => label.toLowerCase());
  return names.some((name) => name === "urgent" || name === "priority:urgent" || name === "p0") ? "urgent" : names.some((name) => name === "high" || name === "priority:high" || name === "p1") ? "high" : names.some((name) => name === "low" || name === "priority:low") ? "low" : "normal";
}

function upsertTicket(store: Store, db: Db, connector: string, remoteId: string, title: string, state: "open" | "closed", labels: readonly string[], keepState: boolean): { subject: Subject; created: boolean; open: boolean } {
  const now = store.now();
  const id = `tkt-hook-${sha(`${connector}\u0000${remoteId}`).slice(0, 24)}`;
  const prior = db.prepare("SELECT state FROM tickets WHERE id=?").get(id) as { state: string } | undefined;
  const next = keepState && prior ? prior.state : state;
  const digest = sha(`${title}\u0000${next}\u0000${labels.join(",")}`);
  if (!prior) db.prepare("INSERT INTO tickets(id,connector_id,remote_id,state,title,body_digest,source_version,observed_at_ms,created_at_ms,priority,labels_json) VALUES (?,?,?,?,?,?,'webhook',?,?,?,?)").run(id, connector, remoteId, next, title, digest, now, now, priorityOf(labels), JSON.stringify(labels));
  else db.prepare("UPDATE tickets SET state=?, title=?, body_digest=?, observed_at_ms=?, priority=?, labels_json=?, version=version+1 WHERE id=?").run(next, title, digest, now, priorityOf(labels), JSON.stringify(labels), id);
  return { subject: { pack: "support", kind: "ticket", id }, created: !prior, open: next === "open" };
}

function apply(store: Store, db: Db, endpoint: { id: string; organizationId: string; workspaceId: string; kind: WebhookKind; connectionId: string | undefined }, event: HookEvent, deliveryId: string): Applied {
  if (event.type === "ignored") return { status: "ignored", detail: event.reason, fire: [] };
  if (event.type === "subject") {
    const { subject, created, open } = upsertSubject(store, db, endpoint.kind, event);
    return { status: "applied", detail: `${subject.kind} ${created ? "recorded" : "updated"}`, fire: created && open ? [subject] : [] };
  }
  // A pull or merge request, or a check on one. A recorded pull request (#121) is matched by its address; any other becomes a subject,
  // which never starts a mission by itself: only an issue or incident that opens can.
  const recorded = (url: string): string | undefined => (db.prepare(`SELECT id FROM pull_requests WHERE url=? ${endpoint.connectionId ? "AND connection_id=?" : ""}`).get(...(endpoint.connectionId ? [url, endpoint.connectionId] : [url])) as { id: string } | undefined)?.id;
  const subjectFor = (target: { url: string; repository: string; number: number }, title: string, state: "open" | "closed", keepState: boolean): string =>
    upsertTicket(store, db, `hook-${endpoint.kind}`, `${target.repository}!${target.number}`, title, state, [], keepState).subject.id;
  if (event.type === "pull") {
    const pullRequestId = recorded(event.url);
    if (pullRequestId) {
      const { changed } = observePullRequest(store, db, { organizationId: endpoint.organizationId, workspaceId: endpoint.workspaceId, pullRequestId, state: event.state, observedBy: `webhook-${endpoint.kind}`, source: "webhook" });
      return { status: "applied", detail: changed ? `pull request ${event.state}` : "pull request state confirmed", fire: [] };
    }
    subjectFor(event, event.title, event.state === "open" ? "open" : "closed", false);
    return { status: "applied", detail: `request recorded as a subject (${event.state})`, fire: [] };
  }
  let attached = 0;
  for (const target of event.pullUrls) {
    const pullRequestId = recorded(target.url);
    // A check only attaches: a request already known as a subject keeps its own title and state.
    const known = pullRequestId ? undefined : (db.prepare("SELECT id FROM tickets WHERE connector_id=? AND remote_id=?").get(`hook-${endpoint.kind}`, `${target.repository}!${target.number}`) as { id: string } | undefined)?.id;
    const subjectId = pullRequestId ? undefined : known ?? subjectFor(target, `Pull request ${target.number} in ${target.repository}`, "open", false);
    db.prepare("INSERT INTO subject_checks(id,pull_request_id,subject_id,name,conclusion,source,endpoint_id,delivery_id,observed_at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(store.id("chk"), pullRequestId ?? null, subjectId ?? null, event.name, event.conclusion, endpoint.kind, endpoint.id, deliveryId, store.now());
    attached++;
  }
  return { status: "applied", detail: `check ${event.conclusion} recorded on ${attached} request${attached === 1 ? "" : "s"}`, fire: [] };
}

export function receiveWebhook(deps: { store: Store; endpoints: WebhookEndpoints; subjects: SubjectPort }, input: { kind: WebhookKind; endpointId: string; headers: Headers; raw: Buffer }): WebhookReply {
  const { store, endpoints, subjects } = deps;
  const { kind, endpointId, headers, raw } = input;
  if (raw.length > WEBHOOK_MAX_BYTES) return { status: 413, body: { error: "the request is too large" } };
  const found = endpoints.resolve(endpointId);
  const endpoint = found && found.kind === kind ? found : undefined;
  // An unknown endpoint, one of another kind and a wrong signature are the same answer after the same work.
  const secret = endpoint?.secret ?? DECOY_SECRET;
  const valid = kind === "github" ? verifyGithubSignature(secret, headers, raw) : kind === "gitlab" ? verifyGitlabToken(secret, headers) : verifyBrainSignature(secret, headers, raw, store.now());
  if (!endpoint || !valid) return REFUSED;

  const parsed = parseDelivery(kind, headers, raw.toString("utf8"));
  // The generic ticket webhook is the one provider whose signature covers a timestamp, so its replay digest covers it too: a legitimate
  // repeat of an identical body arrives with a new timestamp and delivery id and is handled; only an exact replay is the same delivery.
  if (kind === "ticket" && !parsed.deliveryId) return { status: 400, body: { error: "x-brain-delivery is required" } };
  const digest = createHash("sha256").update(kind === "ticket" ? `${headers.get("x-brain-timestamp") ?? ""}.` : "").update(raw).digest("hex");
  const deliveryId = (parsed.deliveryId ?? `body-${digest}`).slice(0, 200);
  const db = store.workspaceDb(endpoint.workspaceId, endpoint.organizationId);
  const result: { applied?: Applied; again: Subject[] } = { again: [] };
  store.inTx(db, () => {
    // The same delivery id, or the same signed bytes under a fresh id (a captured request replayed), is acknowledged and changes nothing.
    const seen = db.prepare("SELECT fire_json FROM webhook_deliveries WHERE endpoint_id=? AND (delivery_id=? OR body_digest=?)").get(endpoint.id, deliveryId, digest) as { fire_json: string | null } | undefined;
    if (seen) { result.again = seen.fire_json ? JSON.parse(seen.fire_json) as Subject[] : []; return; }
    const outcome = apply(store, db, endpoint, parsed.outcome, deliveryId);
    result.applied = outcome;
    db.prepare("INSERT INTO webhook_deliveries(endpoint_id,delivery_id,body_digest,event,status,detail,received_at_ms,fire_json) VALUES (?,?,?,?,?,?,?,?)").run(endpoint.id, deliveryId, digest, parsed.event.slice(0, 80), outcome.status, outcome.detail.slice(0, 200), store.now(), outcome.fire.length ? JSON.stringify(outcome.fire) : null);
    db.prepare("DELETE FROM webhook_deliveries WHERE endpoint_id=? AND received_at_ms<?").run(endpoint.id, store.now() - KEEP_DELIVERIES_MS);
  });
  // Asking the triggers again is harmless (one occurrence per automation and subject), and it repairs a crash after the commit above.
  for (const subject of result.applied ? result.applied.fire : result.again) {
    try { subjects.fire(endpoint.organizationId, endpoint.workspaceId, subject); } catch { /* a trigger that cannot start never loses the subject */ }
  }
  return { status: 200, body: { status: result.applied ? result.applied.status : "duplicate" } };
}
