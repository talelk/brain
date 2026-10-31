import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { DataTable } from "@talelk/newui-organisms";
import type { DataTableColumn } from "@talelk/newui-organisms";
import { ActionBar } from "./PageLayout";

export function RecordCollection<T extends { id: string }>(props: {
  title: string;
  rows: T[];
  columns: DataTableColumn<T>[];
  recordsLabel?: string;
  onOpen: (id: string) => void;
  openLabel?: string;
  hasPrevious?: boolean;
  hasNext?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  pageLabel?: string;
  loading?: boolean;
  emptyTitle?: string;
}): JSX.Element {
  return <div class="brain-record-collection">
    <DataTable title={props.title} rows={props.rows} hideSearch selectable={false}
      cardBreakpoint="lg" recordsLabel={props.recordsLabel} loading={props.loading} emptyTitle={props.emptyTitle}
      columns={[...props.columns, {
        id: "open", header: "", enableSorting: false, meta: { mobile: "meta" },
        cell: (context) => <Button variant="outline" size="sm" iconRight="lucide-arrow-up-right" aria-label={`${props.openLabel ?? "Open"}: ${context.row.original.id}`} onClick={() => props.onOpen(context.row.original.id)}>
          {props.openLabel ?? "Open"}
        </Button>,
      }]} />
    <Show when={props.onPrevious || props.onNext}>
      <ActionBar label="Collection pages">
        <Button size="lg" variant="outline" disabled={!props.hasPrevious || props.loading} onClick={() => props.onPrevious?.()}>Previous</Button>
        <span class="self-center text-caption text-ink-gray-6">{props.pageLabel ?? "Server page"}</span>
        <Button size="lg" variant="outline" disabled={!props.hasNext || props.loading} onClick={() => props.onNext?.()}>Next</Button>
      </ActionBar>
    </Show>
  </div>;
}
