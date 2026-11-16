import { createEffect, createMemo, lazy, Show, Suspense, type JSX } from "solid-js";
import { Navigate, Route, Router, useParams, type RouteSectionProps } from "@solidjs/router";
import { EmptyState } from "@talelk/newui-molecules";
import { Button } from "@talelk/newui-atoms";
import { useQuery } from "./data/api";
import { connectLive } from "./data/live";
import { PlaceProvider, recentGoals, SessionProvider, useSession } from "./data/session";
import { t } from "./i18n";
import { Failure, Loading } from "./components/bits";
import { remember, Shell } from "./components/Shell";
import { SignIn } from "./screens/SignIn";

const Overview = lazy(() => import("./screens/Overview"));
const Today = lazy(() => import("./screens/Today"));
const Tasks = lazy(() => import("./screens/Tasks"));
const Task = lazy(() => import("./screens/Task"));
const Workspace = lazy(() => import("./screens/Workspace"));
const NewWorkspace = lazy(() => import("./screens/NewWorkspace"));
const Health = lazy(() => import("./screens/Health"));
const People = lazy(() => import("./screens/People"));

/** Everything under `/w/:slug`: finds the workspace among the person's own and gives its pages the workspace to work in. */
function InWorkspace(props: RouteSectionProps): JSX.Element {
  const session = useSession();
  const params = useParams<{ slug: string }>();
  const summary = () => session.workspaces().find((workspace) => workspace.slug === params.slug);
  createEffect(() => { if (summary()) remember(params.slug); });
  return (
    <Show when={summary()} keyed fallback={<EmptyState icon="lucide-folder-x" size="lg" title={t("workspace.missing.title")} description={t("workspace.missing.text")} action={<Button variant="outline" size="md" route="/">{t("workspace.missing.back")}</Button>} />}>
      {(found) => <PlaceProvider summary={() => summary() ?? found}>{props.children}</PlaceProvider>}
    </Show>
  );
}

/** The signed-in app: the shell around whichever page the address names. */
function Frame(props: RouteSectionProps): JSX.Element {
  const session = useSession();
  const recent = createMemo(() => {
    const view = session.overview.data();
    return [
      ...(view?.needsYou ?? []).map((need) => ({ rootId: need.rootId, title: need.goalTitle, workspaceId: need.workspaceId })),
      ...(view?.running ?? []).map((run) => ({ rootId: run.rootId, title: run.goalTitle, workspaceId: run.workspaceId })),
      ...recentGoals(),
    ];
  });
  return <Shell recent={recent()}><Suspense fallback={<Loading />}>{props.children}</Suspense></Shell>;
}

export function App(): JSX.Element {
  const setup = useQuery("setup.status", () => ({}));
  const me = useQuery("me", () => ({}));
  const overview = useQuery("overview", () => (me.data()?.user ? {} : undefined));
  createEffect(() => connectLive(Boolean(me.data()?.user)));
  const refetch = (): void => { setup.refetch(); me.refetch(); overview.refetch(); };
  return (
    <Show when={setup.data() && me.data()} fallback={<div class="mx-auto max-w-md px-4 py-24"><Show when={setup.error() ?? me.error()} fallback={<Loading />}><Failure error={setup.error() ?? me.error()} retry={refetch} /></Show></div>}>
      <Show when={me.data()?.user} fallback={<SignIn setupRequired={setup.data()?.setupRequired ?? false} onDone={refetch} />}>
        {(user) => (
          <SessionProvider value={{ user, workspaces: () => me.data()?.workspaces ?? [], overview, refetch }}>
            <Router root={Frame}>
              <Route path="/" component={Overview} />
              <Route path="/new" component={NewWorkspace} />
              <Route path="/w/:slug" component={InWorkspace}>
                <Route path="/" component={Today} />
                <Route path="/tasks" component={Tasks} />
                <Route path="/tasks/:taskId" component={Task} />
                <Route path="/workspace/:tab?/*name" component={Workspace} />
                <Route path="/health" component={Health} />
                <Route path="/people" component={People} />
              </Route>
              <Route path="*" component={() => <Navigate href="/" />} />
            </Router>
          </SessionProvider>
        )}
      </Show>
    </Show>
  );
}
