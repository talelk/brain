import { GovernorError } from "../../data/client";
import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { AuditEntry, ConfigExplanation, HealthView, MemberGrantView, WorkspaceContext } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { auditQuery, configExplainQuery, healthQuery, membersQuery, workspaceContextQuery } from "../../data/governor";
import { SettingsScreen } from "../settings";
import { ActionFeedback } from "../../ui/components/ActionFeedback";

export default function SettingsPage(): JSX.Element {
  const app = useApp();
  const settings = createScopedRead<{ members: MemberGrantView[]; audit: AuditEntry[]; health?: HealthView }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const [members, audit, health] = await Promise.all([
        membersQuery(scope.workspaceId, signal),
        auditQuery(scope.workspaceId, signal),
        healthQuery(signal).catch((error: unknown) => { if (error instanceof GovernorError && (error.status === 401 || error.status === 403)) throw error; return undefined; }),
      ]);
      return {
        asOf: audit.asOf, sourceWatermark: audit.sourceWatermark, partialFailures: health ? [] : ["Platform health is unavailable"],
        snapshot: { members: [...members.snapshot.items], audit: [...audit.snapshot.items], health: health?.snapshot },
      };
    },
    isEmpty: (data) => data.members.length === 0 && data.audit.length === 0,
    refreshMs: 30_000,
  });
  const context = createScopedRead<WorkspaceContext>({
    scope: app.scope,
    load: (scope, signal) => workspaceContextQuery(scope.workspaceId, signal),
  });
  const explanation = createScopedRead<ConfigExplanation>({
    scope: app.scope,
    load: (scope, signal) => configExplainQuery(scope.workspaceId, "/workflows", signal),
  });
  const [message, setMessage] = createSignal("");
  return <div class="flex flex-col gap-field-gap">
    <ActionFeedback message={message()} />
    <SettingsScreen workspaceId={app.workspaceId()}
      members={settings.state().data?.members ?? []} audit={settings.state().data?.audit ?? []}
      health={settings.state().data?.health} explanation={explanation.state().data}
      state={settings.state()} onRefresh={() => void settings.refresh({ force: true })}
      canAdminister={app.canAdminister()}
      onGrant={async (principalId, role, reason) => {
        const expectedVersion = Math.max(1, ...(settings.state().data?.members.map((member) => member.version) ?? []));
        const result = await app.run("member.grant", { principalId, role: role as "viewer" | "operator" | "workspace-lead" | "approver", reason }, { expectedVersion });
        setMessage(result.detail);
        await settings.refresh({ force: true });
      }}
      onRevoke={async (principalId, role, reason) => {
        const expectedVersion = Math.max(1, ...(settings.state().data?.members.map((member) => member.version) ?? []));
        const result = await app.run("member.revoke", { principalId, role: role as "viewer" | "operator" | "workspace-lead" | "approver", reason }, { expectedVersion });
        setMessage(result.detail);
        await settings.refresh({ force: true });
      }}
      onActivate={async (configDigest, expectedActiveDigest) => {
        const result = await app.run("config.activate", { configDigest, expectedActiveDigest });
        setMessage(result.detail);
        await Promise.all([settings.refresh({ force: true }), context.refresh({ force: true })]);
      }}
      activeConfigDigest={context.state().data?.release.configDigest}
      viewerId={app.identity()?.actor.actorId} viewerName={app.identity()?.displayName} />
  </div>;
}
