import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button, Checkbox, Textarea, TextInput } from "@talelk/newui-atoms";
import { EmptyState } from "@talelk/newui-molecules";
import { Wizard, type WizardFormApi } from "@talelk/newui-organisms";
import { createAppForm, fieldError } from "@talelk/newui-data/form";
import type { PackSummary } from "@brain/contracts";
import { command, useAction, useQuery } from "../data/api";
import { useSession } from "../data/session";
import { human, t, tn } from "../i18n";
import { isSlug, slugify } from "../lib/model";
import { Choice } from "../components/fields";
import { Head } from "../components/Shell";
import { Failure, Ready } from "../components/bits";

interface Values { name: string; description: string; address: string; packs: string[]; repo: string; branch: string; access: "read" | "write"; credential: string }
const BLANK: Values = { name: "", description: "", address: "", packs: ["base"], repo: "", branch: "main", access: "read", credential: "" };

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
  const slugOf = (values: Values): string => (values.address !== "" ? values.address : slugify(values.name));
  /** Packs pulled in because a picked pack requires them. */
  const required = (picked: readonly string[]): Set<string> => {
    const all = packs.data()?.packs ?? [];
    const out = new Set<string>();
    const visit = (pack: string): void => { for (const need of all.find((entry) => entry.name === pack)?.requires ?? []) if (!out.has(need)) { out.add(need); visit(need); } };
    picked.forEach(visit);
    return out;
  };
  const create = useAction(async (values: Values) => {
    const project = values.repo.trim() === "" ? undefined : { repo: values.repo.trim(), branch: values.branch.trim() || "main", access: values.access, ...(values.credential ? { credential: values.credential } : {}) };
    const slug = slugOf(values);
    const made = await command("workspace.create", { name: values.name.trim(), description: values.description.trim(), ...(isSlug(slug) ? { slug } : {}), packs: [...new Set([...required(values.packs), ...values.packs])], ...(project ? { project } : {}) });
    session.refetch();
    navigate(`/w/${made.slug}?new=1`);
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
                validate: (given): Record<string, string> | undefined => (given.name.trim() === "" ? { name: t("new.name.required") } : slugOf(given) !== "" && !isSlug(slugOf(given)) ? { address: t("workspace.new.name.slug") } : noop()),
                content: (
                  <div class="flex flex-col gap-4">
                    <form.Field name="name">{(field) => <TextInput size="lg" label={t("field.name")} placeholder={t("new.name.placeholder")} value={field().state.value} error={fieldError(field())} onInput={(event) => field().handleChange(event.currentTarget.value)} required maxlength={100} autofocus />}</form.Field>
                    <form.Field name="description">{(field) => <Textarea size="md" label={t("field.description")} description={t("settings.description.help")} rows={2} value={field().state.value} onInput={(event) => field().handleChange(event.currentTarget.value)} maxlength={2000} />}</form.Field>
                    <form.Field name="address">
                      {(field) => <div class="max-w-sm"><TextInput size="md" class="t-code" label={t("new.address")} description={t("new.address.help", { address: `/w/${slugOf(values()) || "…"}` })} error={fieldError(field())} value={field().state.value} placeholder={slugify(values().name)} onInput={(event) => field().handleChange(event.currentTarget.value)} /></div>}
                    </form.Field>
                  </div>
                ) },
              { id: "packs", label: t("new.packs.title"), description: t("new.packs.text"),
                content: (
                  <Ready data={packs.data()} error={packs.error()} retry={packs.refetch}>
                    {(loaded) => (
                      <form.Field name="packs">
                        {(field) => (
                          <ul class="flex flex-col gap-3">
                            <For each={loaded().packs}>
                              {(pack) => {
                                const forced = (): boolean => required(field().state.value).has(pack.name) || pack.name === "base";
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
                  <div class="flex flex-col gap-4">
                    <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                      <form.Field name="repo">{(field) => <TextInput size="md" class="t-code" label={t("projects.repo")} placeholder="https://github.com/acme/shop.git" value={field().state.value} onInput={(event) => field().handleChange(event.currentTarget.value)} />}</form.Field>
                      <form.Field name="branch">{(field) => <TextInput size="md" class="t-code" label={t("projects.branch")} value={field().state.value} disabled={values().repo.trim() === ""} onInput={(event) => field().handleChange(event.currentTarget.value)} />}</form.Field>
                    </div>
                    <Show when={values().repo.trim() !== ""}>
                      <form.Field name="access">{(field) => <Choice label={t("projects.access")} value={field().state.value} onChange={(value) => field().handleChange(value)} options={[{ value: "read", label: t("projects.access.read"), help: t("projects.access.read.help") }, { value: "write", label: t("projects.access.write"), help: t("projects.access.write.help") }]} />}</form.Field>
                      <form.Field name="credential">{(field) => <TextInput size="md" type="password" autocomplete="off" label={t("new.repo.credential")} description={t("new.repo.credential.help")} value={field().state.value} onInput={(event) => field().handleChange(event.currentTarget.value)} />}</form.Field>
                    </Show>
                  </div>
                ) },
            ]} />
          </div>
          <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-outline-gray-1 pt-4">
            <Button variant="outline" size="md" iconLeft="lucide-chevron-left" class="rtl:[&>span:first-child]:rotate-180" disabled={step() === "name"} onClick={() => press("back")}>{t("action.back")}</Button>
            <div class="flex items-center gap-2">
              <Button variant="ghost" size="md" route="/">{t("action.cancel")}</Button>
              <Show when={step() === "repo"} fallback={<Button variant="solid" theme="blue" size="md" iconRight="lucide-chevron-right" class="rtl:[&>span:last-child]:rotate-180" onClick={() => press("next")}>{t("action.next")}</Button>}>
                <Button variant="solid" theme="blue" size="md" loading={create.busy()} onClick={() => press("submit")}>{t("new.create")}</Button>
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
