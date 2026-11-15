import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge } from "@talelk/newui-atoms";
import type { CriterionCheck, CriterionCoverage as Coverage, MissionJudge } from "@brain/contracts";
import { t, tn } from "../../i18n";

const OUTCOME = { passed: "signoff.check.passed", failed: "signoff.check.failed", incomplete: "signoff.check.incomplete" } as const;
const linked = (entry: Coverage): boolean => entry.checks.length > 0;

/**
 * What proves each mission success criterion (ADR 0034), shown before anyone signs off: the work serving it and the verified checks that
 * name it. A criterion no check names is "not linked to a check" however many other checks passed, and the owner is told so up front.
 * Advisory checks are a model's opinion: shown apart, never counted as proof, and a criterion the judge read nothing about says so.
 */
export function CriterionCoverage(props: { coverage: readonly Coverage[]; judge: MissionJudge }): JSX.Element {
  const unlinked = () => props.coverage.filter((entry) => !linked(entry)).length;
  const checkLine = (check: CriterionCheck) => t("signoff.criteria.check", { name: check.name, outcome: t(OUTCOME[check.outcome]) });
  return <Show when={props.coverage.length > 0}>
    <section class="flex min-w-0 flex-col gap-2" aria-label={t("signoff.criteria.title")} data-testid="signoff-criteria" data-unlinked={unlinked()}>
      <h4 class="m-0 text-base-medium text-ink-gray-9">{t("signoff.criteria.title")}</h4>
      <p class="m-0 text-interface text-ink-gray-7" data-testid="signoff-criteria-summary">{tn("signoff.criteria.summary", props.coverage.length, { linked: props.coverage.length - unlinked() })}</p>
      <Show when={unlinked() > 0}>
        <p class="m-0 flex min-w-0 items-start gap-2 rounded-card border border-outline-amber-2 bg-surface-amber-1 px-3 py-2 text-interface text-ink-amber-9" role="note" data-testid="signoff-unlinked-warning">
          <span class="lucide-circle-alert mt-0.5 size-4 shrink-0" aria-hidden="true" />{tn("signoff.criteria.warn", unlinked())}
        </p>
      </Show>
      <ul class="m-0 flex list-none flex-col gap-2 p-0">
        <For each={props.coverage}>{(entry) => <li class="flex min-w-0 flex-col gap-1 rounded-card border border-outline-gray-1 px-3 py-2 text-interface" data-testid="signoff-criterion" data-criterion-id={entry.criterionId} data-linked={linked(entry)}>
          <div class="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
            <span class="min-w-0 flex-1 break-words text-ink-gray-9">{entry.text}</span>
            <Show when={linked(entry)} fallback={<Badge size="sm" theme="amber" label={t("signoff.criteria.unlinked")} />}>
              <Badge size="sm" theme={entry.checks.some((check) => check.outcome !== "passed") ? "red" : "green"} label={entry.checks.some((check) => check.outcome !== "passed") ? t("signoff.criteria.notPassed") : t("signoff.criteria.linked")} />
            </Show>
          </div>
          <p class="m-0 break-words text-caption text-ink-gray-7" data-testid="signoff-criterion-work">
            {entry.workItems.length === 0 ? t("signoff.criteria.noWork") : t("signoff.criteria.work", { titles: entry.workItems.map((item) => item.title).join(", ") })}
          </p>
          <For each={entry.checks}>{(check) => <p class="m-0 break-words text-caption text-ink-gray-7" data-testid="signoff-criterion-check">{checkLine(check)}</p>}</For>
          <For each={entry.advisory}>{(check) => <p class="m-0 break-words text-caption text-ink-gray-6" data-testid="signoff-criterion-advisory">{t("signoff.criteria.advisory", { name: check.name, outcome: t(OUTCOME[check.outcome]) })}</p>}</For>
          <Show when={props.judge.state === "done" && entry.advisory.length === 0}>
            <p class="m-0 break-words text-caption text-ink-gray-6" data-testid="signoff-criterion-no-opinion">{t("signoff.criteria.noOpinion")}</p>
          </Show>
        </li>}</For>
      </ul>
    </section>
  </Show>;
}
