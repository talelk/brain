import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import type { RunnerSnapshot } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { runnerQuery } from "../../data/governor";
import { RunnerDetailScreen } from "../workspace";
import { ActionFeedback } from "../../ui/components/ActionFeedback";
import { RunnerEnrollmentDialog } from "../../ui/components/RunnerEnrollmentDialog";

export default function RunnerDetailPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const params = useParams();
  const runnerId = () => params.id ?? "";
  const runner = createScopedRead<RunnerSnapshot>({
    scope: app.scope,
    load: (_scope, signal) => runnerQuery(runnerId(), signal),
    refreshMs: 15_000,
  });
  const [message, setMessage] = createSignal("");
  const [enrollOpen, setEnrollOpen] = createSignal(false);
  async function operate(action: "runner.drain" | "runner.quarantine", reason: string) {
    try {
      const result = await app.run(action, { runnerId: runnerId(), reason });
      setMessage(result.detail);
      await runner.refresh({ force: true });
    } catch (e) { setMessage(e instanceof Error ? e.message : "Runner operation failed."); }
  }
  async function control(action: "enable" | "disable" | "rotate" | "deregister", reason: string) {
    try {
      const result = await app.run("runner.control", { runnerId: runnerId(), action, reason });
      if (!result.accepted) throw new Error(result.detail);
      setMessage(action === "rotate" ? "Credentials revoked. Issue the one-use replacement token, then verify the runner before enabling it." : result.detail);
      if (action === "rotate") setEnrollOpen(true);
      await runner.refresh({ force: true });
    } catch (e) { setMessage(e instanceof Error ? e.message : "Runner operation failed."); }
  }
  return <div class="flex flex-col gap-3">
    <ActionFeedback message={message()} />
    <RunnerDetailScreen runner={runner.state().data} state={runner.state()}
      onRefresh={() => void runner.refresh({ force: true })} onBack={() => void navigate("/runners")}
      onDrain={(reason) => operate("runner.drain", reason)} onQuarantine={(reason) => operate("runner.quarantine", reason)}
      onControl={control} canOperate={Boolean(app.identity()?.actor.scopes.includes("runner:admin"))} />
    <RunnerEnrollmentDialog open={enrollOpen()} onClose={() => { setEnrollOpen(false); void runner.refresh({ force: true }); }} defaultGroup={runner.state().data?.group} runnerId={runnerId()} />
  </div>;
}
