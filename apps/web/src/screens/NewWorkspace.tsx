import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button, Checkbox, Switch, Textarea, TextInput } from "@talelk/newui-atoms";
import { EmptyState } from "@talelk/newui-molecules";
import { Wizard, type WizardFormApi } from "@talelk/newui-organisms";
import { createAppForm, fieldError } from "@talelk/newui-data/form";
import type { PackSummary } from "@brain/contracts";
import { command, useAction, useQuery } from "../data/api";
import { useSession } from "../data/session";
import { human, t, tn } from "../i18n";
import { isSlug, slugify } from "../lib/model";
import { projectNameOf } from "../lib/repo";
import { Choice } from "../components/fields";
import { Head } from "../components/Shell";
import { Details, Failure, Ready } from "../components/bits";

interface Values { name: string; description: string; address: string; packs: string[]; repo: string; projectName: string; branch: string; write: boolean; credential: string; remote: string; platform: "" | "read" | "admin" }
const BLANK: Values = { name: "", description: "", address: "", platform: "", packs: ["base"], repo: "", projectName: "", branch: "", write: true, credential: "", remote: "" };

/** What a pack brings, in one line per kind. */
function Brings(props: { pack: PackSummary }): JSX.Element {
  const line = (label: string, names: readonly string[]): JSX.Element => <Show when={names.length > 0}><p class="t-small text-ink-2"><span class="font-medium text-ink">{label}</span> {names.join(", ")}</p></Show>;
  return (
    <div class="mt-2 flex flex-col gap-0.5">
      {line(tn("new.packs.agents", props.pack.agents.length), props.pack.agents.map((agent) => agent.name))}
      {line(tn("new.packs.tools", props.pack.tools.length), props.pack.tools.map((tool) => tool.name))}
      {line(tn("new.packs.plays", props.pack.plays.length), props.pack.plays.map((play) => human(play.translations, ["title"], play.title)))}
    </div>
  );
}

