import { createSignal, Show, type JSX } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Dialog, EmptyState, Select } from "@talelk/newui-molecules";
import { Section, type DataTableColumn } from "@talelk/newui-organisms";
import type { ApiToken, TokenRole } from "@brain/contracts";
import { command, useAction, useQuery } from "../data/api";
import { usePlace } from "../data/session";
import { t, tn } from "../i18n";
import { dateTime } from "../lib/format";
import { ROLES } from "../lib/model";
import { ConfirmButton, Failure, Ready } from "./bits";
import { Table } from "./Table";
import { CopyBox } from "./UserAdmin";

/** A token never has the admin role. */
const choices = (): TokenRole[] => ROLES.filter((role): role is TokenRole => role !== "admin");
const holds = (token: ApiToken): boolean => token.revokedAt === null && token.expiresAt > Date.now();
const standing = (token: ApiToken): string => (token.revokedAt !== null ? t("tokens.revoked", { when: dateTime(token.revokedAt) }) : holds(token) ? t("tokens.until", { when: dateTime(token.expiresAt) }) : t("tokens.expired", { when: dateTime(token.expiresAt) }));

/** The name, role and lifetime of a new token; once made, the token itself, shown this one time. */
function NewToken(props: { open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element {
  const place = usePlace();
  const [name, setName] = createSignal("");
  const [role, setRole] = createSignal<TokenRole>("viewer");
  const [days, setDays] = createSignal("90");
  const [made, setMade] = createSignal<{ token: string; expiresAt: number }>();
  const create = useAction(async () => { setMade(await command("token.create", { workspaceId: place.id(), name: name(), role: role(), days: Number(days()) })); });
  // The token leaves the page with the dialog.
  const change = (open: boolean): void => {
    props.onOpenChange(open);
    if (!open) { setMade(undefined); setName(""); setRole("viewer"); setDays("90"); create.clear(); }
  };
  return (
    <Dialog.Root open={props.open} onOpenChange={change}>
      <Dialog.Content size="md">
        <Dialog.Header><Dialog.Title>{made() ? t("tokens.made") : t("tokens.new")}</Dialog.Title><Dialog.Description>{made() ? t("tokens.made.text", { when: dateTime(made()?.expiresAt ?? 0) }) : t("tokens.new.text")}</Dialog.Description></Dialog.Header>
        <Show when={made()} fallback={
          <form class="mt-4 flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void create.run(); }}>
            <TextInput size="md" label={t("field.name")} description={t("tokens.name.help")} maxLength={60} value={name()} onInput={(event) => setName(event.currentTarget.value)} required />
            <Select size="md" label={t("people.role")} options={choices().map((value) => ({ label: t(`role.${value}`), value, description: t(`tokens.role.${value}`) }))} value={role()} onValueChange={(value) => { if (value) setRole(value as TokenRole); }} />
            <TextInput size="md" type="number" min={1} max={365} step={1} label={t("tokens.days")} value={days()} onInput={(event) => setDays(event.currentTarget.value)} required />
            <Failure error={create.error()} />
            <div class="flex justify-end gap-2"><Button variant="ghost" size="md" onClick={() => change(false)}>{t("action.cancel")}</Button><Button type="submit" variant="solid" theme="blue" size="md" loading={create.busy()}>{t("tokens.new.submit")}</Button></div>
          </form>
        }>
          {(token) => (
            <div class="mt-4 flex flex-col gap-4">
              <CopyBox value={token().token} label={t("tokens.token")} action={t("tokens.copy")} done={t("tokens.copied")} />
              <div class="flex justify-end"><Button variant="solid" theme="blue" size="md" onClick={() => change(false)}>{t("tokens.close")}</Button></div>
            </div>
          )}
        </Show>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** The workspace's API tokens, for its admins (docs/model.md, API tokens). */
export function Tokens(): JSX.Element {
  const place = usePlace();
  const tokens = useQuery("tokens.list", () => ({ workspaceId: place.id() }));
  const [adding, setAdding] = createSignal(false);
  const revoke = useAction((tokenId: string) => command("token.revoke", { workspaceId: place.id(), tokenId }));
  const columns: DataTableColumn<ApiToken>[] = [
    { accessorKey: "name", header: t("field.name"), meta: { mobile: "title" }, cell: (ctx) => <span class="flex min-w-0 flex-col"><span class="truncate font-medium text-ink-gray-9">{ctx.row.original.name}</span><Show when={ctx.row.original.createdByName}>{(by) => <span class="truncate text-ink-gray-7">{t("tokens.by", { name: by() })}</span>}</Show></span> },
    { accessorKey: "role", header: t("people.role"), meta: { mobile: "meta" }, cell: (ctx) => <span class="text-ink-gray-7">{t(`role.${ctx.row.original.role}`)}</span> },
    { accessorKey: "expiresAt", header: t("tokens.state"), meta: { mobile: "subtitle" }, cell: (ctx) => <span class="text-ink-gray-7">{standing(ctx.row.original)}</span> },
    { id: "actions", header: "", enableSorting: false, meta: { align: "end" }, cell: (ctx) => <Show when={holds(ctx.row.original)}><ConfirmButton label={t("tokens.revoke")} confirm={t("tokens.revoke.confirm", { name: ctx.row.original.name })} busy={revoke.busy()} onConfirm={() => void revoke.run(ctx.row.original.id)} /></Show> },
  ];
  return (
    <Section title={t("tokens.title")} description={t("tokens.aside")} headingLevel={2} actions={<Button variant="outline" size="md" iconLeft="lucide-plus" onClick={() => setAdding(true)}>{t("tokens.new")}</Button>}>
      <Ready shape="table" data={tokens.data()} error={tokens.error()} retry={tokens.refetch}>
        {(loaded) => (
          <div class="flex flex-col gap-3">
            <Show when={loaded().tokens.length > 0} fallback={<EmptyState size="sm" bordered icon="lucide-plug" title={t("tokens.none")} description={t("tokens.none.text")} />}>
              <Table title={t("tokens.title")} rows={[...loaded().tokens]} columns={columns} count={tn("table.tokens", loaded().tokens.length)} />
            </Show>
            <Failure error={revoke.error()} />
          </div>
        )}
      </Ready>
      <NewToken open={adding()} onOpenChange={setAdding} />
    </Section>
  );
}
