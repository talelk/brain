import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useParams } from "@solidjs/router";
import type { SessionView } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { sessionQuery } from "../../data/governor";
import { SessionFeed } from "../../ui/components/SessionFeed";

export default function SessionDetailPage(): JSX.Element {
  const app = useApp();
  const params = useParams();
  const sessionId = () => params.id ?? "";
  const session = createScopedRead<SessionView>({
    scope: app.scope,
    load: (scope, signal) => sessionQuery(scope.workspaceId, sessionId(), signal),
    refreshMs: 5_000,
  });
  const [message, setMessage] = createSignal("");
  return <div class="flex flex-col gap-field-gap">
    <Show when={message()}><p role="status" class="text-base text-ink-gray-7">{message()}</p></Show>
    <SessionFeed sessionId={sessionId()} session={session.state().data} state={session.state()}
      onRefresh={() => void session.refresh({ force: true })}
      onSteer={async (messageText) => {
        try {
          const result = await app.run("session.steer", { sessionId: sessionId(), message: messageText });
          setMessage(result.detail);
        } catch (e) { setMessage(e instanceof Error ? e.message : "Steering was refused."); }
      }}
      onStop={async (reason) => {
        try {
          const result = await app.run("session.stop", { sessionId: sessionId(), reason });
          setMessage(result.detail);
          await session.refresh({ force: true });
        } catch (e) { setMessage(e instanceof Error ? e.message : "Stop was refused."); }
      }} />
  </div>;
}
