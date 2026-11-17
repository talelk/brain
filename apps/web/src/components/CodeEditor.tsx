import { createMemo, For, Show, type JSX } from "solid-js";
import type { Problem } from "@brain/contracts";

/** The line a problem names: "line 12" when the message says so, else the line that sets the key the message starts with (`limits.turns: …`). */
export function problemLine(text: string, message: string): number | undefined {
  const named = /\bline (\d+)/iu.exec(message);
  if (named) return Number(named[1]);
  const key = /^([A-Za-z0-9_.-]+): /u.exec(message)?.[1]?.split(".").filter((part) => !/^\d+$/u.test(part)).at(-1);
  if (!key) return undefined;
  const at = text.split("\n").findIndex((line) => new RegExp(`^\\s*(\\[+[^\\]]*\\b)?${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u").test(line));
  return at < 0 ? undefined : at + 1;
}

/**
 * A plain editor for a workspace file: monospace, line numbers, Tab indents, Shift+Tab outdents, and each problem of a refused save
 * shown beside the line it names. No editor library: a textarea whose gutter scrolls with it.
 */
export function CodeEditor(props: { value: string; onChange: (value: string) => void; label: string; problems?: readonly Problem[]; readOnly?: boolean; rows?: number; wrap?: boolean }): JSX.Element {
  let gutter: HTMLDivElement | undefined;
  const lines = createMemo(() => props.value.split("\n").length);
  const marked = createMemo(() => new Map((props.problems ?? []).flatMap((problem) => { const line = problemLine(props.value, problem.message); return line ? [[line, problem.message] as const] : []; })));
  const unplaced = (): readonly Problem[] => (props.problems ?? []).filter((problem) => problemLine(props.value, problem.message) === undefined);

  const onKeyDown = (event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }): void => {
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || props.readOnly) return;
    event.preventDefault();
    const area = event.currentTarget;
    const { selectionStart: start, selectionEnd: end, value } = area;
    const from = value.lastIndexOf("\n", start - 1) + 1;
    if (start === end && !event.shiftKey) {
      area.setRangeText("  ", start, end, "end");
    } else {
      const block = value.slice(from, end);
      const next = event.shiftKey ? block.replace(/^ {1,2}/gmu, "") : block.replace(/^/gmu, "  ");
      area.setRangeText(next, from, end, "select");
    }
    props.onChange(area.value);
  };

  return (
    <div>
      <div class="editor t-code" data-wrap={props.wrap ? "" : undefined}>
        <Show when={!props.wrap}>
          <div ref={gutter} class="gutter" aria-hidden="true">
            <For each={Array.from({ length: lines() }, (_, index) => index + 1)}>{(line) => <div data-problem={marked().has(line)}>{line}</div>}</For>
          </div>
        </Show>
        <textarea aria-label={props.label} spellcheck={false} autocomplete="off" autocapitalize="off" wrap={props.wrap ? "soft" : "off"} readOnly={props.readOnly}
          rows={Math.min(Math.max(lines() + 1, props.rows ?? 12), 32)} value={props.value}
          onInput={(event) => props.onChange(event.currentTarget.value)} onKeyDown={onKeyDown} onScroll={(event) => { if (gutter) gutter.scrollTop = event.currentTarget.scrollTop; }} />
      </div>
      <Show when={(props.problems ?? []).length > 0}>
        <ul class="mt-2 flex flex-col gap-1 t-small text-bad" role="alert">
          <For each={[...marked()]}>{([line, message]) => <li><span class="t-code me-2 font-medium">{line}</span>{message}</li>}</For>
          <For each={unplaced()}>{(problem) => <li>{problem.message}</li>}</For>
        </ul>
      </Show>
    </div>
  );
}
