import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { TodayItem } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { todayQuery } from "../../data/governor";
import { TodayScreen } from "../today";

export default function TodayPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const today = createScopedRead<TodayItem[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await todayQuery({ workspaceId: scope.workspaceId }, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 15_000,
  });
  return <TodayScreen items={today.state().data ?? []} state={today.state()} asOf={today.state().asOf}
    onRefresh={() => void today.refresh({ force: true })}
    onOpen={(item) => {
      if (item.type === "approval") void navigate(`/approvals/${item.resourceId}`);
      else if (item.type === "job") void navigate(`/jobs/${item.resourceId}`);
      else if (item.type === "incident") void navigate(`/incidents/${item.resourceId}`);
      else if (item.type === "sla") void navigate(`/w/${item.workspaceId}/support`);
      else void navigate(`/w/${item.workspaceId}/decisions`);
    }} />;
}
