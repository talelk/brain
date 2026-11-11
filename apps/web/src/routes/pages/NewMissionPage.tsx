import { createEffect, on } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { useApp } from "../../ui/app-context";
import { FormSheet } from "../../ui/components/BrainForm";
import { createStartController, StartFields } from "../../ui/start/StartBox";
import MissionsPage from "./MissionsPage";

/**
 * Start a mission (#43, #47): the same box as Today in a dialog over the
 * missions list. One sentence is enough; plays and earlier missions are chips.
 * Nothing runs until a person confirms the plan, and there is no mode to pick:
 * the dialog behaves identically on every open.
 */
export default function NewMissionPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  return <>
    <MissionsPage />
    <NewMissionSheet onClose={() => void navigate(`/w/${app.workspaceId()}/missions`)} />
  </>;
}

function NewMissionSheet(props: { onClose: () => void }): JSX.Element {
  const app = useApp();
  const [search] = useSearchParams();
  const start = createStartController();
  // A play page links here with ?play=…; its chip is then already picked.
  createEffect(on(() => start.playList().length, () => {
    if (typeof search.play === "string" && !start.playId() && start.playList().some((play) => play.playId === search.play)) start.pickPlay(search.play);
  }));
  return <FormSheet open onClose={props.onClose} title="New mission" centered description="Nothing runs until you confirm the plan."
    submit="Start mission" icon="lucide-flag" busy={start.busy()} disabled={!app.canDispatch()} onSubmit={start.start} error={start.error()} errorTitle="The mission was not started">
    <StartFields start={start} onSubmit={() => void start.start()} />
    <p class="text-caption text-ink-gray-7">You can refine the goal, criteria, budget and autonomy in the plan before anything runs.</p>
  </FormSheet>;
}
