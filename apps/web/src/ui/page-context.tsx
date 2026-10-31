import { createContext, createEffect, createSignal, onCleanup, useContext } from "solid-js";
import type { JSX, ParentProps } from "solid-js";
import type { BreadcrumbItem } from "@talelk/newui-molecules";

export interface PageHeader {
  title: string;
  description?: string;
  breadcrumbs?: BreadcrumbItem[];
  actions?: JSX.Element;
}

const PageContext = createContext<ReturnType<typeof createSignal<PageHeader | undefined>>>();

export function PageHeaderProvider(props: ParentProps): JSX.Element {
  const header = createSignal<PageHeader | undefined>();
  return <PageContext.Provider value={header}>{props.children}</PageContext.Provider>;
}

export function usePageHeader() {
  const context = useContext(PageContext);
  if (!context) throw new Error("usePageHeader must be used inside PageHeaderProvider");
  return context[0];
}

export function BrainPage(props: ParentProps<PageHeader>): JSX.Element {
  const context = useContext(PageContext);
  if (!context) throw new Error("BrainPage must be used inside PageHeaderProvider");
  const setHeader = context[1];
  createEffect(() => {
    setHeader({
      title: props.title,
      description: props.description,
      breadcrumbs: props.breadcrumbs,
      actions: props.actions,
    });
  });
  onCleanup(() => setHeader(undefined));
  return props.children;
}
