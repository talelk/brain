import type { AuditEntry } from "@brain/contracts";
import { eventWords } from "./format";

const quoted = (what: string | undefined): string => (what ? ` "${what}"` : "");

/** Sentence builders for Health's "Recent activity", keyed by event type; `what` is the task or mission title when Brain knows it. */
const SENTENCES: Record<string, (what: string | undefined) => string> = {
  "workItem.transitioned": (what) => `Task${quoted(what)} changed state`,
  "workItem.parked": (what) => `Task${quoted(what)} stopped and is waiting for you`,
  "workItem.unparked": (what) => `Task${quoted(what)} was set going again`,
  "mission.created": (what) => `Mission${quoted(what)} was started`,
  "mission.stateChanged": (what) => `Mission${quoted(what)} changed state`,
  "mission.budgetChanged": (what) => `The limits of mission${quoted(what)} changed`,
  "mission.verdictRecorded": (what) => `Mission${quoted(what)} got a final verdict`,
  "mission.briefChanged": (what) => `The brief of mission${quoted(what)} changed`,
  "job.queued": () => "A task was queued",
  "job.updated": () => "A task made progress",
  "session.delegated": () => "A session was handed to another agent",
  "session.checkpointed": () => "A session saved its progress",
  "handoff.submitted": () => "A task handed over its result",
  "document.uploaded": () => "A document was added",
  "document.revised": () => "A document got a new version",
  "document.revoked": () => "A document was withdrawn",
  "document.associated": () => "A document was linked to a mission",
  "automation.created": () => "A schedule was created",
  "automation.revised": () => "A schedule was changed",
  "automation.run_now": () => "A schedule was run by hand",
  "knowledge.extracted": () => "Knowledge was saved from a finished mission",
  "workspace.updated": () => "The workspace settings changed",
  "plan.proposed": () => "A plan was drafted",
  "plan.confirmed": () => "A plan was confirmed",
  "plan.autoConfirmed": () => "A repeated plan was confirmed automatically",
  "plan.rejected": () => "A plan was rejected",
  "output.versionRecorded": () => "A new version of a document was recorded",
  "approval.requested": () => "An approval was requested",
  "config.activated": () => "A release was activated",
  "share.created": () => "A share link was created",
  "share.revoked": () => "A share link was withdrawn",
  "share.viewed": () => "A share link was opened",
  "challenge.requested": () => "A second look at a result was requested",
  "challenge.completed": () => "A second look at a result finished",
  "runner.trust.verified": () => "A runner was verified",
  "runner.trust.revoked": () => "A runner was no longer trusted",
};

/** One plain sentence for an audit entry: the sentence the event carries when it has one, otherwise a humanised event type. */
export function auditSentence(entry: Pick<AuditEntry, "action" | "message" | "subject">): string {
  if (entry.message) return entry.message;
  const known = SENTENCES[entry.action];
  if (known) return known(entry.subject);
  const words = eventWords(entry.action);
  return words.charAt(0).toUpperCase() + words.slice(1);
}
