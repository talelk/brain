import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import type { PlacementExplanation } from "@brain/contracts";
import { DateText } from "../screen-region";
import { t } from "../../i18n";
import { choiceView } from "./choice-sentences";

/**
 * Why the Governor chose this run's way of working, team member and model routes. Each choice is worded from the reason recorded when it was
 * made, with the facts it was judged by beneath it. A choice nobody made has no entry, so a run started by hand shows none.
 */
export function ChoiceReasons(props: { choices: PlacementExplanation["choices"] | undefined }): JSX.Element {
  return (
    <Show when={(props.choices?.length ?? 0) > 0} fallback={<p class="brain-empty-inline" data-testid="why-no-choices">{t("why.none")}</p>}>
      <ul class="m-0 flex list-none flex-col gap-3 p-0" data-testid="why-choices">
        <For each={props.choices}>{(choice) => {
          const view = choiceView(choice);
          return (
            <li class="rounded-control border border-outline-gray-1 p-3" data-choice-kind={choice.kind} data-choice-code={choice.code}>
              <p class="m-0 text-base text-ink-gray-9">{view.title}</p>
              <Show when={view.lines.length > 0}>
                <ul class="m-0 mt-2 list-disc ps-5 text-caption text-ink-gray-7">
                  <For each={view.lines}>{(line) => <li class="break-words">{line}</li>}</For>
                </ul>
              </Show>
              <p class="m-0 mt-2 text-caption text-ink-gray-6">{t("why.recorded")} <DateText value={choice.recordedAt} /></p>
            </li>
          );
        }}</For>
      </ul>
    </Show>
  );
}
