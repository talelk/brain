import { createEffect, createMemo, createSignal, lazy, Show, Suspense, type JSX } from "solid-js";
import { Navigate, Route, Router, useLocation, useParams, type RouteSectionProps } from "@solidjs/router";
import { EmptyState } from "@talelk/newui-molecules";
import { Button } from "@talelk/newui-atoms";
import type { QueryOutputs } from "@brain/contracts";
import { useQuery } from "./data/api";
import { connectLive } from "./data/live";
import { PlaceProvider, recentGoals, SessionProvider, useSession } from "./data/session";
import { t } from "./i18n";
import { Failure, Loading, type LoadingShape } from "./components/bits";
import { remember, Shell } from "./components/Shell";
import { SignIn } from "./screens/SignIn";
import { linkFromAddress, Redeem } from "./components/Redeem";

const load = {
  overview: () => import("./screens/Overview"),
  today: () => import("./screens/Today"),
  tasks: () => import("./screens/Tasks"),
  task: () => import("./screens/Task"),
  workspace: () => import("./screens/Workspace"),
  newWorkspace: () => import("./screens/NewWorkspace"),
  health: () => import("./screens/Health"),
  people: () => import("./screens/People"),
  schedules: () => import("./screens/Schedules"),
  queue: () => import("./screens/Queue"),
  users: () => import("./screens/Users"),
  profile: () => import("./screens/Profile"),
  insights: () => import("./screens/Insights"),
  live: () => import("./screens/Live"),
  village: () => import("./screens/Village"),
};
const Overview = lazy(load.overview);
const Today = lazy(load.today);
const Queue = lazy(load.queue);
const Insights = lazy(load.insights);
const Live = lazy(load.live);
const Village = lazy(load.village);
const Tasks = lazy(load.tasks);
const Task = lazy(load.task);
const Workspace = lazy(load.workspace);
const NewWorkspace = lazy(load.newWorkspace);
const Health = lazy(load.health);
const People = lazy(load.people);
const Schedules = lazy(load.schedules);
const Users = lazy(load.users);
const Profile = lazy(load.profile);

/** The page's own code starts downloading with the first request, beside the questions of who is signed in, instead of after them. */
void (() => {
  const path = location.pathname;
  const chunk = path === "/" ? load.overview : path === "/new" ? load.newWorkspace : path === "/schedules" || path.endsWith("/schedules") ? load.schedules : path.endsWith("/insights") ? load.insights
    : /^\/w\/[^/]+\/?$/u.test(path) ? load.today : /\/tasks\/[^/]+/u.test(path) ? load.task : path.endsWith("/tasks") ? load.tasks : path.includes("/workspace") ? load.workspace
    : path.endsWith("/health") ? load.health : path.endsWith("/people") ? load.people : undefined;
  void chunk?.().catch(() => undefined);
})();

/** Once the page is up and the browser is idle, the other pages' code comes down too, so moving around never waits on a download. */
const idle = (work: () => void): void => { if ("requestIdleCallback" in window) window.requestIdleCallback(work); else setTimeout(work, 1500); };
idle(() => { for (const chunk of [load.today, load.tasks, load.task, load.workspace, load.schedules, load.health, load.people, load.overview]) void chunk().catch(() => undefined); });

const ME_KEY = "brain.me";
/** The last `me` this tab saw, so a reload paints the signed-in page at once and asks again behind it. */
const rememberedMe = (): QueryOutputs["me"] | undefined => { try { return JSON.parse(sessionStorage.getItem(ME_KEY) ?? "null") ?? undefined; } catch { return undefined; } };