/** New workspace: name it, pick packs, add a repository, then land on Today with the goal box ready. */
export default function NewWorkspaceScreen(): JSX.Element {
  const session = useSession();
  const navigate = useNavigate();
  const packs = useQuery("packs.list", () => (session.user().instanceAdmin ? {} : undefined));
  const app = createAppForm<Values>({ defaultValues: BLANK, onSubmit: () => undefined });
  const form = app.form;
  const values = form.useStore((state) => state.values);
  /** The address: typed in "Change the address", else made from the name. It is also the folder of the workspace on the server. */
  const slugOf = (values: Values): string => slugify(values.address !== "" ? values.address : values.name);
  const [changing, setChanging] = createSignal(false);
  /** Addresses the app already knows are taken: the person's own workspaces, those that use a pack (all of them, as an instance admin sees it), and one the server refused. */
  const [refused, setRefused] = createSignal<readonly string[]>([]);
  const taken = createMemo((): Set<string> => new Set([...session.workspaces().map((workspace) => workspace.slug), ...(packs.data()?.packs ?? []).flatMap((pack) => pack.usedBy.map((use) => use.slug)), ...refused()]));
  /** The same address, held back a moment so the message does not flicker while typing. */
  const [settledAddress, setSettled] = createSignal("");
  let wait: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => { const address = slugOf(values()); clearTimeout(wait); wait = setTimeout(() => setSettled(address), 250); });
  onCleanup(() => clearTimeout(wait));
  const nameTaken = (given: Values): boolean => { const address = slugOf(given); return address !== "" && taken().has(address); };
  const takenText = (address: string): string => t("new.name.taken", { address });
  /** Packs pulled in because a picked pack requires them. */
  const required = (picked: readonly string[]): Set<string> => {
    const all = packs.data()?.packs ?? [];
    const out = new Set<string>();
    const visit = (pack: string): void => { for (const need of all.find((entry) => entry.name === pack)?.requires ?? []) if (!out.has(need)) { out.add(need); visit(need); } };
    picked.forEach(visit);
    return out;
  };
  const create = useAction(async (values: Values) => {
    const repo = values.repo.trim();
    const project = repo === "" ? undefined : { repo, ...(values.projectName.trim() !== "" ? { name: values.projectName.trim() } : {}), ...(values.branch.trim() !== "" ? { branch: values.branch.trim() } : {}), access: values.write ? "write" as const : "read" as const, ...(values.credential ? { credential: values.credential } : {}) };
    const slug = slugOf(values);
    try {
      const made = await command("workspace.create", { name: values.name.trim(), description: values.description.trim(), ...(isSlug(slug) ? { slug } : {}), ...(values.platform ? { platform: values.platform } : {}), packs: [...new Set([...required(values.packs), ...values.packs, ...(values.platform ? ["platform"] : [])])].filter((pack) => values.platform !== "" || pack !== "platform"), ...(project ? { project } : {}), ...(values.remote.trim() !== "" ? { folderRemote: values.remote.trim() } : {}) });
      session.refetch();
      navigate(`/w/${made.slug}?new=1`);
    } catch (e) {
      // The server knows every address: when it says one is taken, the person is taken back to the name.
      if ((e as { code?: string }).code === "CONFLICT" && (e as { problems?: Array<{ path: string }> }).problems?.some((problem) => problem.path === "name")) { setRefused([...refused(), slug]); setTimeout(() => { for (let at = 0; at < 2; at += 1) press("back"); }, 0); }
      throw e;
    }
  });
  const first = createMemo((): boolean => session.workspaces().length === 0);
  /** The step the wizard is on, and its own buttons: the library draws them in English only, so they are hidden and ours press them. */
  const [step, setStep] = createSignal("name");
  let shell: HTMLDivElement | undefined;
  const press = (button: "back" | "next" | "submit"): void => { const buttons = shell?.querySelectorAll<HTMLButtonElement>('[data-slot="wizard-footer"] button') ?? []; (button === "back" ? buttons[0] : buttons[buttons.length - 1])?.click(); };
  const noop = (): undefined => undefined;
  return (
    <>
      <Head title={t("new.title")} text={t("new.title")} description={first() ? t("new.text.first") : t("new.text")} breadcrumbs={[{ label: t("nav.overview"), route: "/" }, { label: t("new.title") }]} />
      <Show when={session.user().instanceAdmin} fallback={<EmptyState bordered icon="lucide-lock" title={t("new.adminOnly")} description={t("new.adminOnly.text")} />}>
        <div class="max-w-[46rem]">
          <Failure error={create.error()} class="mb-4" />
          <div class="localised-wizard" ref={shell}>
          <Wizard<Values> label={t("new.title")} form={form as unknown as WizardFormApi} submitLabel={t("new.create")} onSubmit={async (submitted) => { await create.run(submitted); }} onCurrentStepChange={setStep}
            steps={[
              { id: "name", label: t("new.name.title"), description: t("new.name.text"),
                validate: (given): Record<string, string> | undefined => (given.name.trim() === "" ? { name: t("new.name.required") } : slugOf(given) === "" || !isSlug(slugOf(given)) ? { name: t("workspace.new.name.slug") } : noop()),
                content: (
                  <div class="flex flex-col gap-4">
                    <form.Field name="name">{(field) => <TextInput size="lg" label={t("field.name")} placeholder={t("new.name.placeholder")} value={field().state.value} error={fieldError(field()) ?? (settledAddress() !== "" && taken().has(settledAddress()) && slugOf(values()) === settledAddress() ? takenText(settledAddress()) : undefined)} onInput={(event) => field().handleChange(event.currentTarget.value)} required maxlength={100} autofocus />}</form.Field>
                    <div class="t-small text-ink-2" data-testid="address-preview">
                      <Show when={!changing()} fallback={
                        <form.Field name="address">
                          {(field) => <div class="max-w-sm"><TextInput size="md" class="t-code" label={t("new.address")} description={t("new.address.help", { address: `/w/${slugOf(values()) || "…"}` })} error={fieldError(field())} value={field().state.value} placeholder={slugify(values().name)} onInput={(event) => field().handleChange(event.currentTarget.value)} /></div>}
                        </form.Field>
                      }>
                        <Show when={slugOf(values()) !== ""}>{t("new.address.auto", { address: `/w/${slugOf(values())}` })} </Show>
                        <button type="button" class="link" onClick={() => setChanging(true)}>{t("new.address.change")}</button>
                      </Show>
                    </div>
                    <form.Field name="description">{(field) => <Textarea size="md" label={t("field.description")} description={t("settings.description.help")} rows={2} value={field().state.value} onInput={(event) => field().handleChange(event.currentTarget.value)} maxlength={2000} />}</form.Field>
                    <Details summary={<span>{t("form.more")}</span>}>
                      <form.Field name="platform">{(field) => <Choice label={t("new.platform")} value={field().state.value} onChange={(value) => field().handleChange(value)} options={[{ value: "", label: t("new.platform.none"), help: t("new.platform.none.help") }, { value: "read", label: t("new.platform.read"), help: t("new.platform.read.help") }, { value: "admin", label: t("new.platform.admin"), help: t("new.platform.admin.help") }]} />}</form.Field>
                    </Details>
                  </div>
                ) },
              { id: "packs", label: t("new.packs.title"), description: t("new.packs.text"),
                content: (
                  <Ready data={packs.data()} error={packs.error()} retry={packs.refetch}>
                    {(loaded) => (
                      <form.Field name="packs">
                        {(field) => (
                          <ul class="flex flex-col gap-3">
                            <For each={loaded().packs.filter((pack) => pack.name !== "platform" || values().platform !== "")}>
                              {(pack) => {
                                const forced = (): boolean => required(field().state.value).has(pack.name) || pack.name === "base" || (pack.name === "platform" && values().platform !== "");
                                const on = (): boolean => forced() || field().state.value.includes(pack.name);
                                return (
                                  <li class={`rounded-card border bg-surface-elevation-1 p-4 ${on() ? "border-violet" : "border-outline-gray-2"}`}>
                                    <Checkbox size="md" label={<span class="t-text font-semibold text-ink">{pack.name}</span>} checked={on()} disabled={forced()} onCheckedChange={(checked) => field().handleChange(checked ? [...field().state.value, pack.name] : field().state.value.filter((other) => other !== pack.name))} />
                                    <div class="ps-7">
                                      <p class="mt-1 t-small text-ink-2">{human(pack.translations, ["description"], pack.description)}</p>
                                      <Show when={forced()}><p class="mt-1 t-small text-ink-3">{pack.name === "base" ? t("new.packs.always") : t("new.packs.required")}</p></Show>
                                      <Brings pack={pack} />
                                    </div>
                                  </li>
                                );
                              }}
                            </For>
                          </ul>
                        )}
                      </form.Field>
                    )}
                  </Ready>
                ) },
              { id: "repo", label: t("new.repo.title"), description: t("new.repo.text"),
                content: (
                  <div class="flex flex-col gap-5">
                    <div class="flex flex-col gap-3">
                      <form.Field name="repo">{(field) => <TextInput size="md" class="t-code" label={t("new.repo.url")} description={t("new.repo.url.help")} placeholder="https://github.com/acme/shop.git" value={field().state.value} onInput={(event) => field().handleChange(event.currentTarget.value)} />}</form.Field>
                      <Show when={values().repo.trim() !== ""}>
                        <form.Field name="write">{(field) => <Switch label={t("new.repo.write")} description={t("new.repo.write.help")} checked={field().state.value} onCheckedChange={(on) => field().handleChange(on)} />}</form.Field>
                        <p class="t-small text-ink-2" data-testid="inferred-project">{t("new.repo.inferred", { name: values().projectName.trim() || projectNameOf(values().repo), branch: values().branch.trim() || t("new.repo.branch.auto") })}</p>
                        <Details summary={<span>{t("form.more")}</span>}>
                          <div class="grid gap-4 sm:grid-cols-2">
                            <form.Field name="projectName">{(field) => <TextInput size="md" class="t-code" label={t("field.name")} placeholder={projectNameOf(values().repo)} value={field().state.value} onInput={(event) => field().handleChange(event.currentTarget.value)} />}</form.Field>
                            <form.Field name="branch">{(field) => <TextInput size="md" class="t-code" label={t("projects.branch")} placeholder={t("new.repo.branch.auto")} value={field().state.value} onInput={(event) => field().handleChange(event.currentTarget.value)} />}</form.Field>
                          </div>
                          <form.Field name="credential">{(field) => <TextInput size="md" type="password" autocomplete="off" label={t("new.repo.credential")} description={t("new.repo.credential.help")} value={field().state.value} onInput={(event) => field().handleChange(event.currentTarget.value)} />}</form.Field>
                        </Details>
                      </Show>
                    </div>
                    <div class="border-t border-rule pt-5">
                      <form.Field name="remote">{(field) => <TextInput size="md" class="t-code" label={t("new.remote.url")} description={t("new.remote.url.help")} placeholder="https://github.com/acme/workspace-files.git" value={field().state.value} onInput={(event) => field().handleChange(event.currentTarget.value)} />}</form.Field>
                    </div>
                  </div>
                ) },
            ]} />
          </div>
          <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-outline-gray-1 pt-4">
            <Button variant="outline" size="md" iconLeft="lucide-chevron-left" class="rtl:[&>span:first-child]:rotate-180" disabled={step() === "name"} onClick={() => press("back")}>{t("action.back")}</Button>
            <div class="flex items-center gap-2">
              <Button variant="ghost" size="md" route="/">{t("action.cancel")}</Button>
              <Show when={step() === "repo"} fallback={<Button variant="solid" theme="blue" size="md" iconRight="lucide-chevron-right" class="rtl:[&>span:last-child]:rotate-180" disabled={step() === "name" && (values().name.trim() === "" || nameTaken(values()))} onClick={() => press("next")}>{t("action.next")}</Button>}>
                <Button variant="solid" theme="blue" size="md" loading={create.busy()} onClick={() => press("submit")}>{t("new.create")}</Button>
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
