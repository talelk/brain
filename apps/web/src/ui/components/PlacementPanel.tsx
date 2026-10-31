import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import { Badge, KeyValue } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import { StatGrid } from "@talelk/newui-organisms";
import type { PlacementExplanation } from "@brain/contracts";
import { statusTheme } from "./StatusBadge";
import { DateText } from "../screen-region";

const REASON_COPY: Record<string, string> = {
  READY: "A runner can take this job now.",
  WAITING_FOR_RUNNER: "No runner has registered the required capability and capacity.",
  INSUFFICIENT_CAPACITY: "Registered runners are reserved beyond this job's demand.",
};

/**
 * Why a run is where it is (document 21 "job placement explanations").
 *
 * It renders the server's authoritative reason plus every ranked runner's
 * eligibility, so a user never has to guess whether the blocker is capacity,
 * capability or a configuration mismatch.
 */
export function PlacementPanel(props: { explanation?: PlacementExplanation; error?: string }): JSX.Element {
  const explanation = () => props.explanation;
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
              <For each={[...explanation()!.runners]}>{(runner) => (
                <tr class="border-b border-outline-gray-1">
                  <td class="py-1"><code>{runner.runnerId}</code></td>
                  <td><Badge theme={runner.eligible ? "green" : "gray"} label={runner.eligible ? "yes" : "no"} /></td>
                  <td class="py-1 text-caption text-ink-gray-7">{runner.reasons.join(", ") || "none"}</td>
                </tr>
              )}</For>
            </tbody>
          </table>
        </Show>
      </div>
    </Show>
  );
}
