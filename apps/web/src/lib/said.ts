import { tKey } from "../i18n";

/**
 * Sentences the Governor sends as fixed strings, in the interface's language. An answer that matches one is shown through `said.<id>`;
 * anything else (a pack's own message, an engine's) is shown as it came.
 */
const SAID: readonly (readonly [string, RegExp])[] = [
  ["signin", /^Sign in first\.?$/u],
  ["login", /^The email or the password is wrong\.?$/u],
  ["workspace404", /^Workspace not found\.?$/u],
  ["task404", /^Task not found\.?$/u],
  ["attempt404", /^Attempt not found\.?$/u],
  ["approval404", /^Approval not found\.?$/u],
  ["proposal404", /^Proposal not found\.?$/u],
  ["runner404", /^Runner not found\.?$/u],
  ["file404", /^No such file\.?$/u],
  ["address404", /^There is nothing at this address\.?$/u],
  ["play404", /^The workspace has no Play (?<play>.+)\.?$/u],
  ["path404", /^The workspace has no file (?<path>.+)\.?$/u],
  ["secret404", /^The secret (?<name>.+) is not set\.?$/u],
  ["member404", /^This person is not a member of the workspace\.?$/u],
  ["subtask404", /^(?<id>.+) is not a sub-task of this task\.?$/u],
  ["setupDone", /^This Brain is already set up\.?$/u],
  ["setupBusy", /^Setup is already in progress\.?$/u],
  ["lastAdmin", /^A workspace keeps at least one admin\.?$/u],
  ["needsRole", /^This needs the (?<role>.+) role in the workspace\.?$/u],
  ["needsAdmin", /^This needs an administrator of this Brain\.?$/u],
  ["setupToken", /^The setup token is wrong\.?$/u],
  ["askAdmin", /^Ask an admin of a workspace to add you\.?$/u],
  ["enrol", /^The enrolment token is wrong, used or expired\.?$/u],
  ["staleCall", /^The call is not the one you were shown; read the approval again\.?$/u],
  ["noAgent", /^There is no agent (?<agent>.+)\.?$/u],
  ["inputsPlay", /^The inputs of (?<play>\S+) are not valid: (?<problem>.+)\.?$/u],
  ["inputTool", /^The input of (?<tool>\S+) is not valid: (?<problem>.+)\.?$/u],
  ["noAccount", /^(?<email>\S+) has no account yet: give a name and a first password\.?$/u],
  ["circle", /^Sub-tasks cannot wait for each other in a circle\.?$/u],
  ["address", /^Give the workspace an address\.?$/u],
  ["tooLarge", /^The request is too large\.?$/u],
  ["badRequest", /^The request is not valid\.?$/u],
  ["fileCannot", /^The files cannot be written\.?$/u],
  ["fileLarge", /^The file is too large to keep\.?$/u],
  ["changeNames", /^The change names files that cannot be written or removed\.?$/u],
  ["taskAlready", /^This task is already (?<state>.+)\.?$/u],
  ["proposalAlready", /^This proposal is already (?<state>.+)\.?$/u],
  ["approvalAlready", /^This approval is already (?<state>.+)\.?$/u],
  ["slugTaken", /^A workspace already has the address (?<slug>.+)\.?$/u],
  ["noPlanner", /^This workspace has no planner agent: start a Play, or add the base pack\.?$/u],
  ["noQuestion", /^This task has no question waiting for an answer\.?$/u],
  ["noPlanWaiting", /^This task has no plan waiting to be confirmed\.?$/u],
  ["expired", /^This approval expired; the call did not happen\.?$/u],
  ["archived", /^The workspace is archived\.?$/u],
  ["shownOnce", /^The answer to this command was shown once; send it again with a new key\.?$/u],
  ["idempotency", /^This idempotency key was used for a different command\.?$/u],
  ["subtaskChange", /^Sub-tasks can be changed on a task that groups them and has not ended\.?$/u],
  ["retryOnly", /^Only a task that failed or was stopped, or whose sub-task did, can be tried again\.?$/u],
  ["acknowledge", /^Acknowledge the offer first\.?$/u],
  ["modelKey", /^The model server refused the key\.?$/u],
  ["modelDown", /^The model server did not answer\.?$/u],
  ["modelStatus", /^The model server answered (?<status>\d+)\.?$/u],
  ["auditUnverified", /^The audit log does not verify\.?$/u],
  ["stopped", /^The task was stopped\.?$/u],
  ["noCandidate", /^No candidate produced a result\.?$/u],
  ["attemptFailed", /^The attempt failed\.?$/u],
  ["planMade", /^The plan could not be made: (?<why>.+)\.?$/u],
  ["planUsed", /^The plan could not be used: (?<why>.+)\.?$/u],
];

/** A state word inside a sentence, translated: a task state, or an approval or proposal state. */
const word = (value: string): string => tKey(`state.${value}`, tKey(`said.word.${value}`, value));

export function said(message: string): string {
  for (const [id, pattern] of SAID) {
    const found = pattern.exec(message.trim());
    if (!found) continue;
    const params = Object.fromEntries(Object.entries(found.groups ?? {}).map(([name, value]) => [name, name === "state" ? word(value) : value]));
    return tKey(`said.${id}`, message, params);
  }
  return message;
}

/** The graph's and the Health screen's own phrase for a place the audit chain broke. */
export const auditBreak = (kind: string, seq: number | null, detail: string): string => tKey(`said.audit.${kind}`, detail, { seq: seq ?? 0 });
