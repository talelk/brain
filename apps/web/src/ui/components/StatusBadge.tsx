import { Badge } from "@talelk/newui-atoms";
import type { BadgeTheme } from "@talelk/newui-atoms";
import type { JSX } from "solid-js";

const LABELS: Record<string, string> = {
  ready: "Ready", healthy: "Healthy", online: "Online", idle: "Idle", running: "Running",
  succeeded: "Succeeded", accepted: "Accepted", verified: "Verified", active: "Active",
  pending: "Pending", queued: "Queued", offered: "Offered", verifying: "Verifying",
  busy: "Busy", stale: "Needs refresh", blocked: "Blocked", waiting: "Waiting",
  failed: "Failed", offline: "Offline", revoked: "Revoked", rejected: "Rejected",
  cancelled: "Cancelled", outcome_unknown: "Outcome unknown", expired: "Expired",
  draft: "Draft", published: "Published", incomplete: "Incomplete",
};

const THEMES: Record<string, BadgeTheme> = {
  ready: "green", healthy: "green", online: "green", idle: "green", running: "blue",
  succeeded: "green", accepted: "green", verified: "green", active: "green",
  pending: "amber", queued: "amber", offered: "amber", verifying: "blue", busy: "blue",
  stale: "amber", blocked: "red", waiting: "amber", failed: "red", offline: "red",
  revoked: "red", rejected: "red", cancelled: "gray", outcome_unknown: "red", expired: "red",
  draft: "gray", published: "green", incomplete: "amber",
};

export function StatusBadge(props: { status: string; label?: string }): JSX.Element {
  const status = () => props.status.toLowerCase();
  return <Badge size="lg" theme={THEMES[status()] ?? "gray"} label={props.label ?? LABELS[status()] ?? props.status.replaceAll("_", " ")} />;
}
