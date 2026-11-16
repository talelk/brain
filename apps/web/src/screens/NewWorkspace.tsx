import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { Button, Checkbox, Textarea, TextInput } from "@talelk/newui-atoms";
import type { PackSummary } from "@brain/contracts";
import { command, useAction, useQuery } from "../data/api";
import { useSession } from "../data/session";
import { t, tn } from "../i18n";
import { isSlug, slugify } from "../lib/model";
import { Choice } from "../components/fields";
import { Mark } from "../components/Shell";
import { Empty, Failure, Ready } from "../components/bits";

const Step = (props: { n: number; title: string; text: string; children: JSX.Element }): JSX.Element => (
  <section class="grid gap-x-5 gap-y-3 border-t border-rule py-8 sm:grid-cols-[2.5rem_minmax(0,1fr)]">
    <span class="flex size-9 items-center justify-center rounded-full bg-lilac font-display text-[1.0625rem] font-semibold text-ink" aria-hidden="true">{props.n}</span>
    <div class="min-w-0">
      <h2 class="t-head text-ink">{props.title}</h2>
      <p class="mt-1 max-w-[60ch] t-text text-ink-2">{props.text}</p>
      <div class="mt-5 flex flex-col gap-4">{props.children}</div>
    </div>
  </section>
);

/** What a pack brings, in one line per kind. */
function Brings(props: { pack: PackSummary }): JSX.Element {
  const line = (label: string, names: readonly string[]): JSX.Element => <Show when={names.length > 0}><p class="t-small text-ink-2"><span class="font-medium text-ink">{label}</span> {names.join(", ")}</p></Show>;
  return (
    <div class="mt-2 flex flex-col gap-0.5">
      {line(tn("new.packs.agents", props.pack.agents.length), props.pack.agents.map((agent) => agent.name))}
      {line(tn("new.packs.tools", props.pack.tools.length), props.pack.tools.map((tool) => tool.name))}
      {line(tn("new.packs.plays", props.pack.plays.length), props.pack.plays.map((play) => play.title))}
    </div>
  );
}

