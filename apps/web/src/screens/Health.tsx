import { createSignal, Show, type JSX } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import type { AuditVerifyResult, Health, Runner } from "@brain/contracts";
import { command, query, useAction, useQuery } from "../data/api";
import { usePlace, useSession } from "../data/session";
import { t, tn } from "../i18n";
import { ago, count, dateTime } from "../lib/format";
import { Code, ConfirmButton, Empty, Failure, Icon, Keyed, PageHead, Ready, Section } from "../components/bits";

/** Good or not, as a word with its own shape. */
const Sign = (props: { ok: boolean; yes: string; no: string }): JSX.Element => (
  <span class={`inline-flex items-center gap-1.5 whitespace-nowrap t-small font-medium ${props.ok ? "text-ok" : "text-bad"}`}><Icon name={props.ok ? "lucide-circle-check" : "lucide-circle-x"} />{props.ok ? props.yes : props.no}</span>
);

function RunnerRow(props: { runner: Runner; admin: boolean }): JSX.Element {
  const remove = useAction(() => command("runner.remove", { runnerId: props.runner.id }));
  return (
    <li class="border-b border-rule py-3 last:border-b-0">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
        <p class="min-w-0 flex-1 basis-40 truncate t-text font-semibold text-ink">{props.runner.name}</p>
        <Sign ok={props.runner.online} yes={t("health.runner.online")} no={t("health.runner.offline")} />
        <span class="t-small text-ink-2">{t("health.runner.slots", { free: props.runner.freeSlots, all: props.runner.slots })}</span>
        <Show when={props.admin}><ConfirmButton label={t("action.remove")} confirm={t("health.runner.remove.confirm", { name: props.runner.name })} busy={remove.busy()} onConfirm={() => void remove.run()} /></Show>
      </div>
      <p class="mt-0.5 t-small text-ink-3">
        {t("health.runner.engines", { engines: props.runner.engines.join(", ") || t("fields.none") })} {t("health.runner.has", { capabilities: props.runner.capabilities.join(", ") || t("fields.none") })}
        <Show when={!props.runner.online && props.runner.lastSeenAt}> {t("health.runner.seen", { when: ago(props.runner.lastSeenAt ?? 0) })}</Show>
      </p>
      <Failure error={remove.error()} class="mt-2" />
    </li>
  );
}

/** A one-time token and the command that starts a runner with it. */
function AddRunner(): JSX.Element {
  const [name, setName] = createSignal("");
  const [made, setMade] = createSignal<{ token: string; expiresAt: number }>();
  const [copied, setCopied] = createSignal(false);
  const make = useAction(async () => { setCopied(false); setMade(await command("runner.token", name().trim() ? { name: name().trim() } : {})); });
  const line = (): string => `pnpm brain runner --governor ${location.origin} --token ${made()?.token ?? ""}`;
  return (
    <div class="mt-5 rounded-[20px] border border-rule bg-sheet p-5">
      <h3 class="t-head text-ink">{t("health.runner.add")}</h3>
      <p class="mt-1 max-w-[62ch] t-small text-ink-2">{t("health.runner.add.text")}</p>
      <Show when={made()} fallback={
        <form class="mt-4 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void make.run(); }}>
          <div class="w-64 max-w-full"><TextInput size="md" label={t("health.runner.name")} placeholder={t("health.runner.name.help")} value={name()} onInput={(event) => setName(event.currentTarget.value)} maxlength={100} /></div>
          <Button type="submit" variant="solid" theme="blue" size="md" loading={make.busy()}>{t("health.runner.token")}</Button>
        </form>
      }>
        {(token) => (
          <div class="mt-4 flex flex-col gap-3">
            <p class="t-text text-ink">{t("health.runner.run")}</p>
            <Code text={line()} />
            <div class="flex flex-wrap items-center gap-3">
              <Button variant="outline" size="md" iconLeft={copied() ? "lucide-check" : "lucide-copy"} onClick={() => void navigator.clipboard.writeText(line()).then(() => setCopied(true))}>{copied() ? t("action.copied") : t("action.copy")}</Button>
              <span class="t-small text-ink-3">{t("health.runner.expires", { when: dateTime(token().expiresAt) })}</span>
            </div>
          </div>
        )}
      </Show>
      <Failure error={make.error()} class="mt-3" />
    </div>
  );
}

