import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Badge, KeyValue } from "@talelk/newui-atoms";
import { Alert, Pagination } from "@talelk/newui-molecules";
import { StatGrid } from "@talelk/newui-organisms";
import type { PlacementExplanation } from "@brain/contracts";
import { statusTheme } from "./StatusBadge";
import { DateText } from "../screen-region";

const REASON_COPY: Record<string, string> = {
  READY: "A runner can take this job now.",
  WAITING_FOR_RUNNER: "No runner has registered the required capability and capacity.",
  INSUFFICIENT_CAPACITY: "Registered runners are reserved beyond this job's demand.",
};

const PAGE_SIZE = 25;

/**
 * Why a run is where it is (document 21 "job placement explanations").
 *
 * It renders the server's authoritative reason plus every ranked runner's
 * eligibility, so a user never has to guess whether the blocker is capacity,
 * capability or a configuration mismatch.
 */
export function PlacementPanel(props: { explanation?: PlacementExplanation; error?: string }): JSX.Element {
  const explanation = () => props.explanation;
  const [page, setPage] = createSignal(1);
  const runners = () => [...explanation()?.runners ?? []];
  const pageCount = () => Math.max(1, Math.ceil(runners().length / PAGE_SIZE));
  const currentPage = () => Math.min(Math.max(1, page()), pageCount());
  const visibleRunners = () => runners().slice((currentPage() - 1) * PAGE_SIZE, currentPage() * PAGE_SIZE);
  return (
    <Show when={explanation()} fallback={<Alert theme="gray" variant="outline" title="Placement not evaluated" description={props.error ?? "The Governor has not returned a placement for this run yet."} />}>
      <div class="flex flex-col gap-field-gap">
        <KeyValue label="Primary reason" value={<Badge theme={statusTheme("placement", explanation()!.primaryReason)} label={explanation()!.primaryReason} />} />
        <p class="text-base text-ink-gray-8">{REASON_COPY[explanation()!.primaryReason] ?? explanation()!.primaryReason}</p>
        <StatGrid compact columns={2} stats={[
          { label: "Evaluated", value: <DateText value={explanation()!.evaluatedAt} /> },
          { label: "Eligible runners", value: String(explanation()!.runners.filter((r) => r.eligible).length) },
        ]} />
        <Show when={explanation()!.runners.length} fallback={<Alert theme="amber" variant="outline" title="No runners registered" description="Enroll a runner that matches this job's capability and resource demand." />}>
          <table class="w-full text-left text-base">
            <caption class="sr-only">Runner eligibility for this placement</caption>
            <thead><tr class="border-b border-outline-gray-2 text-caption text-ink-gray-7">
              <th scope="col" class="py-1">Runner</th><th scope="col" class="py-1">Eligible</th><th scope="col" class="py-1">Reasons</th>
            </tr></thead>
            <tbody>
              <For each={visibleRunners()}>{(runner) => (
                <tr class="border-b border-outline-gray-1">
                  <td class="py-1"><code class="break-all">{runner.runnerId}</code></td>
                  <td><Badge theme={runner.eligible ? "green" : "gray"} label={runner.eligible ? "Yes" : "No"} /></td>
                  <td class="py-1 text-caption text-ink-gray-7"><span class="break-words">{runner.reasons.join(", ") || "none"}</span></td>
                </tr>
              )}</For>
            </tbody>
          </table>
          <Show when={runners().length > PAGE_SIZE}>
            <Pagination.Root aria-label="Runner eligibility pages" count={runners().length} pageSize={PAGE_SIZE} page={currentPage()} onPageChange={setPage} class="mt-4 flex-wrap items-center gap-3">
              <Pagination.Range class="me-auto" />
              <Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger />
            </Pagination.Root>
          </Show>
        </Show>
      </div>
    </Show>
  );
}
