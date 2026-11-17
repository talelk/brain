import { Show, type JSX } from "solid-js";
import { DataTable, type DataTableColumn } from "@talelk/newui-organisms";

/** What a table lets a person do to several rows at once (a wide screen only: the library's phone selection bar is English only). */
export interface Bulk<T> { readonly label: string; readonly summary: (count: number) => string; readonly eligible: (row: T) => boolean; readonly run: (ids: string[]) => void }

/**
 * A table of the design system's DataTable, without its own title, column menu and footer: the library writes those in English only
 * ("Columns", "0 selected", "1–4 of 4"), so the screen's heading says what the table is and `count` is its footer, in the page's language.
 * With `bulk`, rows get checkboxes and the library's own button (named by `bulk.label`) acts on the selected ones.
 */
export function Table<T extends { id: string }>(props: { title: string; rows: T[]; columns: DataTableColumn<T>[]; count: string; bulk?: Bulk<T>; emptyTitle?: string; emptyHint?: string; onClearFilters?: () => void }): JSX.Element {
  const bulk = (): Bulk<T> | undefined => (typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches ? props.bulk : undefined);
  return (
    <div class="plain-table max-w-full overflow-x-auto" data-bulk={bulk() ? "" : undefined}>
      <DataTable title={props.title} rows={props.rows} columns={props.columns} hideSearch selectable={bulk() !== undefined} density="comfortable" pageSize={Math.max(1, props.rows.length)}
        {...(bulk() ? { actionLabel: bulk()?.label, rowSelectable: bulk()?.eligible, onRowsAction: bulk()?.run, selectionSummary: (ids: string[]) => bulk()?.summary(ids.length) } : {})}
        {...(props.emptyTitle ? { emptyTitle: props.emptyTitle } : {})} {...(props.emptyHint ? { emptyHint: props.emptyHint } : {})} {...(props.onClearFilters ? { onClearFilters: props.onClearFilters } : {})} />
      <Show when={props.rows.length > 0}><p class="px-1 pt-2 t-small text-ink-3" role="status">{props.count}</p></Show>
    </div>
  );
}
