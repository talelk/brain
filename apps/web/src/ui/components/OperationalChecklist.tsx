import { For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import type { OperationalReadiness } from "@brain/contracts";
import { useApp } from "../app-context";
import { governor } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { DateText, ScreenRegion } from "../screen-region";
import { titleize } from "../format";
import { StatusBadge } from "./StatusBadge";
import { WorkspaceSection } from "./Domain";
import { StatGrid } from "@talelk/newui-organisms";
/** The doctor's readiness read, shared by the guided setup (next step) and the full checklist (every check). */
export function createReadiness() {
  const app = useApp();
  return createScopedRead<OperationalReadiness>({ scope: app.scope,
    load: async (scope, signal) => {
      const snapshot = await governor<OperationalReadiness>(`/v1/doctor?workspaceId=${encodeURIComponent(scope.workspaceId)}`, undefined, signal);
      return { snapshot, asOf: snapshot.asOf, sourceWatermark: 0 };
    }, refreshMs: 15000,
  });
}

export function OperationalChecklist(props: { check?: ReturnType<typeof createReadiness> }) {
  const app = useApp();
  const navigate = useNavigate();
  const check = props.check ?? createReadiness();
  const needsAdministrator = (item: OperationalReadiness["checks"][number]) => ["release", "runners", "model"].includes(item.action ?? "") && !app.identity()?.actor.scopes.includes("config:activate");
  const action = (item: OperationalReadiness["checks"][number]) => {
    if (item.action === "model") return "/settings?tab=setup";
    if (item.action === "runners") return "/runners";
    if (item.action === "release") return "/settings?tab=release";
    return `/plays/${encodeURIComponent(item.workflowId ?? "")}`;
  };
  const group = (item: OperationalReadiness["checks"][number]) => item.action === "model" ? "Supported model" : item.action === "runners" ? "Runners" : item.action === "release" ? "Configuration release" : "Workflow verification";
  const actionLabel = (item: OperationalReadiness["checks"][number]) => item.status === "ready" ? "View issue" : item.action === "model" || item.action === "release" ? "Configure" : item.action === "smoke" ? "Test" : "View issue";

  return <WorkspaceSection title="Workspace and platform setup" description="Readiness is verified per prerequisite. Each action opens the owning flow instead of repeating a generic Resolve control.">
    <ScreenRegion state={check.state()} onRetry={() => void check.refresh()} emptyTitle="Readiness unavailable" emptyDescription="Select an accessible workspace.">
      <StatGrid compact stats={[
        { label: "Ready checks", value: String(check.state().data?.checks.filter((item) => item.status === "ready").length ?? 0), hint: "Verified by Governor", icon: "lucide-circle-check" },
        { label: "Missing gates", value: String(check.state().data?.checks.filter((item) => item.status === "missing").length ?? 0), hint: "Setup cannot be called ready", icon: "lucide-circle-alert" },
        { label: "Unverified", value: String(check.state().data?.checks.filter((item) => item.status === "unverified").length ?? 0), hint: "Requires real verification", icon: "lucide-circle-help" },
        { label: "Checked", value: <DateText value={check.state().data?.asOf} />, hint: "Governor observation time", icon: "lucide-clock-3" },
      ]} />
      <For each={["Identity and workspace", "Supported model", "Runners", "Configuration release", "Workflow verification"]}>{(name) => {
        const items = () => (check.state().data?.checks ?? []).filter((item) => name === "Identity and workspace" ? !item.action : group(item) === name);
        return <Show when={items().length}><section aria-label={name}><h3 class="mb-2 text-caption font-semibold uppercase tracking-wider text-ink-gray-6">{name}</h3><div class="brain-queue"><For each={items()}>{(item) => <div class="grid gap-2 border-b border-outline-gray-1 py-3 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center"><StatusBadge kind="check" status={item.status === "ready" ? "passed" : item.status} /><div class="min-w-0"><h4 class="break-words text-base-medium">{titleize(item.id)}</h4><p class="mt-1 break-words text-interface text-ink-gray-7">{item.detail}</p><p class="mt-1 break-words text-caption text-ink-gray-6">Next: {item.nextAction}</p></div><Button variant="outline" disabled={needsAdministrator(item)} onClick={() => void navigate(action(item))}>{needsAdministrator(item) ? "Administrator needed" : actionLabel(item)}</Button></div>}</For></div></section></Show>;
      }}</For>
    </ScreenRegion>
  </WorkspaceSection>;
}
