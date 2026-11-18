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
  ["invalidLink", /^This link is not valid, or it has expired or been used\.?$/u],
  ["tooManyAttempts", /^Too many attempts: wait a minute and try again\.?$/u],
  ["hasAccount", /^This address already has an account\.?$/u],
  ["lastInstanceAdmin", /^Brain keeps at least one active instance admin\.?$/u],
  ["deactivateSelf", /^Ask another admin to deactivate you\.?$/u],
  ["wrongPassword", /^The current password is wrong\.?$/u],
  ["groupTaken", /^A group has this name already\.?$/u],
  ["noGroup", /^There is no such group\.?$/u],
  ["noPerson", /^There is no such person\.?$/u],
  ["noInvitation", /^There is no pending invitation like this\.?$/u],
  ["fromProfile", /^This is done from the Profile page\.?$/u],
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
  ["audit.sequence-gap", /^event (?<seq>\d+) \(.*\) is where position \d+ was expected: .*/u],
  ["audit.broken-link", /^event (?<seq>\d+) \(.*\) does not continue the event before it: .*/u],
  ["audit.payload-edited", /^event (?<seq>\d+) \(.*\) (?:has a payload that is not valid JSON|was edited: its payload no longer matches .*)/u],
  ["audit.event-edited", /^event (?<seq>\d+) \(.*\) was edited: what it records no longer matches .*/u],
  ["audit.key-mismatch", /^key \S+ (?:is not the key its id was derived from|differs from the key the audit log recorded under that id)/u],
  ["audit.checkpoint-unknown-key", /^.* was signed by key \S+, which is not an audit key of this Governor/u],
  ["audit.checkpoint-unsigned", /^.* does not carry a valid signature from key \S+/u],
  ["audit.tail-truncated", /^.* covers events beyond the last one present \(\d+\): the end of the log was cut/u],
  ["audit.checkpoint-mismatch", /^.* signed a different history than the log now holds at that position: .*/u],
  ["audit.receipt", /^event (?<seq>\d+) .*(?:receipt|runner).*/u],
  ["problemNoBrain", /^the workspace has no brain\.toml$/u],
  ["problemToml", /^not valid TOML(?<at>[^:]*): (?<why>.+)$/u],
  ["problemNoTool", /^tool "(?<name>[^"]+)" has no tool\.toml$/u],
  ["problemNoAgentToml", /^agent "(?<name>[^"]+)" has no agent\.toml$/u],
  ["problemNoPrompt", /^agent "(?<name>[^"]+)" has no prompt\.md$/u],
  ["problemPromptEmpty", /^the prompt is empty$/u],
  ["problemToolMissing", /^tool "(?<name>[^"]+)" does not exist$/u],
  ["problemModelMissing", /^model "(?<name>[^"]+)" is not a \[\[model\]\] of brain\.toml$/u],
  ["problemNoScript", /^the tool needs a run\.sh beside it \(or runs = "brain", or host_command\)$/u],
  ["problemScriptBrain", /^a tool Brain runs has no run\.sh$/u],
  ["problemScriptHost", /^a host command tool has no run\.sh$/u],
  ["problemTwoModels", /^two models are named "(?<name>[^"]+)"$/u],
  ["problemTwoProjects", /^two projects are named "(?<name>[^"]+)"$/u],
  ["problemApprovalTool", /^approvals names tool "(?<name>[^"]+)", which does not exist$/u],
  ["problemMemoryTitle", /^a memory entry starts with its title, written as a line `# Title`$/u],
  ["problemMemoryTranslation", /^translates the memory entry (?<name>\S+), which does not exist$/u],
  ["workspaceInvalid", /^The workspace would not be valid, so nothing was changed$/u],
  ["auditUnverifiedDetail", /^The audit log does not verify$/u],
];

/** A state word inside a sentence, translated: a task state, or an approval or proposal state. */
const word = (value: string): string => tKey(`state.${value}`, tKey(`said.word.${value}`, value));

export function said(message: string): string {
  for (const [id, pattern] of SAID) {
    const found = pattern.exec(message.trim());
    if (!found) continue;
    if (id === "problemToml") return tKey("said.problemToml", message, { at: /\d+/u.exec(found.groups?.["at"] ?? "")?.[0] ? tKey("said.problemToml.at", found.groups?.["at"] ?? "", { line: /\d+/u.exec(found.groups?.["at"] ?? "")?.[0] ?? "" }) : "", why: found.groups?.["why"] ?? "" });
    const params = Object.fromEntries(Object.entries(found.groups ?? {}).map(([name, value]) => [name, name === "state" ? word(value) : value]));
    return tKey(`said.${id}`, message, params);
  }
  return message;
}

/** The graph's and the Health screen's own phrase for a place the audit chain broke. */
export const auditBreak = (kind: string, seq: number | null, detail: string): string => tKey(`said.audit.${kind}`, detail, { seq: seq ?? 0 });
