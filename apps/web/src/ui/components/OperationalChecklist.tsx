import { For } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { Section } from "@talelk/newui-organisms";
import type { OperationalReadiness } from "@brain/contracts";
import { useApp } from "../app-context";
import { governor } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { ScreenRegion } from "../screen-region";
import { titleize } from "../format";


export function OperationalChecklist() {
  const app = useApp();
  const navigate = useNavigate();
  const check = createScopedRead<OperationalReadiness>({ scope: app.scope,
    load: async (scope, signal) => {
      const snapshot = await governor<OperationalReadiness>(`/v1/doctor?workspaceId=${encodeURIComponent(scope.workspaceId)}`, undefined, signal);
      return { snapshot, asOf: snapshot.asOf, sourceWatermark: 0 };
    }, refreshMs: 15000,
  });
  const needsAdministrator = (item: OperationalReadiness["checks"][number]) => ["release", "runners", "model"].includes(item.action ?? "") && !app.identity()?.actor.scopes.includes("config:activate");
  const action = (item: OperationalReadiness["checks"][number]) => {
    if (item.action === "model") return "/settings?tab=setup";
    if (item.action === "runners") return "/runners";
    if (item.action === "release") return "/settings?tab=release";
    return `/w/${app.workspaceId()}/workflows?selected=${encodeURIComponent(item.workflowId ?? "")}${item.action === "smoke" ? "&diagnostics=true" : ""}`;
  };

  return <Section title="Setup checklist" description="Each check leads to the place where you can resolve it." surface="card">
    <ScreenRegion state={check.state()} onRetry={() => void check.refresh()} emptyTitle="Readiness unavailable" emptyDescription="Select an accessible workspace.">
      <For each={check.state().data?.checks}>{(item) => <div class="flex flex-wrap items-center justify-between gap-control-gap border-b border-outline-gray-1 py-3 last:border-0">
        <div class="min-w-0 max-w-2xl"><strong>{titleize(item.id)}</strong><p class="text-base text-ink-gray-7">{item.detail}</p><p class="text-caption text-ink-gray-6">{item.nextAction}</p></div>
        <Button size="lg" variant="outline" disabled={needsAdministrator(item)} onClick={() => void navigate(action(item))}>{needsAdministrator(item) ? "Administrator needed" : item.status === "ready" ? "Inspect" : "Resolve"}</Button>
      </div>}</For>
    </ScreenRegion>
  </Section>;
}
