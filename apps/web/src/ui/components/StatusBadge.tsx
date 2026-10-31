import { Badge } from "@talelk/newui-atoms";
import type { BadgeTheme } from "@talelk/newui-atoms";
import type { JSX } from "solid-js";

/**
 * The one state → label/tone map. Every screen renders states through
 * StatusBadge (or statusTheme for places that take a theme string); inline
 * ternary remappings are a consistency bug, not a style choice.
 */

type StatusMap = Record<string, { theme: BadgeTheme; label: string }>;

const JOB: StatusMap = {
  queued: { theme: "amber", label: "Queued" }, offered: { theme: "amber", label: "Offered" },
  running: { theme: "blue", label: "Running" }, verifying: { theme: "blue", label: "Verifying" },
  succeeded: { theme: "green", label: "Succeeded" }, partial: { theme: "amber", label: "Partial" },
  failed: { theme: "red", label: "Failed" }, cancelled: { theme: "gray", label: "Cancelled" },
  blocked: { theme: "red", label: "Blocked" }, outcome_unknown: { theme: "red", label: "Outcome unknown" },
  suspended: { theme: "amber", label: "Suspended" }, created: { theme: "gray", label: "Created" },
  validated: { theme: "gray", label: "Validated" }, ready: { theme: "green", label: "Ready" },
};

const WORK_ITEM: StatusMap = {
  backlog: { theme: "gray", label: "Backlog" }, ready: { theme: "blue", label: "Ready" },
  "in-progress": { theme: "blue", label: "In Progress" }, blocked: { theme: "red", label: "Blocked" },
  review: { theme: "amber", label: "Review" }, done: { theme: "green", label: "Done" },
  abandoned: { theme: "gray", label: "Abandoned" },
};

const APPROVAL: StatusMap = {
  pending: { theme: "blue", label: "Pending" }, approved: { theme: "green", label: "Approved" },
  rejected: { theme: "red", label: "Rejected" }, "changes-requested": { theme: "amber", label: "Changes requested" },
  revoked: { theme: "gray", label: "Revoked" }, expired: { theme: "gray", label: "Expired" },
};

const RUNNER: StatusMap = {
  online: { theme: "green", label: "Online" }, idle: { theme: "green", label: "Idle" },
  busy: { theme: "blue", label: "Busy" }, draining: { theme: "amber", label: "Draining" },
  quarantined: { theme: "red", label: "Quarantined" }, offline: { theme: "red", label: "Offline" },
};

const AUTOMATION: StatusMap = {
  active: { theme: "green", label: "Active" }, paused: { theme: "gray", label: "Paused" },
};

const OCCURRENCE: StatusMap = {
  pending: { theme: "gray", label: "Pending" }, dispatched: { theme: "green", label: "Dispatched" },
  skipped: { theme: "gray", label: "Skipped" }, failed: { theme: "red", label: "Failed" },
};

const EVIDENCE: StatusMap = {
  submitted: { theme: "blue", label: "Submitted" }, verifying: { theme: "blue", label: "Verifying" },
  verified: { theme: "green", label: "Verified" }, rejected: { theme: "red", label: "Rejected" },
  passed: { theme: "green", label: "Passed" }, failed_check: { theme: "red", label: "Failed" },
};

const PLAN: StatusMap = {
  proposed: { theme: "blue", label: "Proposed" }, confirmed: { theme: "green", label: "Confirmed" },
  superseded: { theme: "gray", label: "Superseded" }, running: { theme: "blue", label: "Preparing" },
  failed: { theme: "red", label: "Failed" },
};

const TICKET: StatusMap = {
  open: { theme: "blue", label: "Open" }, resolved: { theme: "green", label: "Resolved" },
};

const INCIDENT_STATE: StatusMap = {
  open: { theme: "red", label: "Open" }, investigating: { theme: "amber", label: "Investigating" },
  mitigated: { theme: "blue", label: "Mitigated" }, resolved: { theme: "green", label: "Resolved" },
};

const SEVERITY: StatusMap = {
  critical: { theme: "red", label: "Critical" }, high: { theme: "amber", label: "High" },
  medium: { theme: "blue", label: "Medium" }, low: { theme: "gray", label: "Low" },
  urgent: { theme: "red", label: "Urgent" }, normal: { theme: "blue", label: "Normal" },
  warning: { theme: "amber", label: "Warning" }, info: { theme: "blue", label: "Info" },
};

const HEALTH: StatusMap = {
  healthy: { theme: "green", label: "Healthy" }, degraded: { theme: "amber", label: "Degraded" },
  unavailable: { theme: "red", label: "Unavailable" },
};