/** New workspace: name it, pick packs, add a repository, then land on Today with the goal box ready. */
export default function NewWorkspaceScreen(): JSX.Element {
  const session = useSession();
  const navigate = useNavigate();
  const packs = useQuery("packs.list", () => (session.user().instanceAdmin ? {} : undefined));
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [address, setAddress] = createSignal<string>();
  const [picked, setPicked] = createSignal<readonly string[]>(["base"]);
  const [repo, setRepo] = createSignal("");
  const [branch, setBranch] = createSignal("main");
  const [access, setAccess] = createSignal<"read" | "write">("read");
  const [credential, setCredential] = createSignal("");
  const slug = (): string => address() ?? slugify(name());
  /** Packs pulled in because a picked pack requires them. */
  const required = createMemo((): Set<string> => {
    const all = packs.data()?.packs ?? [];
    const out = new Set<string>();
    const visit = (pack: string): void => { for (const need of all.find((entry) => entry.name === pack)?.requires ?? []) if (!out.has(need)) { out.add(need); visit(need); } };
    picked().forEach(visit);
    return out;
  });
  const create = useAction(async () => {
    const project = repo().trim() === "" ? undefined : { repo: repo().trim(), branch: branch().trim() || "main", access: access(), ...(credential() ? { credential: credential() } : {}) };
    const made = await command("workspace.create", { name: name().trim(), description: description().trim(), ...(isSlug(slug()) ? { slug: slug() } : {}), packs: [...new Set([...required(), ...picked()])], ...(project ? { project } : {}) });
    session.refetch();
    navigate(`/w/${made.slug}?new=1`);
  });
  const first = (): boolean => session.workspaces().length === 0;
  return (
    <main class="mx-auto max-w-[46rem] px-4 pb-24 pt-6 md:px-8">
      <div class="flex items-center justify-between text-ink"><Mark /><Show when={!first()}><A href="/" class="link t-small">{t("action.cancel")}</A></Show></div>
      <h1 class="mt-10 t-hero text-ink">{t("new.title")}</h1>
      <p class="mb-8 mt-4 max-w-[56ch] t-text text-ink-2">{first() ? t("new.text.first") : t("new.text")}</p>
      <Show when={session.user().instanceAdmin} fallback={<Empty title={t("new.adminOnly")} text={t("new.adminOnly.text")} />}>
        <form onSubmit={(event) => { event.preventDefault(); void create.run(); }}>
          <Step n={1} title={t("new.name.title")} text={t("new.name.text")}>
            <TextInput size="lg" label={t("field.name")} placeholder={t("new.name.placeholder")} value={name()} onInput={(event) => setName(event.currentTarget.value)} required maxlength={100} autofocus />
            <Textarea size="md" label={t("field.description")} description={t("settings.description.help")} rows={2} value={description()} onInput={(event) => setDescription(event.currentTarget.value)} maxlength={2000} />
            <div class="max-w-sm"><TextInput size="md" class="t-code" label={t("new.address")} description={t("new.address.help", { address: `/w/${slug() || "…"}` })} error={slug() !== "" && !isSlug(slug()) ? t("workspace.new.name.slug") : undefined} value={slug()} onInput={(event) => setAddress(event.currentTarget.value)} /></div>
          </Step>
          <Step n={2} title={t("new.packs.title")} text={t("new.packs.text")}>
            <Ready data={packs.data()} error={packs.error()} retry={packs.refetch}>
              {(loaded) => (
                <ul class="flex flex-col gap-3">
                  <For each={loaded().packs}>
                    {(pack) => {
                      const forced = (): boolean => required().has(pack.name) || pack.name === "base";
                      const on = (): boolean => forced() || picked().includes(pack.name);
                      return (
                        <li class={`rounded-[20px] border bg-sheet p-5 ${on() ? "border-violet" : "border-rule-2"}`}>
                          <Checkbox size="md" label={<span class="t-text font-semibold text-ink">{pack.name}</span>} checked={on()} disabled={forced()} onCheckedChange={(checked) => setPicked(checked ? [...picked(), pack.name] : picked().filter((other) => other !== pack.name))} />
                          <div class="ps-7">
                            <p class="mt-1 t-small text-ink-2">{pack.description}</p>
                            <Show when={forced()}><p class="mt-1 t-small text-ink-3">{pack.name === "base" ? t("new.packs.always") : t("new.packs.required")}</p></Show>
                            <Brings pack={pack} />
                          </div>
                        </li>
                      );
                    }}
                  </For>
                </ul>
              )}
            </Ready>
          </Step>
          <Step n={3} title={t("new.repo.title")} text={t("new.repo.text")}>
            <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <TextInput size="md" class="t-code" label={t("projects.repo")} placeholder="https://github.com/acme/shop.git" value={repo()} onInput={(event) => setRepo(event.currentTarget.value)} />
              <TextInput size="md" class="t-code" label={t("projects.branch")} value={branch()} onInput={(event) => setBranch(event.currentTarget.value)} disabled={repo().trim() === ""} />
            </div>
            <Show when={repo().trim() !== ""}>
              <Choice label={t("projects.access")} value={access()} onChange={setAccess} options={[{ value: "read", label: t("projects.access.read"), help: t("projects.access.read.help") }, { value: "write", label: t("projects.access.write"), help: t("projects.access.write.help") }]} />
              <TextInput size="md" type="password" autocomplete="off" label={t("new.repo.credential")} description={t("new.repo.credential.help")} value={credential()} onInput={(event) => setCredential(event.currentTarget.value)} />
            </Show>
          </Step>
          <div class="border-t border-rule pt-8">
            <Failure error={create.error()} class="mb-4" />
            <Button type="submit" variant="solid" theme="blue" size="lg" class="rounded-full! px-6!" loading={create.busy()} disabled={name().trim() === ""}>{t("new.create")}</Button>
          </div>
        </form>
      </Show>
    </main>
  );
}
