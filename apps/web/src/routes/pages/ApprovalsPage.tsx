import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { ApprovalRequest } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { approvalsQuery } from "../../data/governor";
import { ApprovalsScreen } from "../approvals";

export default function ApprovalsPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const approvals = createScopedRead<ApprovalRequest[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await approvalsQuery({ workspaceId: scope.workspaceId }, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0,
    // No background poll: a refresh would replace the row objects and destroy
    // an open exact-review dialog mid-decision. Screens refresh explicitly
    // after actions, and the server rechecks authority at decision time.
  });
  return <ApprovalsScreen approvals={approvals.state().data ?? []} state={approvals.state()} asOf={approvals.state().asOf}
    active={app.canApprove()} onRefresh={() => void approvals.refresh({ force: true })}
    onOpen={(approvalId) => void navigate(`/approvals/${approvalId}`)}
    requireTwoFactor={app.identity()?.requireTwoFactor} verifyIdentity={app.verifyIdentity} submitDecision={app.submitDecision} checkDecision={app.checkDecision} />;
}