const DECISION: StatusMap = {
  go: { theme: "green", label: "Go" }, no: { theme: "red", label: "No" },
  "not-now": { theme: "gray", label: "Not now" }, "need-more-data": { theme: "amber", label: "Need more data" },
};

const KNOWLEDGE: StatusMap = {
  reviewed: { theme: "green", label: "Reviewed" }, stale: { theme: "amber", label: "Stale" },
  quarantined: { theme: "gray", label: "Quarantined" }, candidate: { theme: "blue", label: "Candidate" },
  published: { theme: "green", label: "Published" },
};

const CHECK: StatusMap = {
  passed: { theme: "green", label: "Passed" }, failed: { theme: "red", label: "Failed" },
  missing: { theme: "amber", label: "Missing" },
};

const PRIORITY: StatusMap = {
  "0": { theme: "gray", label: "Low" }, "1": { theme: "amber", label: "Elevated" },
  "2": { theme: "red", label: "Immediate" }, "3": { theme: "red", label: "Immediate" },
};

const CONNECTION: StatusMap = {
  connected: { theme: "green", label: "Connected" }, verified: { theme: "green", label: "Verified" },
  configuring: { theme: "blue", label: "Configuring" }, pending: { theme: "amber", label: "Pending" },
  failed: { theme: "red", label: "Failed" }, reconnecting: { theme: "amber", label: "Reconnecting" },
};

const PLACEMENT: StatusMap = {
  READY: { theme: "green", label: "Ready" }, WAITING_FOR_RUNNER: { theme: "amber", label: "Waiting for runner" },
  WAITING_FOR_DEPENDENCY: { theme: "amber", label: "Waiting for dependency" },
};

const GENERIC: StatusMap = {
  healthy: { theme: "green", label: "Healthy" }, active: { theme: "green", label: "Active" },
  accepted: { theme: "green", label: "Accepted" }, verified: { theme: "green", label: "Verified" },
  published: { theme: "green", label: "Published" }, online: { theme: "green", label: "Online" },
  idle: { theme: "green", label: "Idle" },
  stale: { theme: "amber", label: "Needs refresh" }, waiting: { theme: "amber", label: "Waiting" },
  draft: { theme: "gray", label: "Draft" }, revoked: { theme: "red", label: "Revoked" },
  rejected: { theme: "red", label: "Rejected" }, expired: { theme: "red", label: "Expired" },
  incomplete: { theme: "amber", label: "Incomplete" },
  offline: { theme: "red", label: "Offline" },
};

const MAPS: Record<string, StatusMap> = {
  job: JOB, workItem: WORK_ITEM, approval: APPROVAL, runner: RUNNER, automation: AUTOMATION,
  occurrence: OCCURRENCE, evidence: EVIDENCE, plan: PLAN, ticket: TICKET,
  incident: INCIDENT_STATE, severity: SEVERITY, health: HEALTH, decision: DECISION,
  knowledge: KNOWLEDGE, check: CHECK, priority: PRIORITY, connection: CONNECTION, placement: PLACEMENT,
};

export type StatusKind = keyof typeof MAPS;

function lookup(kind: string | undefined, value: string): { theme: BadgeTheme; label: string } {
  const raw = value.toLowerCase();
  const specific = kind ? MAPS[kind]?.[raw] : undefined;
  if (specific) return specific;
  if (!kind) {
    for (const map of Object.values(MAPS)) if (map[raw]) return map[raw];
    if (GENERIC[raw]) return GENERIC[raw];
  }
  return { theme: "gray", label: value.replaceAll("_", " ").replaceAll("-", " ") };
}

/** The tone for a state value — for surfaces that take a theme string (Badge, Alert). */
export function statusTheme(kind: StatusKind | undefined, value: string): BadgeTheme {
  return lookup(kind, value).theme;
}

export type HeaderTheme = "gray" | "blue" | "green" | "red";

/** DetailHeader's tone set has no amber; warning states render blue until the design system widens it (docs/ui/newui-backlog.md). */
export function statusHeaderTheme(kind: StatusKind | undefined, value: string): HeaderTheme {
  const theme = lookup(kind, value).theme;
  return theme === "amber" || theme === "violet" ? "blue" : theme;
}

export function statusLabel(kind: StatusKind | undefined, value: string): string {
  return lookup(kind, value).label;
}

export function StatusBadge(props: { kind?: StatusKind; status: string; label?: string }): JSX.Element {
  const resolved = () => lookup(props.kind, props.status);
  return <Badge size="lg" theme={resolved().theme} label={props.label ?? resolved().label} />;
}