/** Everything under `/w/:slug`: finds the workspace among the person's own and gives its pages the workspace to work in. */
function InWorkspace(props: RouteSectionProps): JSX.Element {
  const session = useSession();
  const params = useParams<{ slug: string }>();
  const summary = () => session.workspaces().find((workspace) => workspace.slug === params.slug);
  createEffect(() => { if (summary()) remember(params.slug); });
  return (
    <Show when={summary()} fallback={<EmptyState icon="lucide-folder-x" size="lg" title={t("workspace.missing.title")} description={t("workspace.missing.text")} action={<Button variant="outline" size="md" route="/">{t("workspace.missing.back")}</Button>} />}>
      {(found) => (
        <PlaceProvider summary={() => summary() ?? found()}>
          {props.children}
        </PlaceProvider>
      )}
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
  const location = useLocation();
  /** Which grey shape stands in for the page while its code and first answer come: by the address. */
  const shape = (): LoadingShape => {
    const path = location.pathname;
    if (path === "/" || path.endsWith("/health") || path.endsWith("/live") || path.endsWith("/village")) return "cards";
    if (path.endsWith("/tasks") || path.endsWith("/queue") || path.endsWith("/insights") || path.endsWith("/people") || path.endsWith("/schedules") || path === "/users") return "table";
    if (path.includes("/workspace") || path.includes("/tasks/")) return "split";
    return path === "/new" || /^\/w\/[^/]+\/?$/u.test(path) ? "form" : "lines";
  };
  return <Shell recent={recent()}><Suspense fallback={<Loading shape={shape()} />}>{props.children}</Suspense></Shell>;
}

export function App(): JSX.Element {
  const setup = useQuery("setup.status", () => ({}));
  const live = useQuery("me", () => ({}));
  const before = rememberedMe();
  /** The answer, else what this tab saw last, until the answer comes. */
  const me = (): QueryOutputs["me"] | undefined => live.data() ?? before;
  const overview = useQuery("overview", () => (me()?.user ? {} : undefined));
  createEffect(() => { const answer = live.data(); if (answer) try { if (answer.user) sessionStorage.setItem(ME_KEY, JSON.stringify(answer)); else sessionStorage.removeItem(ME_KEY); } catch { /* a convenience only */ } });
  createEffect(() => connectLive(Boolean(live.data()?.user)));
  const refetch = (): void => { setup.refetch(); live.refetch(); overview.refetch(); };
  // An invitation or reset link opens its own page, signed in or not.
  const [link, setLink] = createSignal(linkFromAddress());
  return (
    <Show when={link()} fallback={
    <Show when={me()?.user ? me() : setup.data() && live.data()} fallback={<div class="mx-auto max-w-md px-4 py-24"><Show when={setup.error() ?? live.error()} fallback={<Loading />}><Failure error={setup.error() ?? live.error()} retry={refetch} /></Show></div>}>
      <Show when={me()?.user} fallback={<SignIn setupRequired={setup.data()?.setupRequired ?? false} onDone={refetch} />}>
        {(user) => (
          <SessionProvider value={{ user, workspaces: () => me()?.workspaces ?? [], overview, refetch }}>
            <Router root={Frame}>
              <Route path="/" component={Overview} />
              <Route path="/new" component={NewWorkspace} />
              <Route path="/schedules" component={Schedules} />
              <Route path="/queue" component={Queue} />
              <Route path="/insights" component={Insights} />
              <Route path="/users" component={Users} />
              <Route path="/profile" component={Profile} />
              <Route path="/live" component={Live} />
              <Route path="/village" component={Village} />
              <Route path="/w/:slug" component={InWorkspace}>
                <Route path="/" component={Today} />
                <Route path="/tasks" component={Tasks} />
                <Route path="/tasks/:taskId" component={Task} />
                <Route path="/workspace/:tab?/*name" component={Workspace} />
                <Route path="/health" component={Health} />
                <Route path="/people" component={People} />
                <Route path="/schedules" component={Schedules} />
                <Route path="/queue" component={Queue} />
                <Route path="/insights" component={Insights} />
                <Route path="/live" component={Live} />
                <Route path="/village" component={Village} />
              </Route>
              <Route path="*" component={() => <Navigate href="/" />} />
            </Router>
          </SessionProvider>
        )}
      </Show>
    </Show>
    }>
      {(found) => <Redeem link={found()} signedInAs={me()?.user?.name} sessionId={me()?.user?.sessionId} onDone={() => { setLink(linkFromAddress()); refetch(); }} />}
    </Show>
  );
}
