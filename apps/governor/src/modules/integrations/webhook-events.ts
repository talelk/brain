import type { WebhookKind } from "@brain/contracts";

/**
 * What a signed delivery means for Brain (ADR 0077), the same few shapes whatever the provider: a ticket or incident that opened, closed,
 * reopened or was labeled; a pull or merge request that opened, closed or merged; a check or pipeline that finished. Anything else is
 * `ignored`. This reads text the signature has already vouched for, and never decides anything: it only names what happened.
 */
export type SubjectAction = "opened" | "closed" | "reopened" | "labeled";
export type CheckConclusion = "success" | "failure" | "cancelled" | "neutral" | "skipped" | "other";

export type HookEvent =
  | { type: "subject"; subject: "ticket" | "incident"; action: SubjectAction; remoteId: string; title: string; labels: readonly string[]; severity?: string; url?: string }
  | { type: "pull"; state: "open" | "merged" | "closed"; url: string; repository: string; number: number; title: string }
  | { type: "check"; name: string; conclusion: CheckConclusion; pullUrls: readonly { url: string; repository: string; number: number }[] }
  | { type: "ignored"; reason: string };

export interface ParsedDelivery { readonly event: string; readonly deliveryId: string | undefined; readonly outcome: HookEvent }

const ignored = (event: string, deliveryId: string | undefined, reason: string): ParsedDelivery => ({ event, deliveryId, outcome: { type: "ignored", reason } });
const rec = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const text = (value: unknown, max = 512): string => (typeof value === "string" ? value.slice(0, max) : "");
const count = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : -1);
const labelNames = (value: unknown, field: string): string[] => (Array.isArray(value) ? value.map((entry) => text(rec(entry)[field], 80)).filter((name) => name !== "").slice(0, 50) : []);

function conclusion(value: unknown): CheckConclusion {
  switch (text(value, 40)) {
    case "success": case "passed": return "success";
    case "failure": case "failed": case "timed_out": case "startup_failure": return "failure";
    case "cancelled": case "canceled": return "cancelled";
    case "neutral": return "neutral";
    case "skipped": return "skipped";
    default: return "other";
  }
}

function parseJson(raw: string): Record<string, unknown> | undefined {
  try { const parsed = JSON.parse(raw) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined; } catch { return undefined; }
}

function github(headers: Headers, body: Record<string, unknown>): ParsedDelivery {
  const event = headers.get("x-github-event") ?? "";
  const deliveryId = headers.get("x-github-delivery") ?? undefined;
  const repo = rec(body["repository"]);
  const fullName = text(repo["full_name"], 300);
  const action = text(body["action"], 40);
  if (event === "issues") {
    const issue = rec(body["issue"]);
    const number = count(issue["number"]);
    if (number < 0 || !fullName) return ignored(event, deliveryId, "the issue could not be identified");
    if (action !== "opened" && action !== "closed" && action !== "reopened" && action !== "labeled") return ignored(event, deliveryId, `issue ${action || "event"} does not change a subject`);
    return { event, deliveryId, outcome: { type: "subject", subject: "ticket", action, remoteId: `${fullName}#${number}`, title: text(issue["title"]) || `Issue ${number}`, labels: labelNames(issue["labels"], "name"), url: text(issue["html_url"], 2048) } };
  }
  if (event === "pull_request") {
    const pr = rec(body["pull_request"]);
    const number = count(pr["number"]);
    const url = text(pr["html_url"], 2048);
    if (number < 0 || !fullName || !url) return ignored(event, deliveryId, "the pull request could not be identified");
    const state = action === "closed" ? (pr["merged"] === true ? "merged" : "closed") : action === "opened" || action === "reopened" ? "open" : undefined;
    if (!state) return ignored(event, deliveryId, `pull request ${action || "event"} does not change its state`);
    return { event, deliveryId, outcome: { type: "pull", state, url, repository: fullName, number, title: text(pr["title"]) || `Pull request ${number}` } };
  }
  if (event === "check_run") {
    const run = rec(body["check_run"]);
    if (action !== "completed") return ignored(event, deliveryId, "the check has not finished");
    const base = text(repo["html_url"], 1024);
    const pullUrls = (Array.isArray(run["pull_requests"]) ? run["pull_requests"] : []).flatMap((entry) => {
      const number = count(rec(entry)["number"]);
      return number >= 0 && base && fullName ? [{ url: `${base}/pull/${number}`, repository: fullName, number }] : [];
    }).slice(0, 10);
    if (pullUrls.length === 0) return ignored(event, deliveryId, "the check belongs to no pull request");
    return { event, deliveryId, outcome: { type: "check", name: text(run["name"], 200) || "check", conclusion: conclusion(run["conclusion"]), pullUrls } };
  }
  return ignored(event || "unknown", deliveryId, event === "ping" ? "ping" : "event not handled");
}

