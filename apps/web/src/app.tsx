import { createSignal, For, Show, Suspense, lazy, onMount, onCleanup } from "solid-js";
import { Badge, Button, TextInput } from "@talelk/newui-atoms";
import { Select } from "@talelk/newui-molecules";
import type { KanbanColumn } from "@talelk/newui-organisms";
import { AppShell, PaneLayout } from "@talelk/newui-templates";
import type { IdentityView, SetupStatus, TodayItem } from "@brain/contracts";
import { command, governor, GovernorError, query } from "./data/client";
import { Authentication, AuthenticatorEnrollment } from "./ui/components/Authentication";
import { ApprovalReview } from "./ui/components/ApprovalReview";
import { ThemeToggle } from "./ui/components/ThemeToggle";
import type { ApprovalIntent, ApprovalOutcome } from "./ui/approval-controller";
import { visibleWindow } from "./ui/window-list";

interface ApprovalItem { approvalId: string; subjectDigest: string; version: number; state: string; subject: unknown; expiresAt: string }
interface JobItem { jobId: string; state: string; queueReasons?: string[] }
interface CardItem { cardId: string; id: string; title: string; status: string; criteria: string[]; version: number; evidenceDigest?: string }
interface ToolItem { id: string; status?: string; effectClass?: string }
interface MemberItem { principalId: string; roles: string[]; version: number; revoked: boolean }
interface RunnerItem { runnerId: string; group: string; adminState: string; displayStatus: string; connectivity: string; health: string }
interface WorkItem { id?: string; title?: string; state?: string; status?: string; summary?: string; decision?: string; note?: string }
type Area = "today" | "runs" | "approvals" | "board" | "work" | "knowledge" | "settings";
const AREAS: Area[] = ["today", "runs", "approvals", "board", "work", "knowledge", "settings"];
const BOARD_STATES = [
  { id: "to-decide", name: "To decide" }, { id: "todo", name: "Todo" },
  { id: "in-progress", name: "In progress" }, { id: "verifying", name: "Verifying" },
  { id: "done", name: "Done" }, { id: "blocked", name: "Blocked" },
] as const;
// KanbanBoard (drag engine included) is route-split so the initial shell
// stays inside the 250 KiB gzip budget; it loads only on the Board area.
const KanbanBoard = lazy(async () => {
  const m = await import("@talelk/newui-organisms");
  return { default: m.KanbanBoard };
});

