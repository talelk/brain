import { createEffect, lazy, Show, type JSX } from "solid-js";
import { Navigate, Route, Router, useParams, type RouteSectionProps } from "@solidjs/router";
import { useQuery } from "./data/api";
import { connectLive } from "./data/live";
import { PlaceProvider, SessionProvider, useSession } from "./data/session";
import { t } from "./i18n";
import { Empty, Failure, Loading } from "./components/bits";
import { Shell } from "./components/Shell";
import { SignIn } from "./screens/SignIn";
import { Today } from "./screens/Today";

const Tasks = lazy(() => import("./screens/Tasks"));
const Task = lazy(() => import("./screens/Task"));
const Workspace = lazy(() => import("./screens/Workspace"));
const NewWorkspace = lazy(() => import("./screens/NewWorkspace"));
const Health = lazy(() => import("./screens/Health"));
const People = lazy(() => import("./screens/People"));

const LAST_KEY = "brain.workspace";
const remember = (slug: string): void => { try { localStorage.setItem(LAST_KEY, slug); } catch { /* a convenience only */ } };
const remembered = (): string | null => { try { return localStorage.getItem(LAST_KEY); } catch { return null; } };

/** `/`: the workspace this browser was last in, else the first one, else the page that makes one. */
function Landing(): JSX.Element {
  const session = useSession();
  const target = (): string => {
    const active = session.workspaces().filter((workspace) => workspace.status === "active");
    const last = active.find((workspace) => workspace.slug === remembered()) ?? active[0];
    return last ? `/w/${last.slug}` : "/new";
  };
  return <Navigate href={target()} />;
}

/** Everything under `/w/:slug`: finds the workspace among the person's own and frames its pages. */
function InWorkspace(props: RouteSectionProps): JSX.Element {
  const session = useSession();
  const params = useParams<{ slug: string }>();
  const summary = () => session.workspaces().find((workspace) => workspace.slug === params.slug);
  createEffect(() => { if (summary()) remember(params.slug); });
  return (
    <Show when={summary()} keyed fallback={<main class="mx-auto max-w-lg px-4 py-24"><Empty title={t("workspace.missing.title")} text={t("workspace.missing.text")}><a class="link" href="/">{t("workspace.missing.back")}</a></Empty></main>}>
      {(found) => <PlaceProvider summary={() => summary() ?? found}><Shell>{props.children}</Shell></PlaceProvider>}
    </Show>
  );
}

export function App(): JSX.Element {
  const setup = useQuery("setup.status", () => ({}));
  const me = useQuery("me", () => ({}));
  createEffect(() => connectLive(Boolean(me.data()?.user)));
  const refetch = (): void => { setup.refetch(); me.refetch(); };
  return (
    <Show when={setup.data() && me.data()} fallback={<div class="mx-auto max-w-md px-4 py-24"><Show when={setup.error() ?? me.error()} fallback={<Loading />}><Failure error={setup.error() ?? me.error()} retry={refetch} /></Show></div>}>
      <Show when={me.data()?.user} fallback={<SignIn setupRequired={setup.data()?.setupRequired ?? false} onDone={refetch} />}>
        {(user) => (
          <SessionProvider value={{ user, workspaces: () => me.data()?.workspaces ?? [], refetch }}>
            <Router>
              <Route path="/" component={Landing} />
              <Route path="/new" component={NewWorkspace} />
              <Route path="/w/:slug" component={InWorkspace}>
                <Route path="/" component={Today} />
                <Route path="/tasks" component={Tasks} />
                <Route path="/tasks/:taskId" component={Task} />
                <Route path="/workspace/:tab?/*name" component={Workspace} />
                <Route path="/health" component={Health} />
                <Route path="/people" component={People} />
              </Route>
              <Route path="*" component={Landing} />
            </Router>
          </SessionProvider>
        )}
      </Show>
    </Show>
  );
}
