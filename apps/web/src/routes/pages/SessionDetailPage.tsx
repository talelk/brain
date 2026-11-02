import type { JSX } from "solid-js";
import { useNavigate, useParams, useSearchParams } from "@solidjs/router";
import { useApp } from "../../ui/app-context";
import { readExecFilters, writeExecFilters, type ExecLogFilters } from "../../ui/exec/exec-filters";
import { ConsoleScreen } from "../../ui/console/ConsoleLayout";

/**
 * `/sessions/:id` — the workspace-free deep link into the Live console (T60).
 * It renders exactly the same three-pane console as `/w/:id/live`; active
 * versus historical is state and available controls, not a second layout.
 * Switching sessions from here navigates within this route, keeping filters.
 */
export default function SessionDetailPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = () => readExecFilters(searchParams);
  const patchUrl = (patch: Partial<ExecLogFilters>): void => {
    setSearchParams({ session: params.id, ...writeExecFilters({ ...filters(), ...patch }) });
  };
  return <ConsoleScreen workspaceId={app.workspaceId()} requestedSession={params.id}
    filters={filters()} onFiltersChange={patchUrl}
    onSessionChange={(sessionId) => {
      if (!sessionId) return;
      const written = Object.entries(writeExecFilters({ ...filters(), session: undefined })).filter((entry): entry is [string, string] => entry[1] !== undefined);
      const query = new URLSearchParams(written).toString();
      void navigate(`/sessions/${sessionId}${query ? `?${query}` : ""}`);
    }} />;
}
