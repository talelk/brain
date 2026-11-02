import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { useApp } from "../../ui/app-context";
import { readExecFilters, writeExecFilters, type ExecLogFilters } from "../../ui/exec/exec-filters";
import { ConsoleScreen } from "../../ui/console/ConsoleLayout";

/**
 * `/w/:id/live` — the product's primary screen (T60). The three-pane Live
 * console lands here by default while sessions or runs are active; the
 * selected session and the execution filters are carried in this route's URL,
 * so returning from approvals, evidence or a work item restores the console.
 */
export default function LivePage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = () => readExecFilters(searchParams);
  const requestedSession = () => filters().session;
  const patchUrl = (patch: Partial<ExecLogFilters>): void => {
    const next = writeExecFilters({ ...filters(), ...patch });
    setSearchParams({ session: requestedSession(), ...next });
  };
  return <ConsoleScreen workspaceId={app.workspaceId()} requestedSession={requestedSession()}
    filters={filters()} onFiltersChange={patchUrl}
    onSessionChange={(sessionId) => void navigate(sessionId ? `/w/${app.workspaceId()}/live?session=${encodeURIComponent(sessionId)}` : `/w/${app.workspaceId()}/live`)} />;
}
