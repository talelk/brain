import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { InlineMarkdown, Markdown } from "./Markdown";
import { titleize } from "../format";
import { markdownFileName, resultMarkdown } from "./result-model";
import type { StructuredResult, TrustLine } from "./result-model";

const TONE: Record<TrustLine["tone"], { box: string; icon: string }> = {
  green: { box: "border-outline-green-2 bg-surface-green-1 text-ink-green-9", icon: "lucide-shield-check" },
  amber: { box: "border-outline-amber-2 bg-surface-amber-1 text-ink-amber-9", icon: "lucide-circle-alert" },
  red: { box: "border-outline-red-2 bg-surface-red-1 text-ink-red-9", icon: "lucide-circle-x" },
  gray: { box: "border-outline-gray-2 bg-surface-gray-1 text-ink-gray-7", icon: "lucide-clock" },
};

/** The one plain sentence about whether an independent reviewer checked the work. */
export function TrustNote(props: { trust: TrustLine; class?: string }): JSX.Element {
  return (
    <p class={`m-0 flex min-w-0 items-start gap-2 rounded-card border px-3 py-2 text-interface ${TONE[props.trust.tone].box} ${props.class ?? ""}`} data-testid="trust-line" data-checked={props.trust.checked ? "true" : "false"}>
      <span class={`${TONE[props.trust.tone].icon} mt-0.5 size-4 shrink-0`} aria-hidden="true" />
      <span class="min-w-0">{props.trust.text}</span>
    </p>
  );
}

const BASIS: Record<NonNullable<TrustLine["rows"]>[number]["basis"], string> = {
  deterministic: "Tests, files or hashes",
  human: "Human sign-off",
  model: "Model opinion (Unverified)",
  none: "Not supported",
};

/** "How this was checked": each criterion with its check basis, independence level L1-L3 and whether it passed. */
export function HowChecked(props: { rows: NonNullable<TrustLine["rows"]>; evidenceHref?: string }): JSX.Element {
  return (
    <details class="min-w-0 text-interface" data-testid="how-checked">
      <summary class="cursor-pointer text-ink-gray-8">How this was checked</summary>
      <ul class="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
        <For each={props.rows}>
          {(row) => (
            <li class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-outline-gray-1 pb-1.5" data-basis={row.basis}>
              <span class="min-w-0 break-words font-medium text-ink-gray-9">{titleize(row.criterionId)}</span>
              <span class={row.basis === "model" || row.basis === "none" ? "text-ink-amber-9" : "text-ink-gray-7"}>{BASIS[row.basis]}</span>
              <span class="text-caption text-ink-gray-6">{row.status} · independence {row.independence}</span>
              <Show when={props.evidenceHref}>{(href) => <a class="text-caption text-ink-blue-link underline focus-visible:focus-ring" data-testid="criterion-evidence" href={`${href()}#check-${encodeURIComponent(row.checkId)}`}>See the check</a>}</Show>
            </li>
          )}
        </For>
      </ul>
    </details>
  );
}

/**
 * A task's result read as a document: summary first, the deliverable rendered
 * as Markdown, then the checklist of acceptance criteria and the assumptions.
 * Copy and Download hand over the whole result as one .md file.
 */
export function ResultReader(props: { result: StructuredResult; title: string; trust?: TrustLine }): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  const markdown = () => resultMarkdown(props.result);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(markdown());
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  function download(): void {
    const url = URL.createObjectURL(new Blob([markdown()], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = markdownFileName(props.title);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const met = () => props.result.criteria.filter((row) => row.met).length;
  return (
    <article class="flex min-w-0 flex-col gap-5" data-testid="result-reader" aria-label={`Result: ${props.title}`}>
      <div class="flex min-w-0 flex-col gap-2">
        <Show when={props.trust}>{(trust) => <TrustNote trust={trust()} />}</Show>
        <Show when={props.trust?.rows?.length}><HowChecked rows={props.trust!.rows!} {...(props.trust!.evidenceHref ? { evidenceHref: props.trust!.evidenceHref } : {})} /></Show>
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" iconLeft={copied() ? "lucide-check" : "lucide-copy"} onClick={() => void copy()}>
            {copied() ? "Copied" : "Copy as Markdown"}
          </Button>
          <Button size="sm" variant="outline" iconLeft="lucide-download" onClick={download}>
            Download .md
          </Button>
        </div>
      </div>
      <Show when={props.result.summary.trim()}>
        <section class="min-w-0 rounded-card border border-outline-gray-2 bg-surface-gray-1 px-4 py-3" aria-label="Summary">
          <p class="m-0 text-caption font-medium uppercase tracking-wide text-ink-gray-6">Summary</p>
          <p class="m-0 mt-1 max-w-[72ch] text-base leading-relaxed text-ink-gray-9"><InlineMarkdown text={props.result.summary} /></p>
        </section>
      </Show>
      <Markdown text={props.result.deliverable} />
      <Show when={props.result.criteria.length > 0}>
        <section class="flex min-w-0 flex-col gap-2 border-t border-outline-gray-2 pt-4" aria-label="Criteria">
          <h4 class="m-0 text-base-medium text-ink-gray-9">
            Author's own checklist <span class="font-normal text-ink-gray-6">{met()} of {props.result.criteria.length} met</span>
          </h4>
          <ul class="m-0 flex list-none flex-col gap-2 p-0">
            <For each={props.result.criteria}>
              {(row) => (
                <li class="flex min-w-0 items-start gap-2.5" data-met={row.met ? "true" : "false"}>
                  <span class={`${row.met ? "lucide-circle-check text-ink-green-7" : "lucide-circle-x text-ink-red-7"} mt-1 size-4 shrink-0`} role="img" aria-label={row.met ? "Met" : "Not met"} />
                  <div class="min-w-0 max-w-[72ch]">
                    <p class="m-0 text-base text-ink-gray-9"><InlineMarkdown text={row.criterion} /></p>
                    <Show when={row.evidence}><p class="m-0 text-caption text-ink-gray-6"><InlineMarkdown text={row.evidence ?? ""} /></p></Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <Show when={props.result.assumptions.length > 0}>
        <section class="flex min-w-0 flex-col gap-1.5" aria-label="Assumptions">
          <h4 class="m-0 text-base-medium text-ink-gray-9">Assumptions made</h4>
          <ul class="m-0 flex max-w-[72ch] list-disc flex-col gap-1 ps-5 text-base text-ink-gray-7">
            <For each={props.result.assumptions}>{(row) => <li>{row}</li>}</For>
          </ul>
        </section>
      </Show>
    </article>
  );
}
