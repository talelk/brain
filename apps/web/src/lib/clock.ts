import { createSignal, onCleanup, type Accessor } from "solid-js";

/** The time, read again every `everyMs`: what a running task's elapsed time counts from. */
export function useNow(everyMs = 5000): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), everyMs);
  onCleanup(() => clearInterval(timer));
  return now;
}
