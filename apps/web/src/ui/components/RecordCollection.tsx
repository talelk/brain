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
}): JSX.Element {
  return <div class="brain-record-collection">
    <DataTable title={props.title} rows={props.rows} columns={props.columns} hideSearch selectable
      cardBreakpoint="md" recordsLabel={props.recordsLabel} loading={props.loading}
      actionLabel={props.openLabel ?? "Open"} onRowsAction={(ids) => { if (ids[0]) props.onOpen(ids[0]); }} />
    <Show when={props.onPrevious || props.onNext}>
      <ActionBar label="Collection pages">
        <Button variant="outline" class="min-h-11" disabled={!props.hasPrevious || props.loading} onClick={() => props.onPrevious?.()}>Previous</Button>
        <span class="self-center text-caption text-ink-gray-6">{props.pageLabel ?? "Server page"}</span>
        <Button variant="outline" class="min-h-11" disabled={!props.hasNext || props.loading} onClick={() => props.onNext?.()}>Next</Button>
      </ActionBar>
    </Show>
  </div>;
}
