import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import type { ApprovalRequest } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { approvalQuery, auditQuery } from "../../data/governor";
import { ApprovalDetailScreen } from "../approvals";

export default function ApprovalDetailPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const params = useParams();
  const approvalId = () => params.id ?? "";
  const approval = createScopedRead<ApprovalRequest>({
    scope: app.scope,
    load: (_scope, signal) => approvalQuery(approvalId(), signal),
  });
  const history = createScopedRead<{ id: string; action: string; actorId: string; occurredAt: string }[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      if (!scope.workspaceId) return { snapshot: [], asOf: new Date(0).toISOString(), sourceWatermark: 0 };
      const loaded = await auditQuery(scope.workspaceId, signal);
      return {
        ...loaded,
        snapshot: loaded.snapshot.items.filter((entry) => entry.resourceId === params.id)
          .map((entry) => ({ id: entry.id, action: entry.action, actorId: entry.actorId, occurredAt: entry.occurredAt })),
      };
    },
  });
  const [message, setMessage] = createSignal("");
  return <div class="flex flex-col gap-field-gap">
    <Show when={message()}><p role="status" class="text-base text-ink-gray-7">{message()}</p></Show>
    <ApprovalDetailScreen approval={approval.state().data} state={approval.state()} asOf={approval.state().asOf}
      onRefresh={() => void approval.refresh({ force: true })} onBack={() => void navigate("/approvals")}
      history={history.state().data ?? []}
      onRevoke={async (reason) => {
        try {
          const result = await app.run("approval.revoke", { approvalId: approvalId(), reason });
          setMessage(result.detail);
          await approval.refresh({ force: true });
        } catch (e) { setMessage(e instanceof Error ? e.message : "Revocation failed."); }
      }}
      requireTwoFactor={app.identity()?.requireTwoFactor} verifyIdentity={app.verifyIdentity} submitDecision={app.submitDecision} checkDecision={app.checkDecision} />
  </div>;
}
