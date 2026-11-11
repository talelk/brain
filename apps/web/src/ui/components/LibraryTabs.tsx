import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { TabButtons } from "@talelk/newui-molecules";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { librarySummary, type LibrarySummary } from "../../data/library";

export type LibraryTab = "overview" | "plays" | "find" | "documents" | "tools" | "review";

/**
 * The Library's places (ADR 0014): everything Brain can reuse, side by side. Overview shows the counts; Plays,
 * Knowledge, Documents, Tools and the Review inbox keep their own routes (`/w/:id/plays`, `/w/:id/knowledge`,
 * `/w/:id/knowledge/review`) and share this one tab bar, so they all read as parts of the same place. Counts come
 * from the Governor's `library.summary`; a count that has not loaded is simply not shown.
 */
export function LibraryTabs(props: { value: LibraryTab; trailing?: JSX.Element }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const summary = createScopedRead({
    scope: app.scope,
    load: async (scope, signal) => librarySummary(scope.workspaceId, signal),
    refreshMs: 15_000,
  });
  const count = (pick: (value: LibrarySummary) => number) => {
    const data = summary.state().data;
    return data ? ` (${pick(data)})` : "";
  };
  const go = (value: string) => {
    const base = `/w/${app.workspaceId()}`;
    const target = value === "overview" ? `${base}/library` : value === "plays" ? `${base}/plays` : value === "review" ? `${base}/knowledge/review` : value === "find" ? `${base}/knowledge` : `${base}/knowledge?tab=${value}`;
    void navigate(target);
  };
  return <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
    <div class="min-w-0 max-w-full overflow-x-auto" data-testid="library-tab-strip"><div class="w-max min-w-full [&_[role=radio]]:shrink-0 [&_[role=radio]]:whitespace-nowrap"><TabButtons label="Library places" value={props.value} onValueChange={go} options={[
      { value: "overview", label: "Overview" },
      { value: "plays", label: `Plays${count((data) => data.plays)}` },
      { value: "find", label: "Knowledge" },
      { value: "documents", label: `Documents${count((data) => data.documents)}` },
      { value: "tools", label: `Tools${count((data) => data.tools)}` },
      { value: "review", label: `Review inbox${count((data) => data.awaitingReview)}` },
    ]} /></div></div>
    {props.trailing}
  </div>;
}
