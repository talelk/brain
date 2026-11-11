/**
 * Steer a running task (#62): the instruction is first recorded as a
 * constraint of the mission brief, through the ordinary `mission.brief.edit`
 * command (which stores who wrote it and when), and only then delivered as the
 * session's advisory `session.steer`. Delivery is at-most-once and can be
 * lost; the brief record cannot, so a lost delivery never loses the
 * instruction. If the record cannot be made nothing is sent. The text is a
 * person's instruction and stays data: it is trimmed, bounded and flattened to
 * one line before it enters the brief, and it never reaches an evaluator
 * (evaluators are not given the brief).
 */

export interface SteerPorts {
  /** The mission's current brief, read fresh. */
  readBrief: () => Promise<{ version: number; constraints: readonly string[] }>;
  editBrief: (input: { baseVersion: number; constraints: string[] }) => Promise<{ accepted: boolean; detail: string }>;
  /** The session's own steer control; absent when the engine cannot be redirected. */
  deliver?: (message: string) => Promise<{ accepted: boolean; detail: string }>;
}

export interface SteerOutcome {
  recorded: boolean;
  delivered: boolean;
  /** What to tell the person, in plain words. */
  message: string;
}

const MAX_CONSTRAINT_CHARS = 1000;

/** The brief constraint an instruction becomes. */
export function steerConstraint(text: string, at: Date): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const stamp = at.toISOString().slice(0, 16).replace("T", " ");
  const room = MAX_CONSTRAINT_CHARS - `Steering (${stamp} UTC): `.length;
  return `Steering (${stamp} UTC): ${flat.length > room ? `${flat.slice(0, room - 1)}…` : flat}`;
}

export async function steerSession(ports: SteerPorts, text: string, now: Date = new Date()): Promise<SteerOutcome> {
  const constraint = steerConstraint(text, now);
  let detail = "";
  let recorded = false;
  // One retry: the brief may have moved between the read and the edit.
  for (let attempt = 0; attempt < 2 && !recorded; attempt += 1) {
    try {
      const brief = await ports.readBrief();
      const result = await ports.editBrief({ baseVersion: brief.version, constraints: [...brief.constraints, constraint] });
      recorded = result.accepted;
      detail = result.detail;
    } catch (cause) {
      detail = cause instanceof Error ? cause.message : "the brief could not be read";
    }
  }
  if (!recorded) return { recorded: false, delivered: false, message: `Not recorded and not sent: ${detail}` };
  if (!ports.deliver) return { recorded: true, delivered: false, message: "Saved to the mission brief. This agent cannot be redirected while it works, so it applies from its next task." };
  try {
    const sent = await ports.deliver(text);
    if (sent.accepted) return { recorded: true, delivered: true, message: "Saved to the mission brief and sent to the agent; it applies at its next turn." };
    return { recorded: true, delivered: false, message: `Saved to the mission brief, but the agent was not reached (${sent.detail}). It applies from its next task.` };
  } catch (cause) {
    return { recorded: true, delivered: false, message: `Saved to the mission brief, but the agent was not reached (${cause instanceof Error ? cause.message : "delivery failed"}). It applies from its next task.` };
  }
}