function Audit(props: { audit: Health["audit"]; admin: boolean }): JSX.Element {
  const [result, setResult] = createSignal<AuditVerifyResult>();
  const verify = useAction(async () => setResult(await query("audit.verify", {})));
  return (
    <>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Sign ok={props.audit.problem === null} yes={t("health.audit.ok")} no={t("health.audit.problem")} />
        <p class="min-w-0 flex-1 basis-60 t-text text-ink-2">
          {tn("health.audit.events", props.audit.events, { n: count(props.audit.events) })} {props.audit.lastCheckpointAt ? t("health.audit.checkpoint", { when: ago(props.audit.lastCheckpointAt) }) : t("health.audit.checkpoint.none")}
        </p>
        <Show when={props.admin}><Button variant="outline" size="md" loading={verify.busy()} onClick={() => void verify.run()}>{t("health.audit.verify")}</Button></Show>
      </div>
      <Show when={props.audit.problem}><p class="mt-3 rounded-xl bg-bad-soft px-4 py-3 t-text text-bad" role="alert">{props.audit.problem}</p></Show>
      <Failure error={verify.error()} class="mt-3" />
      <Show when={result()}>
        {(verified) => (
          <p role="status" class={`mt-3 rounded-xl px-4 py-3 t-text ${verified().ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>
            {verified().ok ? t("health.audit.verified", { events: count(verified().events), checkpoints: verified().checkpoints }) : t("health.audit.broken", { detail: verified().break?.detail ?? "" })}
          </p>
        )}
      </Show>
    </>
  );
}

/** Health: what Brain needs to run work and keep its record. */
export default function HealthScreen(): JSX.Element {
  const place = usePlace();
  const session = useSession();
  const health = useQuery("health", () => ({ workspaceId: place.id() }));
  const admin = (): boolean => session.user().instanceAdmin;
  return (
    <div class="mx-auto max-w-[52rem]">
      <PageHead title={t("nav.health")} text={t("health.text")} />
      <Ready data={health.data()} error={health.error()} retry={health.refetch}>
        {(loaded) => (
          <>
            <Section title={t("health.runners")} aside={t("health.runners.aside")} class="mt-0">
              <Show when={loaded().runners.length > 0} fallback={<Empty title={t("health.runners.none")} text={t("health.runners.none.text")} />}>
                <ul><Keyed each={loaded().runners} by={(runner) => runner.id}>{(runner) => <RunnerRow runner={runner()} admin={admin()} />}</Keyed></ul>
              </Show>
              <Show when={admin()}><AddRunner /></Show>
            </Section>
            <Section title={t("health.models")}>
              <Show when={loaded().models.length > 0} fallback={<Empty title={t("health.models.none")} text={t("health.models.none.text")}><Button variant="outline" size="md" route={place.to()}>{t("health.models.connect")}</Button></Empty>}>
                <ul>
                  <Keyed each={loaded().models} by={(model) => model.name}>
                    {(model) => (
                      <li class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule py-3 last:border-b-0">
                        <code class="t-code code-ltr font-medium text-ink">{model().name}</code>
                        <Sign ok={model().reachable} yes={t("health.models.reachable")} no={t("health.models.unreachable")} />
                        <span class="min-w-0 flex-1 basis-48 t-small text-ink-2">{model().detail}</span>
                      </li>
                    )}
                  </Keyed>
                </ul>
              </Show>
            </Section>
            <Section title={t("health.audit")} aside={t("health.audit.aside")}><Audit audit={loaded().audit} admin={admin()} /></Section>
            <Section title={t("health.backup")}>
              <p class="t-text text-ink-2">{loaded().backup.lastAt ? t("health.backup.last", { when: ago(loaded().backup.lastAt ?? 0), date: dateTime(loaded().backup.lastAt ?? 0) }) : t("health.backup.none")}</p>
            </Section>
            <p class="mt-10 t-small text-ink-3">{t("health.version", { version: loaded().version })}</p>
          </>
        )}
      </Ready>
    </div>
  );
}
