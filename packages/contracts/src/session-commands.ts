/**
 * What a session's machine principal may run (ADR 0032, ADR 0042). The principal's admitted commands are exactly the ones behind the
 * governed Brain tools, never whatever its role's scopes would also admit. Every command of the registry is classified here as admitted
 * (through a Brain tool) or refused (with the reason a session does not hold it); a test enumerates the whole registry, so a new command
 * must be added to one side before it can ship.
 */

/** The governed Brain tools of the runner, each one command (ADR 0042). The runner and the Governor read this one table. */
export const BRAIN_TOOL_COMMANDS = {
  "mission.propose-plan": "plan.propose",
  "mission.message-member": "mission.message.send",
  "mission.submit-handoff": "handoff.submit",
  "mission.comment": "workItem.comment",
  "mission.delegate": "session.delegate",
  "mission.ask": "mission.question.ask",
} as const;

/** The commands a session credential is admitted to run: the ones behind its Brain tools. */
export const SESSION_ADMITTED: ReadonlySet<string> = new Set(Object.values(BRAIN_TOOL_COMMANDS));

/** Commands a session credential is refused, grouped by why. Everything not admitted must be named here. */
export const SESSION_REFUSED = {
  /** Someone else's call: a person or the Governor moves, judges, accepts or confirms; a session reports and proposes. */
  decides: ["workItem.transition", "mission.proposeCompletion", "decision.accept", "mission.verdict.record", "mission.close", "plan.confirm", "plan.reject", "mission.reuse.decide", "result.challenge", "delegation.review", "knowledge.review", "knowledge.approveVerified", "capability.review", "play.proposal.review", "approval.decision", "approval.request", "approval.revoke"],
  /** What the mission is and how far it may go: owned by the person it runs for. */
  mission: ["mission.create", "mission.owner.transfer", "mission.pause", "mission.resume", "mission.policy.set", "mission.brief.edit", "mission.budget.set", "workItem.spendCap.raise", "workItem.details.set", "mission.seen", "mission.watch", "play.propose", "play.proposeFromMissions", "workspace.spendCap.set"],
  /** Work, sessions, documents and tools the Brain tools do not reach: the Governor starts and stops work, not the session. */
  work: ["workflow.dispatch", "workflow.cancel", "session.steer", "session.stop", "session.create", "session.resume", "session.checkpoint", "document.upload", "document.revise", "document.associate", "document.delete", "tool.propose", "capitalization.run", "job.reconcile", "automation.upsert", "automation.control", "pullRequest.refresh"],
  /** Configuration, library, membership and workspace or organization administration. */
  administration: ["standingTeam.create", "standingTeam.update", "standingTeam.archive", "configDraft.create", "configDraft.update", "configDraft.validate", "configDraft.test", "configDraft.publish", "integration.connect", "integration.verify", "integration.bind", "runner.control", "config.activate", "workspace.update", "workspace.control", "workspace.export", "workspace.import", "tool.publish", "memory.publish", "memory.revoke", "member.grant", "member.revoke", "organization.invitation.create", "organization.invitation.cancel", "organization.invitation.retry", "organization.member.role-grant", "organization.member.role-revoke", "organization.member.suspend", "organization.member.reactivate", "organization.session.revoke", "workspace.autonomyCeiling.set", "workspace.sessions.stopAll", "library.settings.set", "plays.addStarter", "workspace.wayOfWorking.set", "workspace.modelRoutes.set", "platform.drain.set", "knowledge.withdrawUnobserved", "workspace.effects.set", "workspace.queueLimit.set", "runnerGroup.set", "identity.oidc.set"],
} as const satisfies Record<string, readonly string[]>;

export const SESSION_REFUSED_COMMANDS: ReadonlySet<string> = new Set(Object.values(SESSION_REFUSED).flat());