function areaFromHash(): Area {
  const raw = window.location.hash.replace(/^#\//, "");
  return (AREAS as string[]).includes(raw) ? (raw as Area) : "today";
}

export function App() {
  const [identity, setIdentity] = createSignal<IdentityView | null>(null);
  const [setupRequired, setSetupRequired] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [workspace, setWorkspace] = createSignal("");
  const [approvals, setApprovals] = createSignal<ApprovalItem[]>([]);
  const [jobs, setJobs] = createSignal<JobItem[]>([]);
  const [today, setToday] = createSignal<TodayItem[]>([]);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [area, setArea] = createSignal<Area>(areaFromHash());
  const [cards, setCards] = createSignal<CardItem[]>([]);
  const [tools, setTools] = createSignal<ToolItem[]>([]);
  const [members, setMembers] = createSignal<MemberItem[]>([]);
  const [runners, setRunners] = createSignal<RunnerItem[]>([]);
  const [opsReason, setOpsReason] = createSignal("");
  const [decisions, setDecisions] = createSignal<WorkItem[]>([]);
  const [tickets, setTickets] = createSignal<WorkItem[]>([]);
  const [incidents, setIncidents] = createSignal<WorkItem[]>([]);
  const [delivery, setDelivery] = createSignal<WorkItem[]>([]);
  const [detail, setDetail] = createSignal<{ title: string; body: string } | null>(null);
  const tvMode = new URLSearchParams(window.location.search).has("tv");
  const [health, setHealth] = createSignal("");
  const [memoryText, setMemoryText] = createSignal("");
  const [memoryResults, setMemoryResults] = createSignal<Array<{ text?: string; status?: string }>>([]);
  const [evidenceByCard, setEvidenceByCard] = createSignal<Record<string, string>>({});
  const [now, setNow] = createSignal(Date.now());
  const [runsScrollTop, setRunsScrollTop] = createSignal(0);
  const RUN_ROW_PX = 52;
  const runsWindow = () => visibleWindow(jobs(), runsScrollTop(), RUN_ROW_PX, 480);
  let generation = 0; let pending: AbortController | undefined;

  function clearProtected() {
    generation++; pending?.abort(); setLoading(false); setApprovals([]); setJobs([]); setToday([]);
    setCards([]); setTools([]); setMembers([]); setRunners([]); setMemoryResults([]); setEvidenceByCard({}); setDecisions([]); setTickets([]); setIncidents([]); setDelivery([]); setDetail(null);
  }

  async function refresh() {
    generation++; pending?.abort();
    const selected = workspace(); const current = generation;
    if (!identity() || !selected) return;
    pending = new AbortController(); const signal = pending.signal; setLoading(true);
    try {
      if (tvMode) {
        const [td, jl] = await Promise.all([
          query<{ snapshot: { items: TodayItem[] } }>({ queryType: "today", workspaceId: selected }, signal),
          query<{ snapshot: { items: JobItem[] } }>({ queryType: "jobs.list", workspaceId: selected }, signal),
        ]);
        if (current === generation) { setToday(td.snapshot.items.filter((item) => item.workspaceId === selected)); setJobs(jl.snapshot.items); }
      } else if (area() === "approvals") {
        const result = await query<{ snapshot: { items: ApprovalItem[] } }>({ queryType: "approvals.list", workspaceId: selected }, signal);
        if (current === generation) setApprovals(result.snapshot.items);
      } else if (area() === "runs") {
        const result = await query<{ snapshot: { items: JobItem[] } }>({ queryType: "jobs.list", workspaceId: selected }, signal);
        if (current === generation) setJobs(result.snapshot.items);
      } else if (area() === "board") {
        const result = await query<{ snapshot: { cards: Array<{ cardId: string; title: string; state: string; criteria: Array<{ id: string; text: string; status: string }>; version: number; evidenceDigest?: string }> } }>({ queryType: "board.get", workspaceId: selected }, signal);
        if (current === generation) setCards(result.snapshot.cards.map((c) => ({ cardId: c.cardId, id: c.cardId, title: c.title, status: c.state, criteria: c.criteria.map((x) => x.text), version: c.version, evidenceDigest: c.evidenceDigest })));
      } else if (area() === "knowledge") {
        const result = await query<{ snapshot: { items: ToolItem[] } }>({ queryType: "tools.list", workspaceId: selected }, signal);
        if (current === generation) setTools(result.snapshot.items);
      } else if (area() === "work") {
        const list = async (queryType: "decisions.list" | "tickets.list" | "incidents.list" | "delivery.list") => (await query<{ snapshot: { items: WorkItem[] } }>({ queryType, workspaceId: selected }, signal)).snapshot.items;
        const [d, tk, inc, dl] = await Promise.all([list("decisions.list"), list("tickets.list"), list("incidents.list"), list("delivery.list")]);
        if (current === generation) { setDecisions(d); setTickets(tk); setIncidents(inc); setDelivery(dl); }
      } else if (area() === "settings") {
        const [h, m, r] = await Promise.all([
          query<{ snapshot: { services?: Array<{ id: string; status: string }> } }>({ queryType: "platform.health" }, signal),
          query<{ snapshot: { items: MemberItem[] } }>({ queryType: "members.list", workspaceId: selected }, signal),
          query<{ snapshot: { items: RunnerItem[] } }>({ queryType: "runners.list", workspaceId: selected }, signal),
        ]);
        if (current === generation) {
          setHealth((h.snapshot.services ?? []).map((s2) => `${s2.id}: ${s2.status}`).join(" · "));
          setMembers(m.snapshot.items);
          setRunners(r.snapshot.items);
        }
      } else {
        const result = await query<{ snapshot: { items: TodayItem[] } }>({ queryType: "today", workspaceId: selected }, signal);
        if (current === generation) setToday(result.snapshot.items.filter((item) => item.workspaceId === selected));
      }
      if (current === generation) setError("");
    } catch (e) {
      if (signal.aborted || current !== generation) return;
      if (e instanceof GovernorError && [401,403,404].includes(e.status)) clearProtected();
      if (e instanceof GovernorError && e.status === 401) { setIdentity(null); setWorkspace(""); }
      setError(e instanceof Error ? e.message : "Governor is unavailable. Refresh before taking action.");
    } finally { if (current === generation) setLoading(false); }
  }

  const [pushState, setPushState] = createSignal("");
  async function enablePush() {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) { setPushState("Push is not available in this browser."); return; }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setPushState("Notification permission was not granted."); return; }
      const registration = await navigator.serviceWorker.ready;
      const { publicKey } = await governor<{ publicKey: string }>("/v1/push/vapid-public-key");
      const keyBytes = Uint8Array.from(atob(publicKey.replace(/-/gu, "+").replace(/_/gu, "/")), (ch) => ch.charCodeAt(0));
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes as BufferSource });
      await governor("/v1/push/subscriptions", subscription.toJSON());
      setPushState("Notifications enabled for this browser.");
    } catch (e) {
      setPushState(e instanceof Error ? e.message : "Could not enable notifications.");
    }
  }

  async function runnerAction(runnerId: string, action: "runner.drain" | "runner.quarantine") {
    const reason = opsReason().trim();
    if (!reason) { setError("Give an operations reason before draining or quarantining a runner."); return; }
    try {
      await command({
        contractVersion: "brain.command/v1", commandId: `web-${crypto.randomUUID()}`, commandType: action,
        workspaceId: workspace(), idempotencyKey: `web-${crypto.randomUUID()}`,
        payload: { runnerId, reason },
      } as never);
      setOpsReason("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Runner operation failed.");
    }
  }

  async function showDetail(title: string, queryType: string, resourceId: string) {
    try {
      const result = await query<{ snapshot: unknown }>({ queryType, workspaceId: workspace(), resourceId } as never);
      setDetail({ title, body: JSON.stringify(result.snapshot, null, 2) });
    } catch (e) {
      setDetail({ title, body: e instanceof Error ? e.message : "Detail unavailable." });
    }
  }

  async function loadIdentity() {
    clearProtected();
    const current = generation;
    const next = await governor<IdentityView>("/v1/identity");
    if (current !== generation) return;
    setIdentity(next);
    if (!next.workspaces.some((w) => w.workspaceId === workspace())) setWorkspace(next.workspaces[0]?.workspaceId ?? "");
    setSetupRequired(false); await refresh();
  }

  async function start() {
    setReady(false); setError("");
    try {
      const status = await governor<SetupStatus>("/v1/setup/status"); setSetupRequired(status.setupRequired);
      if (status.initialized) {
        try { await loadIdentity(); }
        catch (e) { if (!(e instanceof GovernorError && (e.status === 401 || e.status === 403))) throw e; setIdentity(null); }
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Governor is unavailable."); }
    finally { setReady(true); }
  }

  onMount(() => {
    void start();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    // TV kiosk (?tv=1): unattended read-only board, refreshed on a fixed cadence.
    const kioskTimer = tvMode ? setInterval(() => void refresh(), 10_000) : undefined;
    const onHash = () => { const next = areaFromHash(); if (next !== area()) { setArea(next); void refresh(); } };
    window.addEventListener("hashchange", onHash);
    onCleanup(() => { clearInterval(timer); if (kioskTimer) clearInterval(kioskTimer); window.removeEventListener("hashchange", onHash); });
  });
  onCleanup(() => { pending?.abort(); });

  function selectWorkspace(value: string | null) { clearProtected(); setWorkspace(value ?? ""); void refresh(); }
  function navigate(value: Area) {
    setArea(value);
    window.history.replaceState(null, "", `#/${value}`);
    void refresh();
  }

  async function moveCard(card: CardItem, status: string) {
    const evidenceDigest = evidenceByCard()[card.cardId]?.trim();
    try {
      await command({
        contractVersion: "brain.command/v1", commandId: `web-${crypto.randomUUID()}`, commandType: "board.move",
        workspaceId: workspace(), idempotencyKey: `web-${crypto.randomUUID()}`, expectedVersion: card.version,
        payload: { cardId: card.cardId, status, ...(evidenceDigest ? { evidenceDigest } : {}) },
      } as never);
      setError("");
      await refresh();
    } catch (e) {
      await refresh();
      setError(e instanceof Error ? e.message : "Card move failed.");
    }
  }

  async function searchMemory() {
    const selected = workspace();
    const me = identity();
    if (!selected || !me || !memoryText().trim()) return;
    try {
      const result = await query<{ snapshot: { results: Array<{ text?: string; status?: string }> } }>({
        queryType: "memory.search", workspaceId: selected,
        memoryQuery: {
          contractVersion: "brain.memory/v1", queryId: `web-${crypto.randomUUID()}`,
          scope: { organizationId: me.actor.organizationId, visibility: "workspace", workspaceId: selected },
          query: memoryText().trim(), sourceTypes: ["chat", "skill", "wiki", "codegraph"], limit: 10, maxChars: 4000,
        },
      } as never);
      setMemoryResults(result.snapshot.results);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Memory search failed."); }
  }

  const boardColumns = (): KanbanColumn<CardItem>[] => BOARD_STATES.map((state) => ({
    id: state.id, name: state.name, theme: state.id === "done" ? "green" : state.id === "verifying" ? "amber" : "gray",
    items: cards().filter((c) => c.status === state.id),
  }));
  async function signOut() {
    clearProtected(); setIdentity(null); setWorkspace("");
    try { await governor("/api/auth/sign-out", {}); setError(""); }
    catch { setError("Sign-out could not be confirmed. Retry when Governor is available."); }
  }

  async function verifyIdentity(approvalId: string, subjectDigest: string, code: string): Promise<string> {
    const challenge = await governor<{ challengeId: string }>("/v1/step-up/challenges", { approvalId, subjectDigest });
    const evidence = await governor<{ evidenceId: string }>("/v1/step-up/verify", { challengeId: challenge.challengeId, code });
    return evidence.evidenceId;
  }

  async function submitDecision(intent: ApprovalIntent, stepUpEvidenceId: string): Promise<ApprovalOutcome> {
    try {
      await governor(`/v1/approvals/${intent.approvalId}/decision`, { contractVersion: "brain.approval-decision/v1", idempotencyKey: intent.idempotencyKey, decision: "approve", subjectDigest: intent.subjectDigest, expectedVersion: intent.expectedVersion, note: intent.note, stepUpEvidenceId });
      return "confirmed";
    } catch (e) {
      if (e instanceof GovernorError && e.status === 409) return "stale";
      if (e instanceof GovernorError && (e.status === 401 || e.status === 403)) return "denied";
      return "pending";
    }
  }

  async function checkDecision(intent: ApprovalIntent): Promise<ApprovalOutcome> {
    try {
      const result = await governor<{ status: string }>(`/v1/approvals/${intent.approvalId}/decision-status`, { idempotencyKey: intent.idempotencyKey });
      return result.status === "confirmed" ? "confirmed" : "pending";
    } catch { return "pending"; }
  }

  return <Show when={ready()} fallback={<main><h1>Keyrus Brain</h1><p role="status">Connecting to Governor…</p></main>}>
    <Show when={identity()} fallback={<>
      <Show when={error()}><p role="alert" class="p-4">{error()}</p></Show>
      <Authentication setupRequired={setupRequired()} onAuthenticated={loadIdentity} />
    </>}>
      <Show when={!tvMode} fallback={
        <main data-testid="tv-kiosk" class="p-8">
          <h1>Keyrus Brain — operations board</h1>
          <p role="status">{now() ? new Date(now()).toLocaleTimeString() : ""} · {jobs().length} runs · {today().length} items need attention</p>
          <Show when={today().length} fallback={<p>Nothing needs attention.</p>}>
            <For each={today()}>{(item) => <article class="border-b border-outline-gray-1 py-4"><h2>{item.title}</h2><p>{item.detail}</p></article>}</For>
          </Show>
          <h2>Recent runs</h2>
          <For each={jobs().slice(0, 10)}>{(job) => <p><Badge>{job.state}</Badge> {job.jobId}</p>}</For>
        </main>
      }>
      <AppShell brand="Keyrus Brain" title={{ today: "Today", runs: "Runs", approvals: "Approvals", board: "Board", work: "Work", knowledge: "Knowledge", settings: "Settings" }[area()]}
        headerActions={<ThemeToggle />}
        tenant={<Select label="Workspace" options={(identity()?.workspaces ?? []).map((w) => ({ value: w.workspaceId, label: w.name, description: w.status }))} value={workspace() || null} onValueChange={selectWorkspace} />}
        account={<><span>{identity()?.displayName}</span><Button onClick={() => void signOut()} class="min-h-11">Sign out</Button></>}
        navLabel="Workspace navigation" navigation={[{ items: [
          { label: "Today", active: area() === "today", onClick: () => navigate("today") },
          { label: "Runs", active: area() === "runs", onClick: () => navigate("runs") },
          { label: "Approvals", active: area() === "approvals", onClick: () => navigate("approvals") },
          { label: "Board", active: area() === "board", onClick: () => navigate("board") },
          { label: "Work", active: area() === "work", onClick: () => navigate("work") },
          { label: "Knowledge", active: area() === "knowledge", onClick: () => navigate("knowledge") },
          { label: "Settings", active: area() === "settings", onClick: () => navigate("settings") },
        ] }]}>
        <Show when={error()}><p role="alert">{error()}</p></Show>
        <Show when={!identity()?.totpEnrolled}><AuthenticatorEnrollment recoveryRequired={identity()?.recoveryRequired ?? false} onEnrolled={loadIdentity} /></Show>
        <Show when={workspace()} fallback={<p>No workspaces are assigned to this account. Ask an organization administrator to grant workspace access.</p>}>
          <Button onClick={() => void refresh()} loading={loading()} class="min-h-11">Refresh</Button>
          <Show when={detail()}>{(d) => (
            <PaneLayout active="end"
              start={<section aria-label="Record summary"><h2>{d().title}</h2><p>Exact Governor record. Close returns to the list without losing its scroll position.</p></section>}
              end={<section aria-label="Detail"><h2>{d().title}</h2><pre class="whitespace-pre-wrap break-words">{d().body}</pre><Button onClick={() => setDetail(null)} class="min-h-11">Close detail</Button></section>}
            />
          )}</Show>
          <Show when={area() === "today"}>
            <section aria-label="Needs your attention"><h2>Needs your attention</h2>
              <Show when={today().length} fallback={<p>No items currently need your attention.</p>}>
                <For each={today()}>{(item) => <article class="border-b border-outline-gray-1 py-3"><h3>{item.title}</h3><p>{item.detail}</p><Button onClick={() => navigate(item.type === "approval" ? "approvals" : "runs")} class="min-h-11">{item.nextAction}</Button></article>}</For>
              </Show>
            </section>
          </Show>
            <section hidden={area() !== "approvals"} aria-label="Approvals awaiting review"><h2>Approvals</h2>
              <Show when={approvals().length} fallback={<p>No approvals awaiting review.</p>}>
                <For each={approvals().map((item) => item.approvalId)}>{(id) => {
                  const a = () => approvals().find((item) => item.approvalId === id)!;
                  return <article class="border-b border-outline-gray-1 py-3">
                  <Badge>{a().state}</Badge><span> {id} · expires {a().expiresAt}</span>
                  <ApprovalReview active={area() === "approvals"} approvalId={id} targetLabel={id} exactContent={JSON.stringify(a().subject, null, 2)} subjectDigest={a().subjectDigest} version={a().version}
                    fresh={!loading() && !error() && a().state === "pending" && Date.parse(a().expiresAt) > now()} createIdempotencyKey={() => `web-${crypto.randomUUID()}`}
                    verifyIdentity={verifyIdentity} submitDecision={submitDecision} checkDecision={checkDecision} />
                </article>; }}</For>
              </Show>
            </section>
          <Show when={area() === "runs"}>
            <section aria-label="Runs"><h2>Runs</h2>
              <Show when={jobs().length} fallback={<p>No runs yet. Dispatch a declared workflow to see placement and progress here.</p>}>
                <div data-testid="runs-window" class="max-h-[480px] overflow-y-auto" onScroll={(e) => setRunsScrollTop(e.currentTarget.scrollTop)}>
                  <div style={{ height: `${runsWindow().topPadPx}px` }} />
                  <For each={runsWindow().items}>{(job) => <article class="flex h-[52px] items-center overflow-hidden border-b border-outline-gray-1"><Badge>{job.state}</Badge><span> {job.jobId}{job.queueReasons?.length ? ` — ${job.queueReasons.join(", ")}` : ""}</span><Button aria-label={`Details for run ${job.jobId}`} onClick={() => void showDetail(`Run ${job.jobId}`, "job.get", job.jobId)} class="min-h-11">Details</Button><Button aria-label={`Explain run ${job.jobId}`} onClick={() => void showDetail(`Placement for run ${job.jobId}`, "job.explain", job.jobId)} class="min-h-11">Explain</Button></article>}</For>
                  <div style={{ height: `${runsWindow().bottomPadPx}px` }} />
                </div>
                <p>Showing {runsWindow().end - runsWindow().start} of {runsWindow().total} runs.</p>
              </Show>
            </section>
          </Show>
          <Show when={area() === "board"}>
            <section aria-label="Board"><h2>Board</h2>
              <Show when={cards().length} fallback={<p>No cards yet. Cards appear here when work is planned for this workspace.</p>}>
                <Suspense fallback={<p>Loading board…</p>}>
                <KanbanBoard columns={boardColumns()} label="Workspace board" onMove={(move) => {
                  const card = cards().find((c) => c.cardId === move.itemId);
                  if (card && move.to.column !== card.status) void moveCard(card, move.to.column);
                }}>
                  {(card: CardItem) => (
                    <div>
                      <p>{card.title}</p>
                      <p>{card.criteria.join(", ")}{card.evidenceDigest ? " · evidence attached" : ""}</p>
                      <TextInput label={`Evidence digest for ${card.title}`} value={evidenceByCard()[card.cardId] ?? ""} onInput={(e) => setEvidenceByCard({ ...evidenceByCard(), [card.cardId]: e.currentTarget.value })} />
                      <For each={BOARD_STATES.filter((st) => st.id !== card.status)}>{(st) => (
                        <Button aria-label={`Move ${card.title} to ${st.name}`} onClick={() => void moveCard(card, st.id)} class="min-h-11">Move to {st.name}</Button>
                      )}</For>
                    </div>
                  )}
                </KanbanBoard>
                </Suspense>
              </Show>
            </section>
          </Show>
          <Show when={area() === "work"}>
            <section aria-label="Work"><h2>Work</h2>
              <h3>Decisions</h3>
              <Show when={decisions().length} fallback={<p>No recorded decisions yet.</p>}>
                <For each={decisions()}>{(d) => <article class="border-b border-outline-gray-1 py-3"><Badge>{d.state ?? d.status ?? "recorded"}</Badge><span> {d.title ?? d.summary ?? d.note ?? d.decision ?? d.id}</span></article>}</For>
              </Show>
              <h3>Support tickets</h3>
              <Show when={tickets().length} fallback={<p>No support tickets.</p>}>
                <For each={tickets()}>{(t2) => <article class="border-b border-outline-gray-1 py-3"><Badge>{t2.state ?? t2.status ?? "open"}</Badge><span> {t2.title ?? t2.summary ?? t2.id}</span><Button aria-label={`Details for ticket ${t2.title ?? t2.id}`} onClick={() => void showDetail(`Ticket ${t2.title ?? t2.id}`, "ticket.get", t2.id ?? "")} class="min-h-11">Details</Button></article>}</For>
              </Show>
              <h3>Incidents</h3>
              <Show when={incidents().length} fallback={<p>No incidents.</p>}>
                <For each={incidents()}>{(i2) => <article class="border-b border-outline-gray-1 py-3"><Badge>{i2.state ?? i2.status ?? "open"}</Badge><span> {i2.title ?? i2.summary ?? i2.id}</span><Button aria-label={`Details for incident ${i2.title ?? i2.id}`} onClick={() => void showDetail(`Incident ${i2.title ?? i2.id}`, "incident.get", i2.id ?? "")} class="min-h-11">Details</Button></article>}</For>
              </Show>
              <h3>Delivery</h3>
              <Show when={delivery().length} fallback={<p>No delivery dossiers.</p>}>
                <For each={delivery()}>{(d2) => <article class="border-b border-outline-gray-1 py-3"><Badge>{d2.state ?? d2.status ?? "in-flight"}</Badge><span> {d2.title ?? d2.summary ?? d2.id}</span><Button aria-label={`Details for delivery ${d2.title ?? d2.id}`} onClick={() => void showDetail(`Delivery ${d2.title ?? d2.id}`, "delivery.get", d2.id ?? "")} class="min-h-11">Details</Button></article>}</For>
              </Show>
            </section>
          </Show>
          <Show when={area() === "knowledge"}>
            <section aria-label="Knowledge"><h2>Knowledge</h2>
              <TextInput label="Memory search" value={memoryText()} onInput={(e) => setMemoryText(e.currentTarget.value)} />
              <Button onClick={() => void searchMemory()} class="min-h-11">Search memory</Button>
              <For each={memoryResults()}>{(r) => <article class="border-b border-outline-gray-1 py-3"><Badge>{r.status ?? "unverified"}</Badge><p>{r.text ?? ""}</p></article>}</For>
              <h3>Tool catalog</h3>
              <Show when={tools().length} fallback={<p>No tools declared in the active release.</p>}>
                <For each={tools()}>{(t) => <article class="border-b border-outline-gray-1 py-3"><Badge>{t.status ?? "trusted"}</Badge><span> {t.id}{t.effectClass ? ` · ${t.effectClass}` : ""}</span></article>}</For>
              </Show>
            </section>
          </Show>
          <Show when={area() === "settings"}>
            <section aria-label="Settings"><h2>Settings</h2>
              <p role="status">{health() || "Health unavailable."}</p>
              <h3>Workspace members</h3>
              <Show when={members().length} fallback={<p>No members listed for this workspace.</p>}>
                <For each={members()}>{(m) => <article class="border-b border-outline-gray-1 py-3"><Badge>{m.revoked ? "revoked" : m.roles.join(", ")}</Badge><span> {m.principalId} · v{m.version}</span></article>}</For>
              </Show>
              <h3>Notifications</h3>
              <p>Push notifications are attention hints for pending approvals. Decisions always happen here after sign-in and step-up verification.</p>
              <Button onClick={() => void enablePush()} class="min-h-11">Enable notifications</Button>
              <p role="status">{pushState()}</p>
              <h3>Runners</h3>
              <TextInput label="Operations reason" value={opsReason()} onInput={(e) => setOpsReason(e.currentTarget.value)} />
              <Show when={runners().length} fallback={<p>No runners enrolled for this organization.</p>}>
                <For each={runners()}>{(r) => <article class="border-b border-outline-gray-1 py-3"><Badge>{r.displayStatus}</Badge><span> {r.runnerId} · {r.group} · {r.connectivity} · {r.health}</span>
                  <Button aria-label={`Drain runner ${r.runnerId}`} onClick={() => void runnerAction(r.runnerId, "runner.drain")} class="min-h-11">Drain</Button>
                  <Button aria-label={`Quarantine runner ${r.runnerId}`} onClick={() => void runnerAction(r.runnerId, "runner.quarantine")} class="min-h-11">Quarantine</Button>
                </article>}</For>
              </Show>
            </section>
          </Show>
        </Show>
      </AppShell>
      </Show>
    </Show>
  </Show>;
}
