import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { Alert } from "@talelk/newui-molecules";

export type FeedbackTone = "info" | "success" | "warning" | "error";

/**
 * The one inline feedback idiom: quiet text for outcomes, an Alert for
 * problems. Page wrappers and form components render their command results
 * through this instead of hand-rolled role="status"/role="alert" paragraphs.
 */
export function ActionFeedback(props: { message?: string | undefined; tone?: FeedbackTone; title?: string }): JSX.Element {
  const problem = () => props.tone === "error" || props.tone === "warning";
  return <Show when={props.message}>
    <Show when={problem()} fallback={<p role="status" class="text-base text-ink-gray-7">{props.message}</p>}>
      <Alert theme={props.tone === "error" ? "red" : "amber"} variant="outline" title={props.title ?? (props.tone === "error" ? "Action failed" : "Needs attention")} description={props.message} />
    </Show>
  </Show>;
}
