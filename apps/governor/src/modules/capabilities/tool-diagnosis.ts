/**
 * Plain-words diagnosis of a failed tool call. The messages are the ones the Governor, the runner brokers, the launcher and the pinned
 * scripts really produce (tests/integration/tool-diagnosis.test.ts keeps the patterns honest); a message nothing matches is reported as
 * unknown with the pointer to the run's logs, never guessed at.
 */
export interface ToolDiagnosis {
  readonly cause: string;
  readonly headline: string;
  readonly nextStep: string;
}

interface Rule { readonly cause: string; readonly pattern: RegExp; readonly headline: string; readonly nextStep: string }

const RULES: readonly Rule[] = [
  { cause: "budget", pattern: /tool-call budget exhausted/iu, headline: "The agent used up its tool-call budget.", nextStep: "Raise the agent's turn limit, or make the task need fewer calls (prefer batch commands over one call per item)." },
  { cause: "not-allowed", pattern: /not allow|unauthorized tool|not pinned in the job|is not a (read-effect|Governor-brokered)/iu, headline: "The agent is not allowed to use this tool, or its pinned version differs.", nextStep: "Add the tool to the agent's tool list at the active digest, then activate a release that pins both." },
  { cause: "bad-input", pattern: /input rejected|is required:|must be|invalid_argument|not a valid address|performs GET requests only|(missing|does not match).*(argument|\^)/iu, headline: "The agent sent input the tool does not accept.", nextStep: "Read the tool's input schema; fix the agent instructions so it sends the required fields." },
  { cause: "host-not-approved", pattern: /allowlist|no approved hosts|approved host/iu, headline: "The address is not on the tool's approved host list.", nextStep: "Use an approved host, or have the owner add the host to the Tool document's allowedHosts and restage the release." },
  { cause: "blocked-address", pattern: /private|loopback|link-local|metadata range|address is not a public/iu, headline: "The address points at a private or internal network, which this tool never fetches.", nextStep: "Use a public address; internal services are reached with host.exec instead." },
  { cause: "path-refused", pattern: /not readable through this tool|outside the readable area|binary files are not readable|no such file or folder|must not contain \.\./iu, headline: "The path is refused or does not exist: secrets, databases, backups and anything outside the readable area are blocked on purpose.", nextStep: "List the parent folder to see what exists, and ask the owner if a needed file is on the deny list." },
  { cause: "command-refused", pattern: /not declared by the operator|is privileged and needs an effect permit|is read-only; use the read tool|is not accepted by/iu, headline: "The host command is not one the operator declared, or its arguments are not allowed.", nextStep: "Use a command listed in the tool's input schema; the operator adds commands in the host-commands file." },
  { cause: "no-launcher", pattern: /needs the trusted launcher|requires the constrained launcher|sandboxed execution failed|launcher/iu, headline: "The runner has no working sandbox launcher, so the tool could not run.", nextStep: "Check that brain-launcher is running and the runner has BRAIN_LAUNCHER_SOCKET set (Administration > Health)." },
  { cause: "permit", pattern: /effect permit/iu, headline: "The call needed an effect permit that was missing or no longer valid.", nextStep: "Approve the pending request in Approvals, then try again." },
  { cause: "timeout", pattern: /timed out|timeout|aborted/iu, headline: "The call took too long and was stopped.", nextStep: "Try a smaller request; if it keeps happening, raise the tool's timeoutSeconds in its Tool document." },
  { cause: "too-large", pattern: /too large|too many redirects|exceed|truncat/iu, headline: "The input or the result was larger than the tool's limit.", nextStep: "Ask for a smaller slice (a narrower path, a lower maxBytes or maxRows)." },
  { cause: "not-found", pattern: /not found|NOT_FOUND|revoked|no such/iu, headline: "The thing the tool was asked to read does not exist, or is no longer available.", nextStep: "Use an id exactly as given in the task context or returned by knowledge.search; do not guess ids." },
  { cause: "script-failed", pattern: /tool exit \d+/iu, headline: "The tool's own script stopped with an error.", nextStep: "Open Test on this tool to run it again with the same input and read its error output." },
];

export function diagnoseToolFailure(message: string | undefined | null): ToolDiagnosis {
  const text = (message ?? "").trim();
  if (!text) return { cause: "no-result", headline: "The call never recorded a result: the attempt ended or the call was refused before the tool ran.", nextStep: "Open the run's logs to see how the attempt ended; a budget or allowlist refusal ends here." };
  for (const rule of RULES) if (rule.pattern.test(text)) return { cause: rule.cause, headline: rule.headline, nextStep: rule.nextStep };
  return { cause: "unknown", headline: "The tool reported an error this view does not recognise.", nextStep: "Read the message below and open the run's logs." };
}