function gitlab(headers: Headers, body: Record<string, unknown>): ParsedDelivery {
  const event = headers.get("x-gitlab-event") ?? "";
  const deliveryId = headers.get("x-gitlab-event-uuid") ?? headers.get("x-gitlab-webhook-uuid") ?? undefined;
  const kind = text(body["object_kind"], 40);
  const project = rec(body["project"]);
  const path = text(project["path_with_namespace"], 300);
  const attrs = rec(body["object_attributes"]);
  if (kind === "issue") {
    const iid = count(attrs["iid"]);
    if (iid < 0 || !path) return ignored(event, deliveryId, "the issue could not be identified");
    const action = text(attrs["action"], 40);
    const labeled = action === "update" && "labels" in rec(body["changes"]);
    const mapped: SubjectAction | undefined = action === "open" ? "opened" : action === "close" ? "closed" : action === "reopen" ? "reopened" : labeled ? "labeled" : undefined;
    if (!mapped) return ignored(event, deliveryId, `issue ${action || "event"} does not change a subject`);
    return { event, deliveryId, outcome: { type: "subject", subject: "ticket", action: mapped, remoteId: `${path}#${iid}`, title: text(attrs["title"]) || `Issue ${iid}`, labels: labelNames(body["labels"], "title"), url: text(attrs["url"], 2048) } };
  }
  if (kind === "merge_request") {
    const iid = count(attrs["iid"]);
    const url = text(attrs["url"], 2048);
    if (iid < 0 || !path || !url) return ignored(event, deliveryId, "the merge request could not be identified");
    const action = text(attrs["action"], 40);
    const state = action === "merge" ? "merged" : action === "close" ? "closed" : action === "open" || action === "reopen" ? "open" : undefined;
    if (!state) return ignored(event, deliveryId, `merge request ${action || "event"} does not change its state`);
    return { event, deliveryId, outcome: { type: "pull", state, url, repository: path, number: iid, title: text(attrs["title"]) || `Merge request ${iid}` } };
  }
  if (kind === "pipeline") {
    const status = text(attrs["status"], 40);
    if (status !== "success" && status !== "failed" && status !== "canceled" && status !== "skipped") return ignored(event, deliveryId, "the pipeline has not finished");
    const request = rec(body["merge_request"]);
    const url = text(request["url"], 2048);
    const iid = count(request["iid"]);
    if (!url || iid < 0 || !path) return ignored(event, deliveryId, "the pipeline belongs to no merge request");
    return { event, deliveryId, outcome: { type: "check", name: `pipeline ${text(attrs["name"], 120) || text(attrs["ref"], 120) || "run"}`, conclusion: conclusion(status), pullUrls: [{ url, repository: path, number: iid }] } };
  }
  return ignored(event || "unknown", deliveryId, "event not handled");
}

/** The generic ticket webhook: `{ "kind": "ticket"|"incident", "event": "opened"|"closed"|"reopened"|"labeled", "id", "title", "labels"?, "severity"? }`. */
function ticket(headers: Headers, body: Record<string, unknown>): ParsedDelivery {
  const deliveryId = headers.get("x-brain-delivery") ?? undefined;
  const kind = text(body["kind"], 20);
  const action = text(body["event"], 20);
  const event = `${kind || "ticket"}.${action || "event"}`;
  if (kind !== "ticket" && kind !== "incident") return ignored(event, deliveryId, "kind must be ticket or incident");
  if (action !== "opened" && action !== "closed" && action !== "reopened" && action !== "labeled") return ignored(event, deliveryId, "event not handled");
  const remoteId = text(body["id"], 200);
  if (!remoteId) return ignored(event, deliveryId, "the record has no id");
  const severity = text(body["severity"], 20);
  return { event, deliveryId, outcome: { type: "subject", subject: kind, action, remoteId, title: text(body["title"]) || remoteId, labels: Array.isArray(body["labels"]) ? body["labels"].map((label) => text(label, 80)).filter((label) => label !== "").slice(0, 50) : [], ...(severity ? { severity } : {}), ...(text(body["url"], 2048) ? { url: text(body["url"], 2048) } : {}) } };
}

/** Called only after the signature was verified. Unparseable text is an ignored delivery, not an error the sender can learn from. */
export function parseDelivery(kind: WebhookKind, headers: Headers, raw: string): ParsedDelivery {
  const body = parseJson(raw);
  const header = kind === "github" ? headers.get("x-github-event") : kind === "gitlab" ? headers.get("x-gitlab-event") : "ticket";
  if (!body) return ignored(header ?? "unknown", undefined, "the body is not a JSON object");
  return kind === "github" ? github(headers, body) : kind === "gitlab" ? gitlab(headers, body) : ticket(headers, body);
}
