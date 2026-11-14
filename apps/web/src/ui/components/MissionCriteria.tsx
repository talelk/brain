import { For } from "solid-js";
import type { JSX } from "solid-js";
import { Badge } from "@talelk/newui-atoms";
import type { Mission } from "@brain/contracts";
import { t, tn } from "../../i18n";

/**
 * The mission's success criteria, always on the mission page (ADR 0034): the headline reads progress against the criteria, and each
 * criterion says whether the work serving it is done. A criterion no task serves says so instead of looking merely unfinished.
 */
export function MissionCriteria(props: { criteria: Mission["successCriteria"] }): JSX.Element {
  const covered = () => props.criteria.filter((criterion) => criterion.state === "covered").length;
  return <section class="flex min-w-0 flex-col gap-2" aria-label={t("mission.criteria.title")} data-testid="mission-criteria" data-covered={covered()} data-total={props.criteria.length}>
    <p class="text-base-medium" data-testid="mission-criteria-summary">{tn("mission.criteria.summary", props.criteria.length, { covered: covered() })}</p>
    <ul class="flex flex-col gap-1.5">
      <For each={props.criteria}>{(criterion) => <li class="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1 text-interface" data-testid="mission-criterion" data-criterion-id={criterion.criterionId} data-state={criterion.state}>
        <span class={`${criterion.state === "covered" ? "lucide-circle-check text-ink-green-8" : "lucide-circle text-ink-gray-6"} mt-0.5 size-4 shrink-0`} aria-hidden="true" />
        <span class="min-w-0 flex-1 break-words text-ink-gray-9">{criterion.text}</span>
        <Badge theme={criterion.state === "covered" ? "green" : "gray"} label={criterion.state === "covered" ? t("mission.criteria.covered") : t("mission.criteria.not-covered")} />
        <span class="basis-full ps-6 text-caption text-ink-gray-6">{criterion.serving.total === 0 ? t("mission.criteria.no-task") : tn("mission.criteria.tasks-done", criterion.serving.total, { done: criterion.serving.done })}</span>
      </li>}</For>
    </ul>
  </section>;
}
