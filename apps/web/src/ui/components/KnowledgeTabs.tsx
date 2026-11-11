import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { TabButtons } from "@talelk/newui-molecules";
import { useApp } from "../app-context";

export type KnowledgeTab = "find" | "documents" | "tools" | "review";

/**
 * Knowledge's places (#43): scoped knowledge, workspace documents and trusted
 * tools on `/w/:id/knowledge`, and the candidate review queue on
 * `/w/:id/knowledge/review`.
 */
export function KnowledgeTabs(props: { value: KnowledgeTab; trailing?: JSX.Element }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const go = (value: string) => {
    const base = `/w/${app.workspaceId()}/knowledge`;
    void navigate(value === "review" ? `${base}/review` : value === "find" ? base : `${base}?tab=${value}`);
  };
  return <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
    <TabButtons label="Knowledge journeys" value={props.value} wrap onValueChange={go} options={[
      { value: "find", label: "Find & publish knowledge" }, { value: "documents", label: "Documents" },
      { value: "tools", label: "Tools" }, { value: "review", label: "Review inbox" },
    ]} />
    {props.trailing}
  </div>;
}
