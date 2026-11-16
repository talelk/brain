import { createMemo, For, Show, type JSX } from "solid-js";
import { artifactText, useLive } from "../data/api";
import { tn, t } from "../i18n";
import { parseDiff, type DiffLine } from "../lib/diff";
import { Details, Failure, Loading } from "./bits";

const TONE: Record<DiffLine["kind"], string> = { add: "bg-(--added)", del: "bg-(--removed)", context: "", hunk: "bg-lilac text-ink-3" };
const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "-", context: " ", hunk: "" };

/** A change to code, file by file: what was added and removed, each line marked by a sign as well as a tint. */
export function Diff(props: { text: string; open?: boolean }): JSX.Element {
  const files = createMemo(() => parseDiff(props.text));
  return (
    <Show when={files().length > 0} fallback={<p class="t-small text-ink-3">{t("diff.empty")}</p>}>
      <div class="flex flex-col gap-3">
        <For each={files()}>
          {(file) => (
            <Details open={props.open ?? files().length <= 3} class="rounded-xl border border-rule bg-sheet px-3 py-2.5"
              summary={<><span class="t-code code-ltr min-w-0 truncate text-ink">{file.path}</span><span class="ms-auto whitespace-nowrap ps-3 t-small font-normal" dir="ltr"><span class="text-ok">+{file.added}</span> <span class="text-bad">-{file.removed}</span><span class="sr-only"> {tn("diff.lines", file.added + file.removed)}</span></span></>}>
              <pre class="t-code code-ltr -mx-3 -mb-2.5 max-h-[28rem] overflow-auto border-t border-rule">
                <For each={file.lines}>{(line) => <span class={`block min-w-max px-3 ${TONE[line.kind]}`}><span class="inline-block w-4 select-none text-ink-3">{SIGN[line.kind]}</span>{line.text || " "}</span>}</For>
              </pre>
            </Details>
          )}
        </For>
      </div>
    </Show>
  );
}

/** The diff stored as an artifact: a working copy's patch, or the patch a pull request would open. */
export function ArtifactDiff(props: { digest: string; open?: boolean }): JSX.Element {
  const patch = useLive(() => props.digest, () => artifactText(props.digest));
  return <Show when={patch.data() !== undefined} fallback={<Show when={patch.error()} fallback={<Loading />}><Failure error={patch.error()} /></Show>}><Diff text={patch.data() ?? ""} open={props.open} /></Show>;
}
