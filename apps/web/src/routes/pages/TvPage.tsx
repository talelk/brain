import { Match, Switch } from "solid-js";
import type { JSX } from "solid-js";
import { useParams } from "@solidjs/router";
import TvSupportPage from "./TvSupportPage";
import TvSrePage from "./TvSrePage";

/** `/tv/:play` (#43): the redacted read-only kiosk rendering of one Play view. */
export default function TvPage(): JSX.Element {
  const params = useParams();
  return <Switch fallback={<main class="grid min-h-screen place-items-center p-8 text-center"><h1 class="text-heading">No kiosk view for this play</h1></main>}>
    <Match when={params.play === "support"}><TvSupportPage /></Match>
    <Match when={params.play === "sre"}><TvSrePage /></Match>
  </Switch>;
}
